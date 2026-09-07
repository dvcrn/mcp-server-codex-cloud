import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Fetch } from "../src/auth.js";
import { CodexCloudClient } from "../src/client.js";
import { DeviceAuth, DeviceAuthError } from "../src/device-auth.js";
import { createMcpServer } from "../src/mcp.js";
import { DurableDeviceAuthStore } from "./device-auth-store.js";
import type { CodexEgress } from "./egress.js";

export { CodexEgress } from "./egress.js";

import { DurableTokenStore } from "./token-store.js";

export interface Env {
  ADMIN_TOKEN: string;
  CODEX_EGRESS: DurableObjectNamespace<CodexEgress>;
  CODEX_ACCOUNT: DurableObjectNamespace<CodexAccount>;
}

const tokenSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accountId: z.string().min(1).optional(),
  idToken: z.string().min(1).optional(),
  lastRefresh: z.iso.datetime({ offset: true }).optional(),
});

export class CodexAccount extends DurableObject<Env> {
  readonly #store = new DurableTokenStore(this.ctx.storage);
  readonly #fetch: Fetch = async (input, init) => {
    const upstream = new URL(String(input));
    if (upstream.hostname !== "chatgpt.com" && upstream.hostname !== "auth.openai.com")
      throw new Error("Unsupported upstream");
    const target = new URL(upstream.pathname + upstream.search, "http://container");
    return this.env.CODEX_EGRESS.getByName("owner").fetch(new Request(target, init));
  };
  readonly #client = new CodexCloudClient({
    tokenStore: this.#store,
    userAgent: "codex-cli",
    fetch: this.#fetch,
  });
  readonly #deviceAuth = new DeviceAuth(new DurableDeviceAuthStore(this.ctx.storage), this.#fetch);
  #active = 0;
  #seeding = false;

  async handle(request: Request): Promise<Response> {
    if (this.#seeding) return reply("Credentials are being updated", 409);
    this.#active++;
    const handler = createMcpHandler(() => createMcpServer(this.#client), {
      responseMode: "auto",
      maxSubscriptions: 0,
    });
    try {
      const response = await handler.fetch(request);
      // Consume the exchange before releasing the credential replacement guard.
      const body = response.body ? await response.arrayBuffer() : null;
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      try {
        await handler.close();
      } finally {
        this.#active--;
      }
    }
  }

  async seed(input: unknown): Promise<Response> {
    const parsed = tokenSchema.safeParse(input);
    if (!parsed.success)
      return reply(
        "Expected accessToken, refreshToken and optional accountId, idToken, lastRefresh",
        400,
      );
    // Replacing credentials during refresh would overwrite a newly seeded OAuth chain.
    if (this.#active || this.#seeding)
      return reply("Account is busy; retry seeding after requests complete", 409);
    this.#seeding = true;
    try {
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put("tokens", parsed.data);
        await transaction.delete("device-auth");
      });
      return Response.json({ stored: true });
    } finally {
      this.#seeding = false;
    }
  }

  async deviceAuth(action: "start" | "poll" | "status"): Promise<Response> {
    if (this.#active || this.#seeding) return reply("Account is busy; retry shortly", 409);
    this.#seeding = true;
    try {
      return Response.json(await this.#deviceAuth[action]());
    } catch (error) {
      if (error instanceof DeviceAuthError) return reply(error.message, 502);
      throw error;
    } finally {
      this.#seeding = false;
    }
  }

  async status(): Promise<Response> {
    return Response.json({ configured: (await this.ctx.storage.get("tokens")) !== undefined });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32)
      return reply("Server authentication is not configured", 503);
    const authorization = request.headers.get("authorization") ?? "";
    if (!(await matches(authorization, `Bearer ${env.ADMIN_TOKEN}`))) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
      });
    }
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return reply("Origin is not allowed", 403);
    const account = env.CODEX_ACCOUNT.getByName("owner");
    try {
      if (url.pathname === "/admin/status" && request.method === "GET")
        return secure(await account.status());
      if (url.pathname === "/admin/auth/start" || url.pathname === "/admin/auth/status") {
        if (url.pathname === "/admin/auth/status" && request.method === "GET")
          return secure(await account.deviceAuth("status"));
        if (request.method !== "POST")
          return new Response("Method not allowed", {
            status: 405,
            headers: {
              Allow: url.pathname.endsWith("status") ? "GET, POST" : "POST",
              "Cache-Control": "no-store",
            },
          });
        if ((await limitedBody(request, 1024)) === null)
          return reply("Request body too large", 413);
        return secure(await account.deviceAuth(url.pathname.endsWith("start") ? "start" : "poll"));
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/admin/tokens")
        return reply("Not found", 404);
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST", "Cache-Control": "no-store" },
        });
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return reply("Expected application/json", 415);
      const body = await limitedBody(request, url.pathname === "/admin/tokens" ? 65536 : 1048576);
      if (body === null) return reply("Request body too large", 413);
      if (url.pathname === "/admin/tokens") {
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          return reply("Invalid JSON", 400);
        }
        return secure(await account.seed(input));
      }
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      return secure(
        await account.handle(new Request(request.url, { method: "POST", headers, body })),
      );
    } catch {
      return reply("Codex Cloud server request failed", 502);
    }
  },
} satisfies ExportedHandler<Env>;

function reply(message: string, status: number): Response {
  return new Response(message, { status, headers: { "Cache-Control": "no-store" } });
}

function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

async function matches(actual: string, expected: string): Promise<boolean> {
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [left, right] = await Promise.all([digest(actual), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

async function limitedBody(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
