import { CodexCloudError } from "./errors.js";
import type { CodexTokens } from "./token-store.js";

/** Drop undefined-valued keys so results satisfy `exactOptionalPropertyTypes`. */
export function compactTokens(tokens: CodexTokens): CodexTokens {
  const compact: CodexTokens = { accessToken: tokens.accessToken };
  if (tokens.accountId !== undefined) compact.accountId = tokens.accountId;
  if (tokens.refreshToken !== undefined) compact.refreshToken = tokens.refreshToken;
  if (tokens.idToken !== undefined) compact.idToken = tokens.idToken;
  if (tokens.lastRefresh !== undefined) compact.lastRefresh = tokens.lastRefresh;
  return compact;
}

export function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decode a JWT payload without verifying its signature; callers only read non-authoritative claims. */
export function jwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function segment(value: string): string {
  if (!value.trim()) throw new CodexCloudError("Path identifiers must not be empty");
  return encodeURIComponent(value);
}

/** Release the connection when a response body will not be read. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Locked or failed streams may reject cancellation.
  }
}
