import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { Fetch } from "./auth.js";

/** Performs streaming HTTP requests through Node's native transport without following redirects. */
export const nodeFetch: Fetch = async (input, init) => {
  const request =
    input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
  const url = new URL(request.url);
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : request.signal);
  signal.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
      },
      (response) => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            headers.append(name, value);
          }
        }
        const status = response.statusCode ?? 502;
        const empty =
          request.method === "HEAD" || [204, 205, 304].includes(status);
        if (empty) {
          response.resume();
        }
        resolve(
          new Response(
            empty
              ? null
              : (Readable.toWeb(
                  response,
                ) as unknown as ReadableStream<Uint8Array>),
            { status, headers },
          ),
        );
      },
    );
    const abort = () => {
      upstream.destroy();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    upstream.once("close", () => signal.removeEventListener("abort", abort));
    upstream.on("error", reject);
    if (signal.aborted) {
      abort();
    } else {
      upstream.end(body);
    }
  });
};
