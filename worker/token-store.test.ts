import { expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import { KvTokenStore } from "./token-store.js";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    get: async (key: string, type?: string) => {
      const value = values.get(key);
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
  return { store: new KvTokenStore(storage), values };
}

test("KV preserves seeded credentials but never exposes refresh tokens to automatic refresh", async () => {
  const { store, values } = fixture();
  const tokens = { accessToken: "access", refreshToken: "refresh", accountId: "owner" };
  expect(await store.configured()).toBe(false);
  await store.save(tokens);
  expect(JSON.parse(values.get("tokens") ?? "")).toEqual(tokens);
  expect(await store.configured()).toBe(true);
  expect(await store.load()).toEqual({ accessToken: "access", accountId: "owner" });
  await expect(store.save({ accessToken: "rotated" }, tokens)).rejects.toThrow("reseed");
  expect(JSON.parse(values.get("tokens") ?? "")).toEqual(tokens);
  const auth = new AuthController({
    tokenStore: store,
    fetch: async () => {
      throw new Error("Unexpected refresh request");
    },
  });
  await expect(auth.refresh()).rejects.toThrow("cannot be refreshed");
});

test("KV reports missing or expired access credentials without attempting refresh", async () => {
  const { store } = fixture();
  await expect(store.load()).rejects.toThrow("worker:auth");
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.sig`;
  await store.save({ accessToken: expired, refreshToken: "refresh" });
  await expect(store.load()).rejects.toThrow("expired");
});
