# mcp-server-codex-cloud

Experimental TypeScript SDK for the internal API used by `codex cloud`.

> This is based on reverse-engineered, undocumented endpoints. It is not an
> official OpenAI SDK, and the API may change without notice.

## MCP server

Build and run from this checkout:

```bash
mise install
mise exec -- bun install --frozen-lockfile
mise run build
node dist/cli.js
```

The server uses stdio and reads `~/.codex/auth.json`. Use `--auth-file PATH`
for a different Codex login. Keep stdout reserved for MCP messages.

After npm publication, configure an MCP client with:

```json
{
  "mcpServers": {
    "codex-cloud": {
      "command": "npx",
      "args": ["-y", "mcp-server-codex-cloud"]
    }
  }
}
```

Tools: `list_environments`, `get_environment`, `list_environments_by_repository`,
`create_environment`, `update_environment`, `list_tasks`, `start_task`, `get_task`,
`list_sibling_turns`, `wait_for_task`, and `refresh_auth`.

`update_environment` accepts setup and maintenance scripts, variables, secrets,
network settings, cache settings, and repository settings. Supplied scripts and
maps replace existing values. `refresh_auth` persists credentials without returning
them to the MCP client. Task creation consumes your Codex account usage.

## Requirements

- Node.js 20 or newer, or Bun
- A ChatGPT-backed Codex login or another Codex backend credential

Install from a local package or, once published:

```bash
bun add mcp-server-codex-cloud
```

## Initialize from Codex login

```ts
import { CodexCloudClient } from "mcp-server-codex-cloud";

const codex = await CodexCloudClient.fromCodexHome();
const environments = await codex.environments.list();
```

This reads `~/.codex/auth.json`. When the OAuth access token approaches expiry,
the SDK refreshes it and atomically writes rotated tokens back with mode `0600`.

## Initialize with a token store

Use a durable secret store for disposable or horizontally scaled machines:

```ts
import { CodexCloudClient, type CodexTokens, type TokenStore } from "mcp-server-codex-cloud";

const tokenStore: TokenStore = {
  async load(): Promise<CodexTokens> {
    return await secrets.get<CodexTokens>("codex-auth");
  },
  async save(tokens: CodexTokens): Promise<void> {
    await secrets.put("codex-auth", tokens);
  },
};

const codex = new CodexCloudClient({ tokenStore });
```

`save` must atomically persist a rotated refresh token. Coordinate refreshes so
multiple workers cannot use the same refresh token concurrently.

For one process and an already managed credential:

```ts
const codex = new CodexCloudClient({
  tokens: {
    accessToken: process.env.CODEX_ACCESS_TOKEN!,
    accountId: process.env.CHATGPT_ACCOUNT_ID,
  },
});
```

## Environments

```ts
const environments = await codex.environments.list();
const repositoryEnvironments = await codex.environments.listByRepository(
  "dvcrn",
  "fixmyenglish",
);

const environment = await codex.environments.create({
  label: "dummy-test",
  repositories: [CodexCloudClient.githubRepositoryId(1165432182)],
});

await codex.environments.update(environment.id, {
  environmentVariables: { FOO: "bar" },
  secrets: { FOO_SECRET: "secret" },
  setupScript: [
    'echo "setup starting"',
    'printf \'FOO=%s\\n\' "$FOO"',
    'test -n "$FOO_SECRET" && echo "FOO_SECRET is set"',
  ].join("\n"),
  networkAccess: "unrestricted",
  cache: { postSetupCacheEnabled: true },
});
```

Environment responses expose secret names only where the backend supplies them;
secret values are never returned by the SDK.

## Tasks

```ts
const created = await codex.tasks.create({
  environmentId: environment.id,
  branch: "main",
  prompt: "Count words in README.md. Do not modify files.",
});

console.log(created.url);

const result = await codex.tasks.waitFor(created.id, {
  intervalMs: 2_000,
  timeoutMs: 10 * 60_000,
});

console.log(result.status);
console.log(result.messages.join("\n"));
console.log(result.diff);
```

Task operations include:

- `tasks.list()`
- `tasks.create()`
- `tasks.get()`
- `tasks.listSiblingTurns()`
- `tasks.waitFor()`

## Development

Bun manages dependencies; mise runs project tasks:

```bash
bun install
mise run format
mise run check
mise run pack
```

See [API.md](./API.md) for SDK protocol details.

## Cloudflare Worker

The Worker exposes Streamable HTTP MCP at `/mcp`. Pass
`Authorization: Bearer <ADMIN_TOKEN>` on every request. This grants full access
to the configured Codex account, including task creation and environment changes.

Deploy from this checkout after configuring your account in `wrangler.jsonc`.
Docker must be running, and the account must support Cloudflare Containers.

```bash
mise run check
mise run worker:deploy
mise run worker:secret
mise run worker:seed
mise run worker:smoke:remote
```

`worker:secret` reads `ADMIN_TOKEN` from the production fnox profile and uploads it
as a Wrangler secret. `worker:seed` reads `CODEX_WORKER_URL` from `mise.toml` and
imports `~/.codex/auth.json`. Set `CODEX_AUTH_FILE` to use another login.
Use a dedicated Codex login for the Worker: independent local and remote clients
must not rotate copies of the same refresh token.

The admin token is encrypted in `fnox.toml`. Set `FNOX_AGE_KEY_FILE` to your age
identity when using this checkout on another machine. The deployment machine's
identity is stored outside the repository at
`~/.config/fnox/mcp-server-codex-cloud.age`.

Credential management endpoints also require the bearer token:

- `GET /admin/status` returns `{ "configured": true }` when credentials exist.
- `POST /admin/tokens` accepts `accessToken`, `refreshToken`, and optional
  `accountId`, `idToken`, `lastRefresh`. It replaces the stored login and never
  returns credentials. Retry a `409` after active requests finish.

Outbound Codex requests use a private Cloudflare Container because the shared
Worker egress address is rejected by ChatGPT. Deployment caps it at one `lite`
instance, which sleeps after 30 idle seconds. Container usage is billed separately.

Rotated credentials persist in the account's Durable Object. Deploying a new
Worker version preserves that storage. Initial login is imported from Codex;
the Worker handles subsequent OAuth refreshes.

For local Worker development, create an ignored `.dev.vars` containing a test
`ADMIN_TOKEN` of at least 32 characters, then run `mise run worker:dev`.
`mise run worker:smoke` uses the local test token shown in
`scripts/smoke-worker.ts`. It verifies authentication and MCP discovery without
calling Codex Cloud.
