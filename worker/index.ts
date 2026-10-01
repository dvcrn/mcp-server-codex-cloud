import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Fetch } from "../src/auth.js";
import { CodexCloudClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp.js";
import { workerSocketFactory } from "./socket.js";
import { KvTokenStore } from "./token-store.js";

export interface Env {
  ADMIN_TOKEN: string;
  CODEX_AUTH: KVNamespace;
  CODEX_EGRESS: Fetcher;
}

const tokenSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  lastRefresh: z.iso.datetime({ offset: true }).optional(),
});

class CodexAccount {
  readonly #store: KvTokenStore;
  readonly #egress: Fetcher;

  constructor(env: Env) {
    this.#store = new KvTokenStore(env.CODEX_AUTH);
    this.#egress = env.CODEX_EGRESS;
  }

  async handle(request: Request): Promise<Response> {
    const client = new CodexCloudClient({
      tokenStore: this.#store,
      userAgent: "codex-cli",
      fetch: upstreamFetch(this.#egress),
      socketFactory: workerSocketFactory(this.#egress),
    });
    const handler = createMcpHandler(() => createMcpServer(client), {
      responseMode: "auto",
      maxSubscriptions: 0,
    });
    try {
      const response = await handler.fetch(request);
      const body = response.body ? await response.arrayBuffer() : null;
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      client.close();
      await handler.close();
    }
  }

  async seed(input: unknown): Promise<Response> {
    const parsed = tokenSchema.safeParse(input);
    if (!parsed.success) {
      return reply(
        "Expected accessToken and optional refreshToken, accountId, idToken, lastRefresh",
        400,
      );
    }
    await this.#store.save(parsed.data);
    return Response.json({ stored: true });
  }

  async status(): Promise<Response> {
    return Response.json({ configured: await this.#store.configured() });
  }
}

const upstreamFetch =
  (egress: Fetcher): Fetch =>
  (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:"
      || ![
        "codex-cloud-backend.chatgpt.com",
        "codex-cloud-environments.chatgpt.com",
        "auth.openai.com",
      ].includes(url.hostname)
    ) {
      throw new Error("Unsupported upstream");
    }
    return egress.fetch(
      new Request(request, {
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      }),
    );
  };

interface Route {
  /** Methods this route accepts, in the order advertised by `Allow`. */
  methods: string[];
  /** Maximum request body size in bytes; omit for routes that take no body. */
  bodyLimit?: number;
  /** Whether the body must be JSON. */
  json?: boolean;
  handle(context: RouteContext): Promise<Response>;
}

interface RouteContext {
  account: CodexAccount;
  request: Request;
  method: string;
  /** Present when the route declares a `bodyLimit`. */
  body: string;
}

const routes: Record<string, Route> = {
  "/admin/status": {
    methods: ["GET"],
    handle: ({ account }) => account.status(),
  },
  "/admin/tokens": {
    methods: ["POST"],
    bodyLimit: 65536,
    json: true,
    handle: ({ account, body }) => account.seed(JSON.parse(body)),
  },
  "/mcp": {
    methods: ["POST"],
    bodyLimit: 1048576,
    json: true,
    handle: ({ account, request, body }) => {
      // The admin credential authenticates the edge, never the MCP session.
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      return account.handle(
        new Request(request.url, { method: "POST", headers, body }),
      );
    },
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
      return reply("Server authentication is not configured", 503);
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!(await matches(authorization, `Bearer ${env.ADMIN_TOKEN}`))) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
      });
    }
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return reply("Origin is not allowed", 403);
    }

    const route = routes[url.pathname];
    if (!route) {
      return reply("Not found", 404);
    }
    if (!route.methods.includes(request.method)) {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          Allow: route.methods.join(", "),
          "Cache-Control": "no-store",
        },
      });
    }

    let body = "";
    if (route.bodyLimit !== undefined && request.method !== "GET") {
      if (route.json && !isJson(request)) {
        return reply("Expected application/json", 415);
      }
      const read = await limitedBody(request, route.bodyLimit);
      if (read === null) {
        return reply("Request body too large", 413);
      }
      body = read;
      if (route.json) {
        try {
          JSON.parse(body);
        } catch {
          return reply("Invalid JSON", 400);
        }
      }
    }

    try {
      const account = new CodexAccount(env);
      return secure(
        await route.handle({ account, request, method: request.method, body }),
      );
    } catch (error) {
      // Log for the operator; the response stays generic so upstream bodies,
      // which can echo environment secrets, never reach the client.
      console.error("Codex Cloud server request failed", error);
      return reply("Codex Cloud server request failed", 502);
    }
  },
} satisfies ExportedHandler<Env>;

function isJson(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json") ?? false
  );
}

function reply(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Compare credentials without leaking length or content through timing.
 * Digesting first gives both sides a fixed width, so the scan is constant-time.
 */
async function matches(actual: string, expected: string): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [left, right] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

async function limitedBody(
  request: Request,
  limit: number,
): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
