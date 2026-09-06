import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthController, accessTokenExpiresAt } from "../src/auth.js";
import { CodexAuthFileTokenStore, MemoryTokenStore } from "../src/token-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AuthController", () => {
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
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
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

    expect((await auth.tokens()).accessToken).toBe((await store.load()).accessToken);
  });
});

test("accessTokenExpiresAt reads a JWT exp claim", () => {
  expect(accessTokenExpiresAt(jwt({ exp: 2 }))?.toISOString()).toBe("1970-01-01T00:00:02.000Z");
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

  await store.save({ accessToken: "new", accountId: "account", refreshToken: "refresh" });

  const saved = JSON.parse(await readFile(authFile, "utf8"));
  expect(saved).toMatchObject({
    auth_mode: "chatgpt",
    other: true,
    tokens: { access_token: "new", account_id: "account", refresh_token: "refresh" },
  });
  expect((await stat(authFile)).mode & 0o777).toBe(0o600);
});

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("invalid refresh payload cannot replace stored credentials", async () => {
  const tokens = { accessToken: "old", refreshToken: "refresh" };
  const store = new MemoryTokenStore(tokens);
  const auth = new AuthController({ tokenStore: store, fetch: async () => Response.json({}) });
  await expect(auth.refresh()).rejects.toThrow("did not include an access token");
  expect(await store.load()).toEqual(tokens);
});
