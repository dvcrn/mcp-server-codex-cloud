import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthenticationError } from "./errors.js";

export interface CodexTokens {
  accessToken: string;
  accountId?: string | undefined;
  refreshToken?: string | undefined;
  idToken?: string | undefined;
  lastRefresh?: string | undefined;
}

export interface TokenStore {
  load(): Promise<CodexTokens>;
  /** Atomically reject stale refresh writes when the store supports concurrent replacement. */
  save(tokens: CodexTokens, previous?: CodexTokens): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  #tokens: CodexTokens;

  public constructor(tokens: CodexTokens) {
    this.#tokens = { ...tokens };
  }

  public async load(): Promise<CodexTokens> {
    return { ...this.#tokens };
  }

  public async save(tokens: CodexTokens): Promise<void> {
    this.#tokens = { ...tokens };
  }
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    account_id?: string;
    refresh_token?: string;
    id_token?: string;
    [key: string]: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexAuthFileTokenStoreOptions {
  authFile?: string;
}

export class CodexAuthFileTokenStore implements TokenStore {
  public readonly authFile: string;

  public constructor(options: CodexAuthFileTokenStoreOptions = {}) {
    this.authFile = options.authFile ?? join(homedir(), ".codex", "auth.json");
  }

  public async load(): Promise<CodexTokens> {
    const auth = await this.#read();
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) {
      throw new AuthenticationError(`No ChatGPT access token found in ${this.authFile}`);
    }

    return compactTokens({
      accessToken,
      accountId: auth.tokens?.account_id,
      refreshToken: auth.tokens?.refresh_token,
      idToken: auth.tokens?.id_token,
      lastRefresh: auth.last_refresh,
    });
  }

  public async save(tokens: CodexTokens): Promise<void> {
    const auth = await this.#read();
    const existing = auth.tokens ?? {};
    auth.tokens = {
      ...existing,
      access_token: tokens.accessToken,
      ...(tokens.accountId === undefined ? {} : { account_id: tokens.accountId }),
      ...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
      ...(tokens.idToken === undefined ? {} : { id_token: tokens.idToken }),
    };
    auth.last_refresh = tokens.lastRefresh ?? new Date().toISOString();

    const directory = dirname(this.authFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.auth.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.authFile);
      await chmod(this.authFile, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AuthenticationError(
        `Could not persist refreshed Codex credentials: ${cause(error)}`,
      );
    }
  }

  async #read(): Promise<CodexAuthFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.authFile, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected an auth object");
      return value as CodexAuthFile;
    } catch (error) {
      throw new AuthenticationError(`Could not read Codex credentials: ${cause(error)}`);
    }
  }
}

function compactTokens(tokens: CodexTokens): CodexTokens {
  const compact: CodexTokens = { accessToken: tokens.accessToken };
  if (tokens.accountId !== undefined) compact.accountId = tokens.accountId;
  if (tokens.refreshToken !== undefined) compact.refreshToken = tokens.refreshToken;
  if (tokens.idToken !== undefined) compact.idToken = tokens.idToken;
  if (tokens.lastRefresh !== undefined) compact.lastRefresh = tokens.lastRefresh;
  return compact;
}

function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
