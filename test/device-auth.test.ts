import { expect, test } from "bun:test";
import type { Fetch } from "../src/auth.js";
import {
  DeviceAuth,
  type DeviceAuthSession,
  type DeviceAuthStore,
  waitForDeviceLogin,
} from "../src/device-auth.js";
import type { CodexTokens } from "../src/token-store.js";

function fixture(responses: Response[]) {
  let now = Date.now();
  let session: DeviceAuthSession | undefined;
  let tokens: CodexTokens = {
    accessToken: "existing",
    refreshToken: "existing-refresh",
  };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const store: DeviceAuthStore = {
    loadSession: async () => structuredClone(session),
    saveSession: async (next) => {
      session = structuredClone(next);
    },
    complete: async (next) => {
      tokens = next;
      session = { status: "authenticated" };
    },
  };
  const upstream: Fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected upstream request");
    }
    return response;
  };
  const create = () => new DeviceAuth(store, upstream, () => now);
  return {
    auth: create(),
    create,
    calls,
    tokens: () => tokens,
    session: () => session,
    advance: (ms = 5000) => {
      now += ms;
    },
  };
}

const start = () =>
  Response.json({
    device_auth_id: "private-device",
    user_code: "ABCD-EFGH",
    interval: "5",
  });
const approval = () =>
  Response.json({
    authorization_code: "private-code",
    code_verifier: "private-verifier",
  });
const accessToken = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } })).toString("base64url")}.signature`;

test("device login resumes, throttles polls, exchanges once and never returns credentials", async () => {
  const f = fixture([
    start(),
    new Response(null, { status: 403 }),
    approval(),
    Response.json({
      access_token: accessToken,
      refresh_token: "new-refresh",
      id_token: "new-id",
    }),
  ]);
  const initial = await f.auth.start();
  expect(initial).toMatchObject({
    status: "pending",
    userCode: "ABCD-EFGH",
    retryAfterSeconds: 5,
  });
  const resumed = f.create();
  expect(await resumed.start()).toEqual(initial);
  expect(await resumed.poll()).toEqual(initial);
  expect(f.calls).toHaveLength(1);
  f.advance();
  expect((await resumed.poll()).status).toBe("pending");
  expect(f.tokens().accessToken).toBe("existing");
  f.advance();
  expect(await resumed.poll()).toEqual({ status: "authenticated" });
  expect(await resumed.poll()).toEqual({ status: "authenticated" });
  expect(f.calls).toHaveLength(4);
  expect(f.calls.every((call) => call.init?.redirect === "manual")).toBe(true);
  expect(f.calls.map((call) => call.url)).toEqual([
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ]);
  expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({
    device_auth_id: "private-device",
    user_code: "ABCD-EFGH",
  });
  expect(
    Object.fromEntries(new URLSearchParams(String(f.calls[3]?.init?.body))),
  ).toEqual({
    grant_type: "authorization_code",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    code: "private-code",
    code_verifier: "private-verifier",
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
  });
  expect(f.tokens()).toMatchObject({
    accessToken,
    refreshToken: "new-refresh",
    accountId: "account-1",
    idToken: "new-id",
  });
  expect(f.session()).toEqual({ status: "authenticated" });
  expect(JSON.stringify(initial)).not.toContain("private-device");
});

test("device auth refuses upstream redirects without exposing their destination", async () => {
  const f = fixture([
    new Response(null, {
      status: 302,
      headers: { location: "https://example.com/private" },
    }),
  ]);
  await expect(f.auth.start()).rejects.toThrow(
    "Device authorization could not be started (HTTP 302)",
  );
  expect(f.tokens().accessToken).toBe("existing");
});

test("slow_down persists increased interval across restarts and expires without polling", async () => {
  const f = fixture([
    start(),
    Response.json({ error: "slow_down" }, { status: 400 }),
  ]);
  await f.auth.start();
  f.advance();
  expect(await f.auth.poll()).toMatchObject({
    status: "pending",
    retryAfterSeconds: 10,
  });
  f.advance();
  expect(await f.create().poll()).toMatchObject({
    status: "pending",
    retryAfterSeconds: 5,
  });
  expect(f.calls).toHaveLength(2);
  f.advance(15 * 60_000);
  expect(await f.auth.poll()).toEqual({ status: "expired" });
  expect(f.calls).toHaveLength(2);
  expect(f.session()).toEqual({ status: "expired" });
  expect(f.tokens().accessToken).toBe("existing");
});

test.each([
  Response.json({ access_token: "not-a-jwt", refresh_token: "secret" }),
  Response.json({ access_token: accessToken }),
  Response.json({ error: "secret-upstream-body" }, { status: 400 }),
])(
  "invalid exchanges preserve existing login and cannot replay approval",
  async (invalid) => {
    const f = fixture([start(), approval(), invalid]);
    await f.auth.start();
    f.advance();
    expect(await f.auth.poll()).toEqual({ status: "failed" });
    expect(await f.create().poll()).toEqual({ status: "failed" });
    expect(f.calls).toHaveLength(3);
    expect(f.tokens().accessToken).toBe("existing");
  },
);

test("lost token response requires a new code and keeps previous credentials", async () => {
  const f = fixture([start(), approval()]);
  await f.auth.start();
  f.advance();
  await expect(f.auth.poll()).rejects.toThrow("Unexpected upstream request");
  expect(await f.create().poll()).toEqual({ status: "failed" });
  expect(f.tokens().accessToken).toBe("existing");
});

test.each([undefined, "nonsense", "", -1, "1e309"])(
  "invalid or absent poll interval uses five seconds: %s",
  async (interval) => {
    const f = fixture([
      Response.json({ device_auth_id: "device", user_code: "code", interval }),
    ]);
    expect(await f.auth.start()).toMatchObject({ retryAfterSeconds: 5 });
  },
);

test("transient and pending replies do not replace tokens or leak upstream errors", async () => {
  const f = fixture([
    start(),
    new Response("secret-upstream-body", { status: 503 }),
    Response.json(
      { error: { code: "deviceauth_authorization_pending" } },
      { status: 400 },
    ),
    Response.json({ error: "access_denied" }, { status: 400 }),
  ]);
  await f.auth.start();
  f.advance();
  expect((await f.auth.poll()).status).toBe("pending");
  f.advance();
  expect((await f.auth.poll()).status).toBe("pending");
  f.advance();
  expect(await f.auth.poll()).toEqual({ status: "failed" });
  expect(f.tokens().accessToken).toBe("existing");
});

test("blocking login cancels promptly while waiting and never polls after cancellation", async () => {
  const f = fixture([start()]);
  const abort = new AbortController();
  const login = waitForDeviceLogin(f.auth, () => abort.abort(), abort.signal);
  await expect(login).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.tokens().accessToken).toBe("existing");
});
