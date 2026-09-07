import { accessTokenExpiresAt } from "../src/auth.js";
import { AuthenticationError } from "../src/errors.js";
import type { CodexTokens, TokenStore } from "../src/token-store.js";

export class KvTokenStore implements TokenStore {
  constructor(private readonly storage: KVNamespace) {}

  async configured(): Promise<boolean> {
    return (await this.storage.get("tokens")) !== null;
  }

  async load(): Promise<CodexTokens> {
    const tokens = await this.storage.get<CodexTokens>("tokens", "json");
    if (!tokens) throw new AuthenticationError("Run mise run worker:auth or seed /admin/tokens");
    const expiresAt = accessTokenExpiresAt(tokens.accessToken);
    if (expiresAt && expiresAt.getTime() <= Date.now())
      throw new AuthenticationError("Worker credentials expired; run mise run worker:auth again");
    // KV cannot coordinate rotating refresh tokens across Worker instances.
    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  async save(tokens: CodexTokens, previous?: CodexTokens): Promise<void> {
    if (previous)
      throw new AuthenticationError("Refresh credentials locally and reseed the Worker");
    await this.storage.put("tokens", JSON.stringify(tokens));
  }
}
