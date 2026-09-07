import { expect, test } from "bun:test";
import { once } from "node:events";
import { createEgressServer } from "./server.mjs";

test("private egress restricts destinations and strips unrelated headers", async () => {
  const calls = [];
  const server = createEgressServer(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ ok: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of [
      "/https://evil.example",
      "/oauth/other",
      "/backend-api/wham/../../anything",
    ]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
    const response = await fetch(`${base}/backend-api/wham/tasks/list?limit=1`, {
      headers: {
        authorization: "Bearer test",
        cookie: "unrelated",
        "x-admin-token": "not-forwarded",
      },
    });
    expect(response.status).toBe(200);
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/tasks/list?limit=1");
    expect(calls[0].init.headers.get("authorization")).toBe("Bearer test");
    expect(calls[0].init.headers.has("cookie")).toBe(false);
    expect(calls[0].init.headers.has("x-admin-token")).toBe(false);
    expect(calls[0].init.redirect).toBe("manual");
    await fetch(`${base}/oauth/token`, { method: "POST", body: "refresh" });
    expect(calls[1].url).toBe("https://auth.openai.com/oauth/token");
    expect(
      (await fetch(`${base}/oauth/token`, { method: "POST", body: "x".repeat(1048577) })).status,
    ).toBe(413);
    expect(calls).toHaveLength(2);
    for (const path of ["/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token"]) {
      expect((await fetch(base + path)).status).toBe(404);
      expect((await fetch(base + path, { method: "POST", body: "{}" })).status).toBe(200);
      expect(calls.at(-1).url).toBe(`https://auth.openai.com${path}`);
    }
    expect(calls).toHaveLength(4);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
