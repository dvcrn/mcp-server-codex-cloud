# Codex Cloud client

The SDK uses ChatGPT OAuth credentials and the internal Codex Cloud backend.
The API is undocumented and may change. HTTP requests and cloud WebSocket
connections use the same token store.

## Connect

```typescript
import { CodexCloudClient } from "mcp-server-codex-cloud";

const client = await CodexCloudClient.fromCodexHome();
try {
  const page = await client.environments.list();
  console.log(page.data);
} finally {
  client.close();
}
```

`fromCodexHome({ authFile })` selects a different auth file. Alternatively,
provide `tokens: { accessToken, accountId, refreshToken }` or a `tokenStore`.
The CLI's default credential location is
`~/.config/mcp-server-codex-cloud/auth.json`; `fromCodexHome()` defaults to
`~/.codex/auth.json`.

Node uses its native HTTP transport. Client options include injectable `fetch`, `socketFactory`, `baseUrl`, and
`rpcTimeoutMs`. The default backend is
`https://codex-cloud-backend.chatgpt.com`, with its corresponding `wss:` socket.
Call `close()` after using the client to release the socket. OAuth tokens refresh
before expiry; custom stores must coordinate refreshes and persist rotated
credentials atomically.

## Configure and publish

```typescript
const config = await client.environments.create({
  name: "my repository",
  repositories: [{ repository_id: "github-12345", ref: "main" }],
  network_policy: { type: "unrestricted" },
});
const editing = await client.environments.openDraft(config.id);
const current = await client.environments.getDraft(config.id, editing.draft_id);
if (!current.draft) throw new Error("Draft not returned");
const saved = await client.environments.updateDraft(config.id, editing.draft_id, {
  base_version_id: current.draft.base_version_id,
  expected_revision: current.draft.revision,
  install_script: "bun install --frozen-lockfile",
  start_skill: "Run the relevant tests after changing code.",
});
if (!saved.draft) throw new Error("Draft not returned");
const published = await client.environments.publish(config.id, editing.draft_id, {
  expectedRevision: saved.draft.revision,
  idempotencyKey: crypto.randomUUID(),
  threadId: editing.thread_id,
});
```

The create default is private sharing, restricted network access with the
`package_managers` preset, and `start_onboarding: false`. Config and draft
objects preserve snake_case fields. Config pages use `{ data, next_cursor }`.
Repository references require a numeric GitHub repository ID in `github-N` form
and an explicit Git ref.

`publish()` performs begin, wait, complete, and published-config readback. For
long-running publication, use `beginPublish()`, `getOperation()` or
`waitForOperation()`, and `completePublish()` separately. Retain the idempotency
key and operation ID across retries. Errors after `beginPublish()` include the
operation ID. An operation timeout leaves publication
pending; it does not cancel it. Draft conflicts surface as HTTP errors and are
not automatically retried.

Other environment methods are `get()`, `rename()`, `getVpn()`, and
`listSecrets()`. Secret listing returns metadata. `updateDraft()` can change
repository refs, network policy, portals, scripts, start skill, `secrets`, and
`runtime_requirements`.

## Variables and network secrets

`savePersonalSecrets(namespace, entries)` creates personal vault entries or updates
entries with an existing `id`. Use `not_sensitive` for real environment variables
and `sensitive` for network secrets. Supply `name`, `env_var`, and a `target` of
`{ type: "all_environment_configs" }` or
`{ type: "environment_config_ids", ids: [configId] }`. Create requires `value`;
updates can omit `value` to preserve it. Results contain IDs and names only.
The environment must also request a personal variable through a runtime requirement.

`deletePersonalSecrets(namespace, ids)` deletes one or more personal vault entries
and returns `{ deleted: [{ id, name }] }`. Names come from metadata listing;
values are never requested. All IDs must exist in that namespace before any
entry is deleted. Duplicate IDs are deleted once. Deletions stop on the first
failure and the error reports prior confirmed deletions. List metadata before
retrying because the failed request may have reached the backend.

The delete route is `DELETE /v1/personal-secrets` with a JSON body containing
`{ namespace, ids }`. The SDK sends one ID per request so confirmed progress
can be reported when a later deletion fails.

Shared values use `createValue({ namespace, name, value })`. Use `runtime` for
variables or `proxy` for network secrets. Each call returns a new value reference;
attach its ID to a draft and publish to apply it:

```typescript
const value = await client.environments.createValue({
  namespace: "runtime",
  name: "APP_MODE",
  value: "test",
});
const updated = await client.environments.updateDraft(configId, draftId, {
  base_version_id: draft.base_version_id,
  expected_revision: draft.revision,
  runtime_requirements: [
    ...(draft.runtime_requirements ?? []).filter(
      (entry) => entry.delivery.variable_name !== "APP_MODE",
    ),
    {
      source: { type: "vault_secret", id: value.id },
      optional: false,
      delivery: { type: "direct_environment_variable", variable_name: "APP_MODE" },
    },
  ],
});
```

