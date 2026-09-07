# mcp-server-codex-cloud

An MCP server for running Codex Cloud tasks from your MCP client. Start tasks,
follow up on results, inspect diffs and logs, and manage environments.
It uses an unofficial, undocumented API that may change.

## Run locally

Requires Node.js 20+ and a ChatGPT account with Codex access.

Sign in first:

```bash
npx -y mcp-server-codex-cloud auth
```

Open the verification URL, enter the device code, and approve access. The command
waits for approval, then saves OAuth credentials to
`~/.config/mcp-server-codex-cloud/auth.json` with owner-only permissions (`0600`).
Tokens refresh automatically. If prompted, enable device-code login in your
ChatGPT security settings.

Start the stdio server:

```bash
npx -y mcp-server-codex-cloud
```

Or add it to your MCP client's configuration:

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

Use `--auth-file /absolute/path/auth.json` on both commands to change the
credential location. Stop the server before signing in again.

The npm package is not published yet. Until publication, run from this checkout:

```bash
mise install
mise exec -- bun install --frozen-lockfile
mise run build
node dist/cli.js auth
node dist/cli.js
```

For an MCP client, use `node` as the command and the absolute path to `dist/cli.js`
as its argument.

## What it can do

| Capability | Tools |
| --- | --- |
| Find environments | `list_environments`, `get_environment`, `list_environments_by_repository` |
| Configure environments, scripts, variables, and secrets | `create_environment`, `update_environment` |
| Start tasks and read results or diffs | `start_task`, `list_tasks`, `get_task`, `wait_for_task` |
| Continue tasks and inspect conversation branches | `follow_up_task`, `list_task_turns`, `list_sibling_turns` |
| Read available per-turn logs, including setup output | `get_task_logs` |
| Refresh saved credentials manually | `refresh_auth` |

For example, ask your MCP client to “Find my repository's environment, start a
code review, wait for the result, then follow up asking for tests.” Task runs
consume your Codex account usage. Environment updates replace supplied scripts
and variable or secret maps. If a follow-up response is lost, check the turn
history before resubmitting.

## Deploy to Cloudflare

Deploy from a clone of this repository. You need mise, a Cloudflare account with
Containers support, and [Docker running locally](https://developers.cloudflare.com/containers/get-started/).
Container usage is billed separately.

1. Install dependencies and sign in to Cloudflare:

   ```bash
   mise install
   mise exec -- bun install --frozen-lockfile
   mise exec -- bun run wrangler login
   mise exec -- bun run wrangler whoami
   ```

2. Edit the included [wrangler.jsonc](./wrangler.jsonc): replace `account_id`
   with your account ID and choose your Worker `name`. Keep the Durable Object
   bindings, migrations, and container configuration. Wrangler provisions them
   on deployment; no KV namespace needs to be created.

3. Deploy, then set an `ADMIN_TOKEN` using a random secret of at least 32
   characters. Paste it at Wrangler's prompt and keep it in your secret manager:

   ```bash
   mise run worker:deploy
   mise exec -- bun run wrangler secret put ADMIN_TOKEN
   ```

4. Set `CODEX_WORKER_URL` in `mise.toml` to the HTTPS URL printed by deployment.
   In Bash or Zsh, run `read` below and paste the same admin token (input is hidden),
   then start the Worker's device login:

   ```bash
   read -r -s ADMIN_TOKEN
   export ADMIN_TOKEN
   mise exec -- bun scripts/auth-worker.ts
   unset ADMIN_TOKEN
   ```

   Open the printed URL and approve the code. The helper waits until credentials
   are saved in the Worker's Durable Object. They survive deployments and refresh
   automatically. Use a separate device login for the Worker; copying refresh
   tokens between independent clients can break token rotation. Initial container
   provisioning can take a few minutes; retry the helper if it is not ready.

5. Add a remote MCP server in your client with Streamable HTTP transport:

   ```text
   URL: https://<worker-name>.<subdomain>.workers.dev/mcp
   Header: Authorization: Bearer <ADMIN_TOKEN>
   ```

   The admin token grants access to the connected Codex account. Your MCP client
   must support sending an authorization header.

For your own auth UI, authenticated `POST /admin/auth/start` returns a
`verificationUrl` and `userCode`. Poll `POST /admin/auth/status` at the returned
`retryAfterSeconds` interval until `status` is `authenticated`, `expired`, or
`failed`. Tokens stay in the Worker.

## SDK and credential storage

The package also exports `CodexCloudClient`. Its credential abstraction is named
`TokenStore`: implement `load()` and `save(tokens, previous?)`, then pass it as
`new CodexCloudClient({ tokenStore })` to use a database or another secret store.
The CLI uses `CodexAuthFileTokenStore`; the Worker uses `DurableTokenStore`.

Persist rotated tokens atomically, reject stale writes, and coordinate refreshes
across clients sharing credentials. See [API.md](./API.md) for protocol details
and [src/token-store.ts](./src/token-store.ts) for the interface.
