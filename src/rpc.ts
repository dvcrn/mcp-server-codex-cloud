import type { AuthController } from "./auth.js";
import type { RequestOptions, RpcNotification } from "./cloud-types.js";
import { AuthenticationError, CodexCloudError, RpcError } from "./errors.js";

export interface CloudSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

export type SocketFactory = (
  url: string,
  protocols: string[],
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<CloudSocket>;

export interface RpcClientOptions {
  auth: AuthController;
  url: string;
  socketFactory: SocketFactory;
  timeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class RpcClient {
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: RpcNotification) => void>();
  #socket: CloudSocket | undefined;
  #connecting: Promise<void> | undefined;
  #id = 0;
  #closed = false;
  readonly #lifetime = new AbortController();

  public constructor(private readonly options: RpcClientOptions) {}

  /** Sends an authenticated app-server request without replaying ambiguous mutations. */
  public async request<T>(
    method: string,
    params: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    await cancellable(this.#connect(), signal);
    return this.#send<T>(method, params, signal);
  }

  /** Observes notifications, which can include events from other account threads. */
  public subscribe(listener: (event: RpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Closes the connection and rejects outstanding requests. */
  public close(): void {
    this.#closed = true;
    this.#lifetime.abort(new CodexCloudError("Codex Cloud client is closed"));
    this.#socket?.close();
    this.#disconnect();
    this.#listeners.clear();
  }

  async #connect(): Promise<void> {
    if (this.#closed) {
      throw new CodexCloudError("Codex Cloud client is closed");
    }
    if (this.#connecting) {
      return this.#connecting;
    }
    if (this.#socket) {
      return;
    }
    if (!this.#connecting) {
      this.#connecting = this.#open().finally(() => {
        this.#connecting = undefined;
      });
    }
    return this.#connecting;
  }

  async #open(): Promise<void> {
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    ]);
    let tokens = await cancellable(this.options.auth.tokens(), signal);
    const headers: Record<string, string> = { "X-OpenAI-Product-Sku": "codex" };
    if (tokens.accountId) {
      headers["ChatGPT-Account-ID"] = tokens.accountId;
    }
    const open = () =>
      this.options.socketFactory(
        this.options.url,
        [
          "codex-app-server",
          "codex-client.desktop",
          `openai-bearer.${tokens.accessToken}`,
        ],
        headers,
        signal,
      );
    let socket: CloudSocket;
    try {
      socket = await open();
    } catch (error) {
      if (!(error instanceof AuthenticationError) || !tokens.refreshToken) {
        throw error;
      }
      tokens = await cancellable(this.options.auth.refresh(), signal);
      if (tokens.accountId) {
        headers["ChatGPT-Account-ID"] = tokens.accountId;
      }
      socket = await open();
    }
    if (this.#closed) {
      socket.close();
      throw new CodexCloudError("Codex Cloud client is closed");
    }
    this.#socket = socket;
    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        this.#disconnect();
      }
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket) {
        socket.close();
        this.#disconnect();
      }
    });
    socket.addEventListener("message", (event) => this.#receive(event.data));
    try {
      await this.#send(
        "initialize",
        {
          clientInfo: { name: "mcp_server_codex_cloud", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        },
        signal,
      );
      socket.send(JSON.stringify({ method: "initialized" }));
    } catch (error) {
      socket.close();
      this.#disconnect();
      throw error;
    }
  }

  #send<T>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id);
        reject(signal.reason);
      };
      this.#pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!this.#socket) {
          throw new CodexCloudError(
            "Cloud socket disconnected; mutation outcome may be unknown",
          );
        }
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.get(id)?.reject(error);
        this.#pending.delete(id);
      }
    });
  }

  #receive(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.error) {
        const error = message.error as {
          code?: number;
          message?: string;
          data?: unknown;
        };
        pending.reject(new RpcError(error.code, error.message, error.data));
      } else {
        pending.resolve(message.result);
      }
    } else if (typeof message.method === "string") {
      // Server requests require an explicit decision; never silently approve them.
      const event: RpcNotification = {
        method: message.method,
        params: {
          ...(message.params as Record<string, unknown> | undefined),
          ...(message.id === undefined ? {} : { requestId: message.id }),
        },
      };
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          /* Observers cannot interrupt RPC delivery. */
        }
      }
    }
  }

  #disconnect(): void {
    this.#socket = undefined;
    for (const pending of this.#pending.values()) {
      pending.reject(
        new CodexCloudError(
          "Cloud socket disconnected; mutation outcome may be unknown. Read thread history before retrying.",
        ),
      );
    }
    this.#pending.clear();
  }
}

function cancellable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
