import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthController, accessTokenExpiresAt } from "../src/auth.js";
import { fileDeviceAuth, waitForDeviceLogin } from "../src/device-auth.js";
import {
  CodexAuthFileTokenStore,
  MemoryTokenStore,
} from "../src/token-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AuthController", () => {
  test("releases failed refresh responses without replacing credentials", async () => {
    let canceled = false;
    const store = new MemoryTokenStore({
      accessToken: "old",
      refreshToken: "refresh",
    });
    const auth = new AuthController({
      tokenStore: store,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { status: 400 },
        ),
    });
    await expect(auth.refresh()).rejects.toThrow(
      "Token refresh failed with HTTP 400",
    );
    expect(canceled).toBe(true);
    expect(await store.load()).toEqual({
      accessToken: "old",
      refreshToken: "refresh",
    });
  });

  test("refreshes an expiring token and stores rotated credentials", async () => {
    const store = new MemoryTokenStore({
      accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 10 }),
      refreshToken: "old-refresh",
      accountId: "workspace-1",
    });
    const requestBodies: unknown[] = [];
    const auth = new AuthController({
      tokenStore: store,
      fetch: async (_input, init) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
      },
    });

    const tokens = await auth.tokens();

    expect(tokens).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountId: "workspace-1",
    });
    expect(await store.load()).toEqual(tokens);
    expect(requestBodies[0]).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
  });

  test("does not refresh a valid token", async () => {
    const store = new MemoryTokenStore({
      accessToken: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    });
    const auth = new AuthController({
      tokenStore: store,
      fetch: () => Promise.reject(new Error("unexpected request")),
    });

    expect((await auth.tokens()).accessToken).toBe(
      (await store.load()).accessToken,
    );
  });
});

test("accessTokenExpiresAt reads a JWT exp claim", () => {
  expect(accessTokenExpiresAt(jwt({ exp: 2 }))?.toISOString()).toBe(
    "1970-01-01T00:00:02.000Z",
  );
  expect(accessTokenExpiresAt("opaque")).toBeUndefined();
});

test("CodexAuthFileTokenStore preserves auth data and writes replacements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-sdk-"));
  temporaryDirectories.push(directory);
  const authFile = join(directory, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      other: true,
      tokens: { access_token: "old", account_id: "account" },
    }),
  );
  const store = new CodexAuthFileTokenStore({ authFile });

  await store.save({
    accessToken: "new",
    accountId: "account",
    refreshToken: "refresh",
  });

  const saved = JSON.parse(await readFile(authFile, "utf8"));
  expect(saved).toMatchObject({
    auth_mode: "chatgpt",
    other: true,
    tokens: {
      access_token: "new",
      account_id: "account",
      refresh_token: "refresh",
    },
  });
  expect((await stat(authFile)).mode & 0o777).toBe(0o600);
});

test("device login creates a private auth file and removes credentials from the previous login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-device-"));
  temporaryDirectories.push(directory);
  const authFile = join(directory, "config", "auth.json");
  const store = new CodexAuthFileTokenStore({ authFile });
  const responses = [
    Response.json({ device_auth_id: "device", user_code: "CODE", interval: 1 }),
    Response.json({ authorization_code: "code", code_verifier: "verifier" }),
    Response.json({
      access_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account" },
      }),
      refresh_token: "refresh",
      id_token: "id",
    }),
  ];
  const auth = fileDeviceAuth(store, async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected request");
    }
    return response;
  });
  const codes: string[] = [];
  await waitForDeviceLogin(
    auth,
    (status) => codes.push(status.userCode),
    new AbortController().signal,
  );
  expect(codes).toEqual(["CODE"]);
  expect(await store.load()).toMatchObject({
    accountId: "account",
    refreshToken: "refresh",
    idToken: "id",
  });
  expect((await stat(authFile)).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, "config"))).mode & 0o777).toBe(0o700);
  await store.save({ accessToken: "other", accountId: "other-account" });
  expect(await store.load()).not.toHaveProperty("idToken");
  expect(await store.load()).not.toHaveProperty("refreshToken");
});

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("invalid refresh payload cannot replace stored credentials", async () => {
  const tokens = { accessToken: "old", refreshToken: "refresh" };
  const store = new MemoryTokenStore(tokens);
  const auth = new AuthController({
    tokenStore: store,
    fetch: async () => Response.json({}),
  });
  await expect(auth.refresh()).rejects.toThrow(
    "did not include an access token",
  );
  expect(await store.load()).toEqual(tokens);
});

test("refresh save includes the credentials it replaces", async () => {
  const previous = { accessToken: "old", refreshToken: "refresh" };
  let expected: unknown;
  const auth = new AuthController({
    tokenStore: {
      load: async () => previous,
      save: async (_tokens, current) => {
        expected = current;
      },
    },
    fetch: async () => Response.json({ access_token: "new" }),
  });
  await auth.refresh();
  expect(expected).toEqual(previous);
});

test("a delayed file refresh cannot overwrite a completed device login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-file-race-"));
  temporaryDirectories.push(directory);
  const store = new CodexAuthFileTokenStore({
    authFile: join(directory, "auth.json"),
  });
  await store.save({ accessToken: "old", refreshToken: "old-refresh" });
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const auth = new AuthController({
    tokenStore: store,
    fetch: async () => {
      started.resolve();
      return response.promise;
    },
  });
  const refreshing = auth.refresh();
  await started.promise;
  const newLogin = {
    accessToken: "new-login",
    refreshToken: "new-login-refresh",
  };
  await new CodexAuthFileTokenStore({ authFile: store.authFile }).save(
    newLogin,
  );
  response.resolve(
    Response.json({
      access_token: "stale-refresh",
      refresh_token: "stale-rotated",
    }),
  );
  await expect(refreshing).rejects.toThrow(
    "Credentials changed during refresh",
  );
  expect(await store.load()).toMatchObject(newLogin);
});

test("file refresh writes compare credentials while holding the shared lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-file-lock-"));
  temporaryDirectories.push(directory);
  const authFile = join(directory, "auth.json");
  const a = new CodexAuthFileTokenStore({ authFile });
  const b = new CodexAuthFileTokenStore({ authFile });
  const old = { accessToken: "old", refreshToken: "old-refresh" };
  await a.save(old);
  const writes = await Promise.allSettled([
    a.save({ accessToken: "first", refreshToken: "first-refresh" }, old),
    b.save({ accessToken: "second", refreshToken: "second-refresh" }, old),
  ]);
  expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(writes.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
});
