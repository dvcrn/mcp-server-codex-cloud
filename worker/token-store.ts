import { AuthenticationError } from "../src/errors.js";
import type { CodexTokens, TokenStore } from "../src/token-store.js";

export class DurableTokenStore implements TokenStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async load(): Promise<CodexTokens> {
    const tokens = await this.storage.get<CodexTokens>("tokens");
    if (!tokens)
      throw new AuthenticationError("Sign in through /admin/auth/start or seed /admin/tokens");
    return tokens;
  }

  async save(tokens: CodexTokens, previous?: CodexTokens): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<CodexTokens>("tokens");
      if (
        previous &&
        (current?.accessToken !== previous.accessToken ||
          current?.refreshToken !== previous.refreshToken)
      ) {
        throw new AuthenticationError("Credentials changed during refresh; retry the request");
      }
      await transaction.put("tokens", tokens);
    });
  }
}
