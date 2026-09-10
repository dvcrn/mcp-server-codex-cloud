import { AuthenticationError, TokenRefreshError } from "./errors.js";
import { cause, compactTokens, discardBody, jwtPayload } from "./internal.js";
import type { CodexTokens, TokenStore } from "./token-store.js";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthControllerOptions {
  tokenStore: TokenStore;
  fetch: Fetch;
  refreshUrl?: string;
  oauthClientId?: string;
  refreshWindowMs?: number;
}

const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class AuthController {
  readonly #store: TokenStore;
  readonly #fetch: Fetch;
  readonly #refreshUrl: string;
  readonly #oauthClientId: string;
  readonly #refreshWindowMs: number;
  #refreshing: Promise<CodexTokens> | undefined;

  public constructor(options: AuthControllerOptions) {
    this.#store = options.tokenStore;
    this.#fetch = options.fetch;
    this.#refreshUrl = options.refreshUrl ?? DEFAULT_REFRESH_URL;
    this.#oauthClientId = options.oauthClientId ?? DEFAULT_CLIENT_ID;
    this.#refreshWindowMs =
      options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  }

  public async tokens(): Promise<CodexTokens> {
    const tokens = await this.#store.load();
    return shouldRefresh(tokens, this.#refreshWindowMs) && tokens.refreshToken
      ? this.refresh()
      : tokens;
  }

  public async refresh(): Promise<CodexTokens> {
    if (!this.#refreshing) {
      this.#refreshing = this.#performRefresh().finally(() => {
        this.#refreshing = undefined;
      });
    }
    return this.#refreshing;
  }

  async #performRefresh(): Promise<CodexTokens> {
    const current = await this.#store.load();
    if (!current.refreshToken) {
      throw new AuthenticationError(
        "The access token cannot be refreshed without a refresh token",
      );
    }

    let response: Response;
    try {
      response = await this.#fetch(this.#refreshUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.#oauthClientId,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
        }),
      });
    } catch (error) {
      throw new TokenRefreshError(
        `Token refresh request failed: ${cause(error)}`,
      );
    }

    if (!response.ok) {
      await discardBody(response);
      throw new TokenRefreshError(
        `Token refresh failed with HTTP ${response.status}`,
        response.status,
      );
    }

    let payload: RefreshResponse;
    try {
      payload = refreshResponse(await response.json());
    } catch {
      throw new TokenRefreshError("Token refresh response was invalid");
    }
    const accessToken = payload.access_token;
    if (!accessToken) {
      throw new TokenRefreshError(
        "Token refresh response did not include an access token",
      );
    }

    const refreshed = compactTokens({
      accessToken,
      accountId: current.accountId,
      refreshToken: payload.refresh_token ?? current.refreshToken,
      idToken: payload.id_token ?? current.idToken,
      lastRefresh: new Date().toISOString(),
    });
    await this.#store.save(refreshed, current);
    return refreshed;
  }
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
}

function refreshResponse(value: unknown): RefreshResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  const source = value as Record<string, unknown>;
  const response: RefreshResponse = {};
  for (const key of ["access_token", "refresh_token", "id_token"] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "string") {
        throw new TypeError(`Expected ${key} to be a string`);
      }
      response[key] = source[key];
    }
  }
  return response;
}

export function accessTokenExpiresAt(accessToken: string): Date | undefined {
  const exp = jwtPayload(accessToken)?.exp;
  return typeof exp === "number" ? new Date(exp * 1000) : undefined;
}

function shouldRefresh(tokens: CodexTokens, refreshWindowMs: number): boolean {
  const expiresAt = accessTokenExpiresAt(tokens.accessToken);
  if (expiresAt) {
    return expiresAt.getTime() <= Date.now() + refreshWindowMs;
  }
  if (!tokens.lastRefresh) {
    return false;
  }
  return Date.parse(tokens.lastRefresh) <= Date.now() - 8 * 24 * 60 * 60 * 1000;
}
