import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export function createEgressServer(upstreamFetch = fetch) {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://container");
      let target;
      if (
        [
          "/oauth/token",
          "/api/accounts/deviceauth/usercode",
          "/api/accounts/deviceauth/token",
        ].includes(path.pathname) &&
        request.method === "POST"
      ) {
        target = new URL(path.pathname, "https://auth.openai.com");
      } else if (
        path.pathname.startsWith("/backend-api/wham/") &&
        ["GET", "POST", "PATCH"].includes(request.method)
      ) {
        target = new URL("https://chatgpt.com");
        target.pathname = path.pathname;
        target.search = path.search;
      } else {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1048576) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const name of [
        "authorization",
        "chatgpt-account-id",
        "content-type",
        "user-agent",
        "accept",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await upstreamFetch(target, {
        method: request.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
      else response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createEgressServer().listen(8080, "0.0.0.0");
}
