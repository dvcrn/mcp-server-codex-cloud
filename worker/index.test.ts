import { expect, mock, test } from "bun:test";
import type { Fetch } from "../src/auth.js";
import worker, { type Env } from "./index.js";

function fixture(
  egressFetch: Fetch = async () =>
    new Response("Unexpected egress", { status: 500 }),
) {
  const values = new Map<string, string>();
  const env: Env = {
    ADMIN_TOKEN: "test-admin-token-with-at-least-32-characters",
    CODEX_AUTH: {
      get: async (key: string, type?: string) => {
        const value = values.get(key);
        return value === undefined
          ? null
          : type === "json"
            ? JSON.parse(value)
            : value;
      },
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    } as unknown as KVNamespace,
    CODEX_EGRESS: { fetch: egressFetch } as Fetcher,
  };
  const request = (path: string, body?: unknown) =>
    new Request(`https://worker.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${env.ADMIN_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { env, values, request };
}

test("Worker seeds KV credentials and enforces admin authentication", async () => {
  const { env, values, request } = fixture();
  expect(
    (await worker.fetch(new Request("https://worker.test/admin/status"), env))
      .status,
  ).toBe(401);
  expect(await (await worker.fetch(request("/admin/status"), env)).text()).toBe(
    '{"configured":false}',
  );
  expect((await worker.fetch(request("/admin/tokens", {}), env)).status).toBe(
    400,
  );
  expect(
    (
      await worker.fetch(
        request("/admin/tokens", { accessToken: "access" }),
        env,
      )
    ).status,
  ).toBe(200);
  expect(JSON.parse(values.get("tokens") ?? "")).toEqual({
    accessToken: "access",
  });
  expect(await (await worker.fetch(request("/admin/status"), env)).text()).toBe(
    '{"configured":true}',
  );
  expect(
    (await worker.fetch(request("/admin/auth/start", {}), env)).status,
  ).toBe(404);
});

test("MCP calls upstream through VPC egress and reports upstream rejection", async () => {
  const egressFetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = new Request(input, init);
      expect(new URL(forwarded.url).hostname).toBe(
        "codex-cloud-backend.chatgpt.com",
      );
      expect(forwarded.headers.get("authorization")).toBe("Bearer access");
      expect(forwarded.redirect).toBe("manual");
      return Response.json({ private: "upstream detail" }, { status: 403 });
    },
  );
  const { env, request } = fixture(egressFetch);
  await worker.fetch(
    request("/admin/tokens", {
      accessToken: "access",
      refreshToken: "refresh",
    }),
    env,
  );
  const response = await worker.fetch(
    request("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_tasks", arguments: { limit: 1 } },
    }),
    env,
  );
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("403");
  expect(body).not.toContain("upstream detail");
  expect(egressFetch).toHaveBeenCalledTimes(1);
});

test("Worker tools/list advertises task renaming and optional setup names", async () => {
  const { env, request } = fixture();
  const response = await worker.fetch(
    request("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const payload = JSON.parse(
    response.headers.get("content-type")?.includes("text/event-stream")
      ? (body
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6) ?? "{}")
      : body,
  );
  const tools = payload.result.tools;
  expect(
    tools.find((tool: { name: string }) => tool.name === "rename_task")
      ?.inputSchema.properties,
  ).toHaveProperty("name");
  expect(
    tools.find(
      (tool: { name: string }) => tool.name === "start_environment_setup",
    )?.inputSchema.properties,
  ).toHaveProperty("name");
});
