# Codex Cloud remote API

This file records observed behavior of the internal API used by `codex cloud`.
It is reverse-engineered from the Codex CLI source, not a public API contract.
Endpoints and payloads may change without notice.

## Research snapshot

Findings below were verified against OpenAI Codex commit
[`ac192cd7937b0d73edc6dffe009940ae53782dd4`](https://github.com/openai/codex/commit/ac192cd7937b0d73edc6dffe009940ae53782dd4).

Primary sources requested for this first pass:

- [`cloud-tasks/src/lib.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/cloud-tasks/src/lib.rs)
- [`backend-client/src/client.rs` lines 379–424](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/backend-client/src/client.rs#L379-L424)

Supporting source followed from those files:

- [`cloud-tasks-client/src/http.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/cloud-tasks-client/src/http.rs)
- [`backend-client/src/types.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/backend-client/src/types.rs)
- [`cloud-tasks/src/env_detect.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/cloud-tasks/src/env_detect.rs)
- [`cloud-tasks/src/util.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/cloud-tasks/src/util.rs)
- [`protocol/src/auth.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/protocol/src/auth.rs#L40-L63)
- [`model-provider/src/bearer_auth_provider.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/model-provider/src/bearer_auth_provider.rs#L31-L46)
- [`login/src/auth/manager.rs`](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/login/src/auth/manager.rs#L1444-L1515)
- [`login/src/auth/manager.rs` token refresh implementation](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/login/src/auth/manager.rs#L1555-L1610)
- [Official Codex cloud environments documentation](https://developers.openai.com/codex/cloud/environments)

## Transport and routing

`codex cloud` defaults to this base URL:

```text
https://chatgpt.com/backend-api
```

It supports two route styles:

| Style | Detection | Task-list path |
|---|---|---|
| ChatGPT/WHAM | Base URL contains `/backend-api` | `/wham/tasks/list` |
| Codex API | Otherwise | `/api/codex/tasks/list` |

For the default base URL, the complete task-list URL is therefore:

```text
https://chatgpt.com/backend-api/wham/tasks/list
```

`chatgpt.com` and `chat.openai.com` base URLs are normalized by removing trailing
slashes and appending `/backend-api` when it is absent. The `codex cloud` command
also validates `CODEX_CLOUD_TASKS_BASE_URL` before loading credentials. At this
snapshot it permits HTTPS on port 443 for `chatgpt.com`, `chat.openai.com`, and
`chatgpt-staging.com`, with no user information, query, or fragment.

The HTTP clients used by Cloud Tasks disable redirects so credentials are not
forwarded to a redirect destination. The backend client also uses a transport
which handles ChatGPT Cloudflare cookies and disables request logging.

## Authentication and headers

`codex cloud` requires authentication created by `codex login` and rejects auth
which does not use the Codex backend.

### API keys versus ChatGPT access tokens

A normal OpenAI API key (for example an `sk-...` key saved by
`codex login --with-api-key`) is **not accepted by the `codex cloud` command**.
The source classifies API-key auth as direct model API auth, not Codex backend
auth, and `codex cloud` exits before making a request when
`uses_codex_backend()` is false. Cloud Tasks also initializes its auth manager
with `enable_codex_api_key_env: false`, so it does not opt into loading
`CODEX_API_KEY` from the environment.

The default cloud API requests instead use a ChatGPT OAuth access token:

```http
Authorization: Bearer CHATGPT_ACCESS_TOKEN
ChatGPT-Account-ID: CHATGPT_WORKSPACE_OR_ACCOUNT_ID
User-Agent: codex-cli/...
```

There is no observed `api-key` or `x-api-key` header. The account header is
added when the authenticated identity exposes an account/workspace ID; it is
important for selecting the active workspace. For programmatic Codex backend
auth, `CODEX_ACCESS_TOKEN` may contain a Codex personal access token or an agent
identity JWT. This is distinct from `OPENAI_API_KEY` and `CODEX_API_KEY`.
The generic auth layer also supports backend-bound header auth, but the
interactive `codex cloud` path explicitly tells users to sign in with ChatGPT.
Server-side acceptance of a standard OpenAI API key was not tested; the CLI
intentionally prevents that auth mode from reaching these endpoints.

### Reusing `~/.codex/auth.json`

Yes. When Codex uses file-backed ChatGPT login, `~/.codex/auth.json` contains a
structure like this (all values omitted):

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "..."
}
```

Use `tokens.access_token` as the bearer credential. Do not use `id_token` or
`refresh_token` as the API bearer token. Send `tokens.account_id` as
`ChatGPT-Account-ID` when targeting a particular workspace. The local file was
observed with mode `0600`; integrations should preserve that protection, avoid
putting tokens in process arguments or logs, and reread the file because Codex
may refresh and replace the stored tokens.

Live verification on `2026-09-06` against the default task-list endpoint:

| Credentials | Result |
|---|---|
| `access_token` plus `account_id` | `200 OK` |
| `access_token` without account header | `200 OK` for the tested account |
| `id_token` plus `account_id` | `401 Unauthorized` |
| No credentials | `401 Unauthorized` |

The successful response was JSON with top-level `items` and `cursor`. Omitting
the account header working for this account does not prove it is safe to omit
for multi-workspace users; the official client sends it whenever available.

A direct request can read the credentials without exposing them on the command
line:

```python
import json
import urllib.request
from pathlib import Path

auth = json.loads((Path.home() / ".codex" / "auth.json").read_text())
tokens = auth["tokens"]
request = urllib.request.Request(
    "https://chatgpt.com/backend-api/wham/tasks/list"
    "?limit=1&task_filter=current",
    headers={
        "Authorization": f"Bearer {tokens['access_token']}",
        "ChatGPT-Account-ID": tokens["account_id"],
        "User-Agent": "codex-cli",
        "Accept": "application/json",
    },
)
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.status)
    print(response.read().decode())
```

### Token lifetime and refresh

The value used above is an OAuth access token, not a permanent API key. The
locally observed JWT was issued at `2026-09-05T06:49:57Z` and expires at
`2026-09-15T06:49:57Z`: a ten-day lifetime (`exp - iat = 864000` seconds).
That is one observation, not a guaranteed service contract. A direct client
that only copies `tokens.access_token` will eventually receive
`401 Unauthorized` and cannot renew itself.

Codex proactively refreshes managed ChatGPT auth when the JWT is within five
minutes of expiry. If it cannot read a JWT expiry, it falls back to refreshing
after eight days from `last_refresh`. Refresh uses:

```http
POST https://auth.openai.com/oauth/token
Content-Type: application/json
```

```json
{
  "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "REFRESH_TOKEN"
}
```

The response may contain replacement `id_token`, `access_token`, and
`refresh_token` values. Codex persists every returned replacement and updates
`last_refresh`. `~/.codex/auth.json` does contain the current refresh token.
The source explicitly handles expired, reused, and invalidated refresh tokens,
so callers must assume refresh-token rotation and atomically store a replacement
refresh token whenever the response includes one.

A custom worker does not need the entire auth file. Its durable secret state can
be limited to the refresh token plus the ChatGPT account/workspace ID. At
runtime it exchanges the refresh token for an access token and retains any
rotated refresh token. Keeping only a fixed original refresh token is unsafe:
a successful rotation can make that original value unusable.

A stateless worker is practical in either of these forms:

1. Inject a currently valid access token and account ID for each run. The worker
   remains stateless, but an external system must rotate the access token before
   expiry.
2. Inject the complete auth state and let Codex refresh it, but persist the
   updated auth state back to a shared secret store atomically. This is not
   strictly stateless at the authentication layer.
3. Use a Codex backend personal access token or agent identity through
   `CODEX_ACCESS_TOKEN`, when such a credential is available. This is distinct
   from a standard OpenAI API key.

Do not give multiple disposable machines independent copies of the same refresh
token and allow them to refresh concurrently. One machine may rotate it while
another attempts to reuse the old value. A centralized token broker, a single
refreshing process, or a distributed lock plus atomic secret update is needed
for horizontal workers. Mounting a fixed `auth.json` into every machine works
only until refresh or revocation.

Observed request headers are assembled as follows:

- `User-Agent`: the Codex user agent, with a command-specific suffix such as
  `codex_cloud_tasks_exec`, `codex_cloud_tasks_list`, or
  `codex_cloud_tasks_tui`; the backend client's fallback is `codex-cli`.
- Authentication headers: supplied by Codex's shared auth provider. For ChatGPT
  token auth this includes `Authorization: Bearer …`.
- `ChatGPT-Account-Id`: supplied when the active ChatGPT workspace/account is
  available through the auth provider or explicitly configured on the client.
- `X-OpenAI-Fedramp: true`: supported by the generic backend client when
  FedRAMP routing is enabled; `cloud-tasks/src/lib.rs` does not explicitly turn
  this option on.

## Endpoint summary

Paths below show both supported route styles. The default ChatGPT deployment
uses the `/backend-api/wham/...` form.

| Method | ChatGPT/WHAM path | Codex API path | Purpose |
|---|---|---|---|
| `GET` | `/wham/environments` | `/api/codex/environments` | List environments |
| `POST` | `/wham/environments` | Presumed `/api/codex/environments`; not tested | Create an environment |
| `PATCH` | `/wham/environments/{environment_id}` | Presumed `/api/codex/environments/{environment_id}`; not tested | Partially update environment settings |
| `GET` | `/wham/environments/by-repo/{vcs}/{owner}/{repo}` | `/api/codex/environments/by-repo/{vcs}/{owner}/{repo}` | Find environments associated with a repository |
| `GET` | `/wham/tasks/list` | `/api/codex/tasks/list` | List tasks |
| `POST` | `/wham/tasks` | `/api/codex/tasks` | Create a task |
| `GET` | `/wham/tasks/{task_id}` | `/api/codex/tasks/{task_id}` | Get task metadata, turns, messages, and diff |
| `GET` | `/wham/tasks/{task_id}/turns/{turn_id}/sibling_turns` | `/api/codex/tasks/{task_id}/turns/{turn_id}/sibling_turns` | Get best-of-N sibling attempts |
| `GET` | `/wham/tasks/{task_id}/turns` | Not tested | Get turn history and parent/child relationships |
| `GET` | `/wham/tasks/{task_id}/turns/{turn_id}/logs` | Not tested | Get logs for a task turn |


### List tasks

```http
GET /backend-api/wham/tasks/list
```

Supported query parameters, in serialization order:

| Parameter | Type | `codex cloud` behavior |
|---|---|---|
| `limit` | integer | Optional at API level. CLI accepts 1–20 and defaults to 20. |
| `task_filter` | string | The Cloud Tasks adapter always sends `current`. |
| `cursor` | string | Omitted on the first page; pass the returned cursor for the next page. |
| `environment_id` | string | Optional environment filter. |

Example generated by the CLI adapter:

```text
GET https://chatgpt.com/backend-api/wham/tasks/list?limit=20&task_filter=current&cursor=CURSOR&environment_id=ENV_ID
```

The response model contains:

```json
{
  "items": [
    {
      "id": "TASK_ID",
      "title": "Task title",
      "updated_at": 0,
      "task_status_display": {},
      "pull_requests": []
    }
  ],
  "cursor": "NEXT_CURSOR_OR_NULL"
}
```

This is a partial shape containing fields consumed by `codex cloud`, not a
claim that other fields are absent. `updated_at` is treated as a Unix timestamp
and may be fractional. A non-empty `pull_requests` array marks a task as a code
review. The list adapter currently does not copy an environment ID from list
items, but it does read `task_status_display.environment_label`.

Status and summary fields consumed from `task_status_display` include:

```json
{
  "state": "pending | ready | applied | error",
  "environment_label": "Environment name",
  "latest_turn_status_display": {
    "turn_status": "pending | in_progress | completed | failed | cancelled",
    "created_at": 0,
    "updated_at": 0,
    "sibling_turn_ids": [],
    "diff_stats": {
      "files_modified": 0,
      "lines_added": 0,
      "lines_removed": 0
    }
  }
}
```

`latest_turn_status_display.turn_status` takes precedence over `state` when the
CLI derives its simplified `pending`, `ready`, or `error` status.

### Create a task

```http
POST /backend-api/wham/tasks
Content-Type: application/json
```

Normal single-attempt request body:

```json
{
  "new_task": {
    "environment_id": "ENV_ID",
    "branch": "GIT_REF",
    "run_environment_in_qa_mode": false
  },
  "input_items": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {
          "content_type": "text",
          "text": "PROMPT"
        }
      ]
    }
  ]
}
```

When `--attempts N` is greater than one, the top-level body additionally has:

```json
{
  "metadata": {
    "best_of_n": 2
  }
}
```

The CLI accepts 1–4 attempts. `metadata` is omitted for one attempt.

If the process has a non-empty `CODEX_STARTING_DIFF`, the client appends this
item to `input_items` after the user message:

```json
{
  "type": "pre_apply_patch",
  "output_diff": {
    "diff": "UNIFIED_DIFF"
  }
}
```

The client accepts either response shape:

```json
{"task":{"id":"TASK_ID"}}
```

or:

```json
{"id":"TASK_ID"}
```

A successful response without an ID is treated as an error.

Before creating a task, `codex cloud exec` resolves `--env` against the remote
environment list. It accepts an exact environment ID or a case-insensitive,
unambiguous label. The branch is selected in this order:

1. Non-empty `--branch` value.
2. Current local branch.
3. Repository default branch.
4. Literal `main`.

Both CLI and TUI task creation currently send
`run_environment_in_qa_mode: false`.

### Get task details

```http
GET /backend-api/wham/tasks/{task_id}
```

The same endpoint backs `codex cloud status`, task text/message loading, and
diff loading. The client uses both typed and raw JSON views of the response.
Observed top-level fields include:

```json
{
  "task": {
    "id": "TASK_ID",
    "title": "Task title",
    "environment_id": "ENV_ID",
    "created_at": 0,
    "updated_at": 0,
    "is_review": false,
    "task_status_display": {}
  },
  "task_status_display": {},
  "current_user_turn": {},
  "current_assistant_turn": {},
  "current_diff_task_turn": {}
}
```

A turn is read with this partial shape:

```json
{
  "id": "TURN_ID",
  "attempt_placement": 0,
  "turn_status": "pending | in_progress | completed | failed | cancelled",
  "sibling_turn_ids": [],
  "input_items": [],
  "output_items": [],
  "worklog": {"messages": []},
  "error": {"code": "CODE", "message": "MESSAGE"}
}
```

Message items use `type: "message"` with text content fragments. Diffs are
recognized in either of these output item forms:

```json
{"type":"output_diff","diff":"..."}
```

```json
{"type":"pr","output_diff":{"diff":"..."}}
```

For a diff, `current_diff_task_turn` is checked before
`current_assistant_turn`. For the original prompt, the client reads
`current_user_turn`. Assistant text may also be recovered from
`current_assistant_turn.worklog.messages` where
`author.role == "assistant"`.

### List sibling attempts

```http
GET /backend-api/wham/tasks/{task_id}/turns/{turn_id}/sibling_turns
```

Partial response shape:

```json
{
  "sibling_turns": [
    {
      "id": "TURN_ID",
      "attempt_placement": 1,
      "created_at": 0,
      "turn_status": "completed",
      "output_items": []
    }
  ]
}
```

The CLI combines the current attempt from task details with these sibling
turns, then sorts attempts by `attempt_placement`, falling back to creation time.
Attempt selection in `codex cloud diff` and `codex cloud apply` is one-based.

### Create an environment

The CLI does not expose environment creation, but the ChatGPT backend accepts:

```http
POST /backend-api/wham/environments
Content-Type: application/json
```

A minimal request verified against a private GitHub repository on `2026-09-06`:

```json
{
  "machine_id": "wham-public/wham-universal",
  "label": "Environment label",
  "repos": ["github-REPOSITORY_DATABASE_ID"]
}
```

The repository identifier is the numeric GitHub REST `id`, prefixed with
`github-`. For example, if `GET /repos/{owner}/{repo}` returns `"id": 12345`,
the Codex repository reference is `github-12345`.

Sending `{}` produced `400 Bad Request` with validation errors identifying all
three fields as required: `machine_id`, `label`, and `repos`. The minimal valid
request returned `200 OK`, not `201 Created`, with the complete environment
object. Defaults observed in that response included `is_pinned: false`,
`task_count: 0`, and no workspace directory. The created environment was
immediately returned by both the global list and the repository-specific lookup.
`codex cloud list --env <label> --json` also resolved and used the new label.

Only the WHAM route was tested. The `/api/codex/environments` equivalent is
inferred from the list-route symmetry and remains unverified. The public Codex
documentation describes creating and configuring environments through Codex
settings, but does not document this HTTP API.

### Update environment settings

The ChatGPT backend supports partial updates:

```http
PATCH /backend-api/wham/environments/{environment_id}
Content-Type: application/json
```

An empty object returned `200 OK` and left the environment unchanged. `PUT` and
`POST` on the item URL returned `405 Method Not Allowed`. No `If-Match` header
was required in the live test, although a successful mutation returned a new
`etag` in the response.

This request was verified for environment variables, secrets, setup commands,
and unrestricted agent network access:

```json
{
  "env_vars": {
    "FOO": "bar"
  },
  "secrets": {
    "FOO_SECRET": "secret"
  },
  "setup": "echo \"dummy-test setup starting\"\nprintf 'FOO=%s\\n' \"$FOO\"\ntest -n \"$FOO_SECRET\" && echo \"FOO_SECRET is set\"",
  "agent_network_access": {
    "mode": "on",
    "preset_allowlist": "all",
    "allowlist_domains": "",
    "allowlist_rules": null,
    "denylist_domains": null,
    "safe_methods_only": null
  }
}
```

The unrestricted network shape was first observed on existing environments and
then accepted for the test environment. It matches the official documentation's
“unrestricted” agent internet access option.

Request and response representations differ for setup scripts: `PATCH` expects
`setup` to be a single string. Sending an array produced `400 Bad Request` with
`Input should be a valid string`. Successful responses and subsequent list
requests represent the script as a one-element array containing the multiline
string.

Secrets are submitted as clear-text string values over HTTPS. The response did
not echo the value; it returned:

```json
{
  "secrets": {
    "FOO_SECRET": "<REDACTED>"
  }
}
```

The update returned `200 OK`. A subsequent environment-list request confirmed
the environment variable, multiline setup script, and network policy, but its
`secrets` map was empty. A later no-op `PATCH {}` returned
`FOO_SECRET: "<REDACTED>"` again, indicating that item-update responses expose
stored secret names while list responses omit them. The clear-text value was
never returned. Whether `env_vars` and `secrets` are merged or wholly replaced
when the existing maps contain other keys remains untested.

### List environments

```http
GET /backend-api/wham/environments
GET /backend-api/wham/environments/by-repo/github/{owner}/{repo}
```

Both endpoints are decoded as a bare JSON array with this consumed shape:

```json
[
  {
    "id": "ENV_ID",
    "label": "Environment name",
    "is_pinned": false,
    "task_count": 0
  }
]
```

A direct authenticated request to `/backend-api/wham/environments` was verified
with `200 OK` on `2026-09-06`. It returned a bare, unpaginated array. Live
objects contained considerably more data than the four fields consumed by the
CLI environment picker:

- Identity and metadata: `id`, `label`, `description`, `creator_id`,
  `created_at`, `etag`, `is_pinned`, and `task_count`.
- Repository configuration: `repos`, `repo_map`, `github_connector_id`,
  `codex_github_direct`, and `enable_gitlab_webhooks`.
- Runtime configuration: `machine_id`, `workspace_dir`, `setup`,
  `maintenance_setup`, `auto_setup_settings`, `cache_settings`,
  `enable_docker_in_docker`, and `enable_authtranslator`.
- Network and configuration data: `agent_network_access`, `env_vars`,
  `secrets`, and `secrets_with_domains`.
- Access control: `permissions`, `share_settings`, `share_targets`.

The tested environments returned clear-text non-secret environment variable
maps and setup commands. Their `secrets` maps were empty, so whether populated
secret values are ever returned remains unverified. Clients should treat the
entire response as sensitive and avoid logging raw environment objects.

### Retrieve environment settings

There is no observed read-one endpoint. A live
`GET /backend-api/wham/environments/{environment_id}` returned
`405 Method Not Allowed`. To retrieve settings, request the global or
repository-specific environment list and select the object by `id`.

The minimally created test environment returned these default settings:

```json
{
  "setup": [],
  "maintenance_setup": [],
  "auto_setup_settings": null,
  "cache_settings": {
    "cache_invalidation_key": "",
    "post_setup_cache_enabled": true
  },
  "agent_network_access": null,
  "env_vars": {},
  "secrets": {},
  "secrets_with_domains": null,
  "workspace_dir": null,
  "enable_docker_in_docker": false,
  "enable_authtranslator": false,
  "enable_gitlab_webhooks": false,
  "share_settings": "workspace",
  "share_targets": [],
  "permissions": {
    "can_delete": true,
    "can_write": true
  }
}
```

`setup` is the initial setup/startup script list. `maintenance_setup` is the
optional script list run when a cached environment resumes. The official docs
say environment variables are available during setup and the agent phase,
while secrets are decrypted only for setup and removed before the agent phase.
`post_setup_cache_enabled: true` indicates that the post-setup container is
cached by default. An empty `cache_invalidation_key` was returned for the new
environment.

Repository lookup is attempted for each local GitHub origin. Environment list
results are de-duplicated by ID. The TUI sorts pinned environments first and
uses repository hints for display. Autodetection prefers, in order: an exact
requested label, the only result, a pinned environment, then the environment
with the highest `task_count` (or the first result).

## Command-to-API behavior

| Command | Remote requests | Local behavior |
|---|---|---|
| `codex cloud` | Lists tasks and environments; may perform repository-specific environment lookups and refetch tasks for an autodetected environment. | Runs the TUI. |
| `codex cloud exec` | Lists environments to resolve `--env`, then creates a task. | Resolves the Git ref and prints the browser task URL. |
| `codex cloud list` | Optionally lists environments to resolve `--env`, then lists tasks. | Formats text or JSON output. |
| `codex cloud status` | Gets task details. | Exits non-zero unless derived status is `ready`. |
| `codex cloud diff` | Gets task details and, when available, sibling turns. | Selects and prints a unified diff. |
| `codex cloud apply` | Gets task details and, when available, sibling turns. | Applies the selected diff locally. There is no remote “apply” API request in this implementation. |

`apply` and its preflight mode call local Git patching code. They validate that
the returned patch looks like a unified diff before running it.

### End-to-end environment validation

On `2026-09-06`, a task was created in the API-created and API-configured test
environment. The prompt asked the agent to run `wc -w README.md`, report the
count, and make no changes. The task moved from `pending` to `ready` in about
33 seconds and returned a completed assistant turn reporting 232 words. It
produced no diff. This verifies that an environment created with
`POST /wham/environments`, updated with `PATCH /wham/environments/{id}`, and
selected by label can execute a Cloud Task. The task did not make a network
request, so unrestricted network access was configured but not functionally
exercised by this test.

## Browser task URL

API task IDs are presented to users as a frontend URL. For the default backend:

```text
https://chatgpt.com/codex/tasks/{task_id}
```

The `/backend-api` segment is intentionally removed when this browser URL is
constructed.

## Task follow-ups, history, and logs

Follow-ups use `POST /backend-api/wham/tasks` with this body:

```json
{
  "follow_up": {
    "task_id": "TASK_ID",
    "turn_id": "TASK_ID~ASSISTANT_TURN_ID",
    "run_environment_in_qa_mode": false
  },
  "input_items": [{
    "type": "message",
    "role": "user",
    "content": [{ "content_type": "text", "text": "Follow-up prompt" }]
  }]
}
```

The response includes `task.id`, `user_turn.id`, and `turn.id`. The SDK returns
these as `id`, `userTurnId`, and `turnId`, alongside the task URL.

`GET /backend-api/wham/tasks/{task_id}/turns` returns `current_turn_id` and a
`turn_mapping` object keyed by turn ID. Each node contains `id`, `parent`,
`children`, and `turn`. The SDK preserves those relationships and exposes
messages, status, environment ID, creation time, diff, and attempt placement.

`GET /backend-api/wham/tasks/{task_id}/turns/{turn_id}/logs` returns:

```json
{
  "logs": [{
    "key": {
      "name": "setup",
      "type": "UserSetupScript",
      "created_at": "2026-09-07T03:18:07.481184"
    },
    "line": "Running setup scripts..."
  }]
}
```

Log order and timestamps are preserved. These endpoints work with Codex OAuth
credentials without browser cookies or Sentinel headers. Log output may contain
sensitive information printed by task or setup scripts.
