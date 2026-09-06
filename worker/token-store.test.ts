import { expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import type { CodexTokens } from "../src/token-store.js";
import { DurableTokenStore } from "./token-store.js";

test("a delayed refresh cannot overwrite a newly seeded OAuth chain", async () => {
  const values = new Map<string, CodexTokens>();
  const transaction = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: CodexTokens) => {
      values.set(key, value);
    },
  };
  const storage = {
    ...transaction,
    transaction: async (run: (value: typeof transaction) => Promise<void>) => run(transaction),
  } as unknown as DurableObjectStorage;
  const store = new DurableTokenStore(storage);
  const old = { accessToken: "old", refreshToken: "old-refresh" };
  const seeded = { accessToken: "seeded", refreshToken: "seeded-refresh" };
  await store.save(old);
  const started = deferred<void>();
  const refreshed = deferred<Response>();
  const auth = new AuthController({
    tokenStore: store,
    fetch: async () => {
      started.resolve();
      return refreshed.promise;
    },
  });
  const operation = auth.refresh();
  await started.promise;
  await store.save(seeded);
  refreshed.resolve(Response.json({ access_token: "stale", refresh_token: "stale-refresh" }));
  await expect(operation).rejects.toThrow("Credentials changed during refresh");
  expect(await store.load()).toEqual(seeded);
  await store.save({ accessToken: "next", refreshToken: "next-refresh" }, seeded);
  expect((await store.load()).accessToken).toBe("next");
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
