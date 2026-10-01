import { expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import { RpcError } from "../src/errors.js";
import { RpcClient } from "../src/rpc.js";
import { MemoryTokenStore } from "../src/token-store.js";
import { FakeSocket } from "./fake-socket.js";

function auth() {
  return new AuthController({
    tokenStore: new MemoryTokenStore({
      accessToken: "private-token",
      accountId: "account",
    }),
    fetch,
  });
}

test("cloud socket authenticates and initializes once before concurrent requests", async () => {
  const init = Promise.withResolvers<void>();
  const socket = new FakeSocket(async (request, current) => {
    if (request.method === "initialize") {
      await init.promise;
    }
    if (request.id !== undefined) {
      current.reply(request, request.method);
    }
  });
  let count = 0;
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async (_url, protocols, headers) => {
      expect(protocols).toEqual([
        "codex-app-server",
        "codex-client.desktop",
        "openai-bearer.private-token",
      ]);
      expect(headers).toEqual({
        "ChatGPT-Account-ID": "account",
        "X-OpenAI-Product-Sku": "codex",
      });
      count++;
      return socket;
    },
  });
  try {
    const a = client.request("first", {});
    await new Promise((resolve) => setTimeout(resolve, 1));
    const b = client.request("second", {});
    expect(socket.sent.map((x) => x.method)).toEqual(["initialize"]);
    init.resolve();
    expect(await Promise.all([a, b])).toEqual(["first", "second"]);
    expect(count).toBe(1);
    expect(socket.sent.map((x) => x.method)).toEqual([
      "initialize",
      "initialized",
      "first",
      "second",
    ]);
  } finally {
    client.close();
  }
});

test("RPC correlates responses and withholds upstream errors from messages", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
    if (request.method === "mutation") {
      current.emit({ id: 999, result: "unrelated" });
      current.emit({
        id: request.id,
        error: {
          code: -32600,
          message: "secret echoed",
          data: { value: "secret" },
        },
      });
    }
  });
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async () => socket,
  });
  try {
    const error = await client.request("mutation", {}).catch((x) => x);
    expect(error).toBeInstanceOf(RpcError);
    if (!(error instanceof RpcError)) {
      throw new Error("Expected RPC error");
    }
    expect(error.message).not.toContain("secret");
    expect(error.detail).toBe("secret echoed");
    expect(socket.sent.filter((x) => x.method === "mutation")).toHaveLength(1);
  } finally {
    client.close();
  }
});

test("lost mutation response is never replayed and a later request reconnects", async () => {
  const sockets: FakeSocket[] = [];
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async () => {
      const socket = new FakeSocket((request, current) => {
        if (request.method === "initialize") {
          current.reply(request, {});
        }
        if (request.method === "mutation") {
          current.close();
        }
        if (request.method === "read") {
          current.reply(request, "ok");
        }
      });
      sockets.push(socket);
      return socket;
    },
  });
  try {
    await expect(client.request("mutation", {})).rejects.toThrow(
      "outcome may be unknown",
    );
    expect(await client.request<string>("read", {})).toBe("ok");
    expect(sockets).toHaveLength(2);
    expect(
      sockets.flatMap((x) => x.sent).filter((x) => x.method === "mutation"),
    ).toHaveLength(1);
  } finally {
    client.close();
  }
});

test("caller cancellation and request timeout settle even if server never responds", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.method === "initialize") {
      current.reply(request, {});
    }
  });
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    timeoutMs: 30,
    socketFactory: async () => socket,
  });
  try {
    const controller = new AbortController();
    const pending = client.request("hung", {}, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    await expect(client.request("hung", {})).rejects.toThrow();
  } finally {
    client.close();
  }
});

test("socket authentication rejection refreshes once before any RPC is sent", async () => {
  const { AuthenticationError } = await import("../src/errors.js");
  let refreshes = 0;
  const store = new MemoryTokenStore({
    accessToken: "old",
    refreshToken: "refresh",
  });
  const controller = new AuthController({
    tokenStore: store,
    fetch: async () => {
      refreshes++;
      return Response.json({ access_token: "new", refresh_token: "rotated" });
    },
  });
  const socket = new FakeSocket((request, current) => {
    if (request.id !== undefined) {
      current.reply(request, {});
    }
  });
  const protocolsSeen: string[][] = [];
  const client = new RpcClient({
    auth: controller,
    url: "wss://example.test/",
    socketFactory: async (_url, protocols) => {
      protocolsSeen.push(protocols);
      if (protocolsSeen.length === 1) {
        throw new AuthenticationError("Rejected");
      }
      return socket;
    },
  });
  try {
    await client.request("read", {});
    expect(refreshes).toBe(1);
    expect(protocolsSeen.map((x) => x.at(-1))).toEqual([
      "openai-bearer.old",
      "openai-bearer.new",
    ]);
    expect(socket.sent.filter((x) => x.method === "read")).toHaveLength(1);
    expect((await store.load()).refreshToken).toBe("rotated");
  } finally {
    client.close();
  }
});

test("malformed notification envelopes cannot crash RPC delivery", async () => {
  const socket = new FakeSocket((request, current) => {
    if (request.id !== undefined) {
      for (const invalid of [null, [], 1, "text"]) {
        current.emit(invalid);
      }
      current.reply(request, "ok");
    }
  });
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async () => socket,
  });
  try {
    expect(await client.request<string>("read", {})).toBe("ok");
  } finally {
    client.close();
  }
});

test("closing during a pending handshake aborts the factory and settles callers", async () => {
  const started = Promise.withResolvers<void>();
  let handshakeSignal: AbortSignal | undefined;
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async (_url, _protocols, _headers, signal) => {
      handshakeSignal = signal;
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const request = client.request("read", {});
  await started.promise;
  client.close();
  await expect(request).rejects.toThrow("closed");
  expect(handshakeSignal?.aborted).toBe(true);
});

test("closed and pre-aborted clients reject without starting connection work", async () => {
  let connections = 0;
  const client = new RpcClient({
    auth: auth(),
    url: "wss://example.test/",
    socketFactory: async () => {
      connections++;
      throw new Error("Factory should not run");
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled before connection"));
  await expect(
    client.request("read", {}, { signal: controller.signal }),
  ).rejects.toThrow("cancelled before connection");
  client.close();
  await expect(client.request("read", {})).rejects.toThrow("closed");
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(connections).toBe(0);
});
