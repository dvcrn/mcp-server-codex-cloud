import { describe, expect, test } from "bun:test";
import { AuthController } from "../src/auth.js";
import { ApiError } from "../src/errors.js";
import { HttpClient, normalizeBaseUrl } from "../src/http.js";
import { MemoryTokenStore } from "../src/token-store.js";

describe("HttpClient", () => {
  test("settles the response body when delivery races cancellation", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const client = makeClient(() => {
      started.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const request = client
      .request("/tasks/list", { signal: controller.signal })
      .catch(() => undefined);
    await started.promise;
    const response = Response.json({ items: [] });
    pending.resolve(response);
    queueMicrotask(() => controller.abort());
    await request;
    expect(response.bodyUsed).toBe(true);
  });

  test("releases a late response after cancellation of a transport that ignores abort", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const canceled = Promise.withResolvers<void>();
    const client = makeClient(() => {
      started.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const request = client.request("/tasks/list", {
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("caller canceled"));
    await expect(request).rejects.toThrow("caller canceled");
    pending.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            canceled.resolve();
          },
        }),
      ),
    );
    await canceled.promise;
  });

  test("uses WHAM routes and ChatGPT auth headers", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    const fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ items: [], cursor: null });
    };
    const client = makeClient(fetch);

    await client.request("/tasks/list", {
      query: { limit: 20, task_filter: "current", absent: undefined },
    });

    expect(capturedUrl).toBe(
      "https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current",
    );
    expect(capturedHeaders?.get("authorization")).toBe("Bearer access");
    expect(capturedHeaders?.get("chatgpt-account-id")).toBe("account");
  });

  test("requests and consumes event streams", async () => {
    let accept = "";
    const client = makeClient(async (_input, init) => {
      accept = new Headers(init?.headers).get("accept") ?? "";
      return new Response('data: {"type":"log"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });

    expect(
      await client.requestEventStream("/environments/test", {
        method: "POST",
        body: {},
      }),
    ).toBe('data: {"type":"log"}\n\n');
    expect(accept).toBe("text/event-stream");
  });

  test("refreshes and retries once after a 401", async () => {
    const seenTokens: string[] = [];
    const store = new MemoryTokenStore({
      accessToken: "old-access",
      refreshToken: "refresh",
      accountId: "account",
    });
    const fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input).includes("oauth/token")) {
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
      }
      seenTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return seenTokens.length === 1
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    };
    const auth = new AuthController({ tokenStore: store, fetch });
    const client = new HttpClient({ auth, fetch });

    expect(await client.request<{ ok: boolean }>("/test")).toEqual({
      ok: true,
    });
    expect(seenTokens).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect((await store.load()).refreshToken).toBe("new-refresh");
  });

  test("releases the discarded response body when retrying after a 401", async () => {
    let cancelled = false;
    let call = 0;
    const client = makeClient(async (url) => {
      if (String(url).includes("oauth/token")) {
        return Response.json({
          access_token: "new",
          refresh_token: "new-refresh",
        });
      }
      call++;
      if (call > 1) {
        return Response.json({ ok: true });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("unauthorized"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 401 },
      );
    }, "refresh");

    expect(await client.request<{ ok: boolean }>("/test")).toEqual({
      ok: true,
    });
    expect(cancelled).toBe(true);
  });

  test("does not expose a response body in API errors", async () => {
    const client = makeClient(async () =>
      Response.json(
        { error: { message: "secret value was invalid" } },
        { status: 400 },
      ),
    );

    const error = await client
      .request("/environments", { method: "PATCH" })
      .catch((value) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).not.toContain("secret value");
    // Detail stays available for diagnostics, just never via the message.
    expect((error as ApiError).detail).toContain("secret value");
    expect((error as ApiError).status).toBe(400);
  });
});

test("normalizeBaseUrl adds backend-api for ChatGPT hosts", () => {
  expect(normalizeBaseUrl("https://chatgpt.com/")).toBe(
    "https://chatgpt.com/backend-api",
  );
  expect(normalizeBaseUrl("https://example.test/")).toBe(
    "https://example.test",
  );
});

function makeClient(
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  refreshToken?: string,
): HttpClient {
  const auth = new AuthController({
    tokenStore: new MemoryTokenStore({
      accessToken: "access",
      accountId: "account",
      ...(refreshToken === undefined ? {} : { refreshToken }),
    }),
    fetch,
  });
  return new HttpClient({ auth, fetch });
}
