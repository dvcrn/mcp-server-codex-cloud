import type { AuthController, Fetch } from "./auth.js";
import { ApiError, AuthenticationError, CodexCloudError } from "./errors.js";
import { discardBody } from "./internal.js";

export interface HttpClientOptions {
  auth: AuthController;
  fetch: Fetch;
  baseUrl?: string;
  userAgent?: string;
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH";
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  signal?: AbortSignal | undefined;
}

export class HttpClient {
  public readonly baseUrl: string;
  readonly #auth: AuthController;
  readonly #fetch: Fetch;
  readonly #prefix: "/wham" | "/api/codex";
  readonly #userAgent: string;

  public constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://chatgpt.com/backend-api");
    this.#prefix = this.baseUrl.includes("/backend-api") ? "/wham" : "/api/codex";
    this.#auth = options.auth;
    this.#fetch = options.fetch;
    this.#userAgent = options.userAgent ?? "codex-typescript-sdk/0.0.0";
  }

  public async request<T>(path: `/${string}`, options: ApiRequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const url = this.#url(path, options.query);
    let tokens = await abortable(this.#auth.tokens(), options.signal);
    let response = await this.#send(url, method, tokens.accessToken, tokens.accountId, options);

    if (response.status === 401 && tokens.refreshToken) {
      // The retried response replaces this one, so release its body explicitly.
      await discardBody(response);
      tokens = await abortable(this.#auth.refresh(), options.signal);
      response = await this.#send(url, method, tokens.accessToken, tokens.accountId, options);
    }

    if (!response.ok) {
      const requestId =
        response.headers.get("x-request-id") ?? response.headers.get("cf-ray") ?? undefined;
      const detail = await errorDetail(response, options.signal);
      throw new ApiError(
        `${method} ${url} failed with HTTP ${response.status}`,
        response.status,
        method,
        url,
        requestId,
        detail,
      );
    }

    if (response.status === 204) return undefined as T;
    const text = await abortable(response.text(), options.signal);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CodexCloudError(`${method} ${url} returned invalid JSON`);
    }
  }

  async #send(
    url: string,
    method: string,
    accessToken: string,
    accountId: string | undefined,
    options: ApiRequestOptions,
  ): Promise<Response> {
    options.signal?.throwIfAborted();
    if (!accessToken) throw new AuthenticationError("A ChatGPT access token is required");
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": this.#userAgent,
    });
    if (accountId) headers.set("ChatGPT-Account-ID", accountId);
    if (options.body !== undefined) headers.set("content-type", "application/json");

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    return abortable(this.#fetch(url, init), options.signal, discardBody);
  }

  #url(path: `/${string}`, query?: ApiRequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${this.#prefix}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

export function normalizeBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new CodexCloudError("Codex Cloud base URL must use HTTPS");
  let pathname = url.pathname.replace(/\/+$/, "");
  if (
    (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
    !pathname.includes("/backend-api")
  ) {
    pathname += "/backend-api";
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

/**
 * Read an upstream error body for diagnostics.
 *
 * Kept off `error.message` deliberately: request bodies carry environment
 * secrets, and upstream echoes them back in validation errors. Callers that
 * need the detail read `ApiError.detail` and decide where it may surface.
 */
async function errorDetail(response: Response, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const text = (await abortable(response.text(), signal)).trim();
    return text ? text.slice(0, 500) : undefined;
  } catch {
    await discardBody(response);
    return undefined;
  }
}

// Caller cancellation must not interrupt a shared refresh before rotated tokens are persisted.
async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onDiscard?: (value: T) => Promise<void>,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      aborted = true;
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    operation
      .then(async (value) => {
        if (aborted) await onDiscard?.(value);
        else resolve(value);
      }, reject)
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
