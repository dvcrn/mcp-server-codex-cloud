import { AuthController, type Fetch } from "./auth.js";
import { EnvironmentsApi, githubRepositoryId } from "./environments.js";
import { CodexCloudError } from "./errors.js";
import { HttpClient } from "./http.js";
import { RpcClient, type SocketFactory } from "./rpc.js";
import { TasksApi } from "./tasks.js";
import {
  CodexAuthFileTokenStore,
  type CodexTokens,
  MemoryTokenStore,
  type TokenStore,
} from "./token-store.js";

export interface CodexCloudClientOptions {
  tokens?: CodexTokens;
  tokenStore?: TokenStore;
  baseUrl?: string;
  fetch?: Fetch;
  userAgent?: string;
  refreshUrl?: string;
  oauthClientId?: string;
  refreshWindowMs?: number;
  socketFactory?: SocketFactory;
  rpcTimeoutMs?: number;
}

export interface CodexHomeClientOptions
  extends Omit<CodexCloudClientOptions, "tokens" | "tokenStore"> {
  authFile?: string;
}

export class CodexCloudClient {
  public readonly environments: EnvironmentsApi;
  public readonly tasks: TasksApi;
  readonly #auth: AuthController;
  readonly #rpc: RpcClient;

  public constructor(options: CodexCloudClientOptions) {
    if (options.tokens !== undefined && options.tokenStore !== undefined) {
      throw new CodexCloudError("Provide exactly one of tokens or tokenStore");
    }
    let tokenStore: TokenStore;
    if (options.tokenStore) {
      tokenStore = options.tokenStore;
    } else if (options.tokens) {
      tokenStore = new MemoryTokenStore(options.tokens);
    } else {
      throw new CodexCloudError("Provide exactly one of tokens or tokenStore");
    }

    const fetch = options.fetch ?? defaultFetch();
    this.#auth = new AuthController({
      tokenStore,
      fetch,
      ...(options.refreshUrl === undefined
        ? {}
        : { refreshUrl: options.refreshUrl }),
      ...(options.oauthClientId === undefined
        ? {}
        : { oauthClientId: options.oauthClientId }),
      ...(options.refreshWindowMs === undefined
        ? {}
        : { refreshWindowMs: options.refreshWindowMs }),
    });
    const http = new HttpClient({
      auth: this.#auth,
      fetch,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.userAgent === undefined
        ? {}
        : { userAgent: options.userAgent }),
    });
    this.environments = new EnvironmentsApi(http);
    const socketUrl = new URL(http.baseUrl);
    socketUrl.protocol = "wss:";
    this.#rpc = new RpcClient({
      auth: this.#auth,
      url: socketUrl.toString(),
      socketFactory:
        options.socketFactory
        ?? (async (...args) => {
          const { nodeSocketFactory } = await import("./socket-node.js");
          return nodeSocketFactory(...args);
        }),
      ...(options.rpcTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.rpcTimeoutMs }),
    });
    this.tasks = new TasksApi(http, this.#rpc);
  }

  /** Loads credentials from the selected Codex auth file. */
  public static async fromCodexHome(
    options: CodexHomeClientOptions = {},
  ): Promise<CodexCloudClient> {
    const { authFile, ...clientOptions } = options;
    const tokenStore = new CodexAuthFileTokenStore(
      authFile === undefined ? {} : { authFile },
    );
    await tokenStore.load();
    return new CodexCloudClient({ ...clientOptions, tokenStore });
  }

  /** Formats a GitHub numeric repository ID for cloud configuration. */
  public static githubRepositoryId(id: number | string): `github-${string}` {
    return githubRepositoryId(id);
  }

  /** Refreshes OAuth credentials and persists rotated tokens. */
  public async refreshTokens(): Promise<CodexTokens> {
    return this.#auth.refresh();
  }
  /** Releases the cloud socket and rejects pending requests. */
  public close(): void {
    this.#rpc.close();
  }
}

function defaultFetch(): Fetch {
  return async (input, init) => {
    const { nodeFetch } = await import("./fetch-node.js");
    return nodeFetch(input, init);
  };
}