A personal variable requirement uses `source: { type: "user_provided" }` and
`optional: true` with the same delivery shape. Shared network secrets attach via
`secrets: [{ id: value.id, name, source: "environment", target: {
environment_variable: name, allowed_domains: ["api.example.com"] } }]`.
Network secret values stay hidden from tasks and are substituted in outgoing
requests to allowed exact hostnames. Empty domains permit no destinations.
Both draft arrays replace the whole list, so preserve unrelated entries.
Personal network-secret requirements use the same target with
`source: "user_provided"`, `optional: true`, and no `id`. Stored values alone do
not change a published environment. Value-reading/deletion methods are not exposed.
MCP validates the supported attachment variants; if an existing list contains an
unsupported variant, do not replace that list with a partial list.

## Automatic environment setup

Create a config, then call
`client.tasks.setupEnvironment({ environmentConfigId: config.id })` to start the
Cloud Environment Onboarding setup skill. It returns the setup thread and first
turn. Read progress and continue the same conversation with the normal task
history and follow-up methods. Setup can inspect the repository, install tools,
and prepare a draft for review. Review and publish that draft to activate it.
Do not treat `start_onboarding` on config creation as this setup-task workflow.

## Tasks and follow-ups

```typescript
const task = await client.tasks.create({
  environmentConfigId: published.id,
  prompt: "Read README.md and explain this repository. Do not modify files.",
});
const result = await client.tasks.waitFor(task.thread.id, task.turn.id, {
  timeoutMs: 120_000,
});
console.log(result.items.filter(item => item.type === "agentMessage"));

const followUp = await client.tasks.followUp({
  threadId: task.thread.id,
  prompt: "Which tests should I run?",
});
console.log(followUp.turn.id);
```

New task and setup threads use the Codex Cloud service and user thread source.
Follow-ups resume their existing thread and preserve its origin.

Tasks use cloud thread IDs and turn IDs. Config IDs and runtime environment IDs
are separate identifiers. Create accepts a published `environmentConfigId` and
optional `cwd`, `model`, `effort`, and `serviceTier`. Follow-ups preserve the
thread's selected environment and accept the same model options.

`setupEnvironment({ environmentConfigId, name? })` starts onboarding with a
thread name defaulting to `Environment setup: <environment name>`. Naming is
best-effort after the first turn starts; a naming failure still returns the
thread and turn IDs. An explicit name skips the config metadata lookup.
`rename(threadId, name)` changes a stored thread's title without resuming its
environment and returns its metadata with the confirmed name.
`archive(threadId)` rejects an active thread, sends `thread/archive` without
resuming its environment, and returns `{ threadId, archived: true }` after
backend acknowledgement. Archived tasks are excluded from `list()`; `get()`
can still read their metadata without an explicit archived flag.

`steer({ threadId, expectedTurnId, prompt })` adds input to an active turn.
`cancel(threadId, turnId)` requests interruption and returns
`interruptRequested: true`; confirm `interrupted` status through turn history.
`waitFor(threadId, turnId)` returns the identified turn when it is `completed`,
`interrupted`, or `failed`, including any persisted output and error data.

`list()` returns paginated thread metadata. `get(threadId)` reads one thread.
`listTurns(threadId, { itemsView: "full", limit, cursor })` returns hydrated
conversation history; `summary` and `notLoaded` reduce item detail.
`listItems(threadId, { turnId, limit, cursor })` reads persisted items. These
pages use `{ data, nextCursor, backwardsCursor }` and preserve camelCase fields.
Tool output and file changes remain in their original discriminated item format.

For live events, register `tasks.subscribe(threadId, listener)`, then call
`tasks.resume(threadId)` to establish a connection. The returned function removes
the listener. Use `params.turnId` or `params.turn.id` to select a particular turn.
`listModels()` and `listCollaborationModes()` provide backend model metadata.

## Errors and cancellation

Methods accept `{ signal }`. Aborting an RPC stops local waiting; a submitted
mutation can still complete remotely. Disconnected or timed-out mutations are
not automatically replayed. Read persisted history before retrying task input.
If thread allocation succeeds but its first turn fails, the error includes the
created thread ID.

`ApiError` exposes HTTP status and a sensitive diagnostic `detail` field. `RpcError` exposes
its code and sensitive diagnostic `detail`/`data`. Upstream details can contain submitted
secrets; the MCP tools return status/code information without those details.
The Worker opens a separate upstream socket per MCP request and closes it after
delivery; use history polling across remote tool calls.
