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

Initialize existing-environment edits through the native Codex UI as described in
[Existing environment editing](#existing-environment-editing). Retain the
original config, draft, and editing thread IDs; the runtime ID is not a config ID.

```typescript
const current = await client.environments.getDraft(configId, draftId);
if (!current.draft) throw new Error("Draft not returned");
// Review current.draft before publishing its exact revision.
const published = await client.environments.publish(configId, draftId, {
  expectedRevision: current.draft.revision,
  idempotencyKey: crypto.randomUUID(),
  threadId: editingThreadId,
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
key, operation ID, and returned `draft_scope` across retries. Pass `draft_scope`
as `options.draftScope` to `completePublish()` (or `draftScope` to the MCP tool). Errors after `beginPublish()` include the
operation ID. An operation timeout leaves publication
pending; it does not cancel it. Draft conflicts surface as HTTP errors and are
not automatically retried. A completion failure can occur after the version
has changed; inspect the config before retrying rather than beginning a new
publication.

`getDraft()` first reads the explicit editing-session route. If that returns
404, it reads the config and accepts its draft only when the ID matches exactly.
`openDraft()` returns the existing config draft's runtime and thread when its
base is the current version. Otherwise it rejects new allocation with native UI
initialization instructions. Onboarding publication uses the singular
`/draft/approve/begin` and `/draft/approve/complete` routes. Completion sends
only `operation_id`; the backend selects the config's owning setup thread.
A successful operation can consume the config draft before completion, so keep
the scope returned by begin. With that scope, `threadId` can be omitted for
onboarding. Editing-session drafts still require it. If supplied for onboarding,
it must match the config's `thread_id`. Older callers without retained scope can
complete a consumed config draft using that owning thread ID.

Other environment methods are `get()`, `rename()`, `getVpn()`, and
`listSecrets()`. Secret listing returns metadata. `updateDraft()` changes
config-owned onboarding drafts only. It supports repository refs, network
policy, portals, scripts, start skill, `secrets`, and `runtime_requirements`.
Direct editing-session writes are rejected because the server cannot verify
the native UI registration; use its editor or draft-owning chat instead.

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
attach its ID to a config-owned onboarding draft and publish to apply it:

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
`start_onboarding: true` runs that workflow automatically and returns a
`setup_task` with the durable setup thread and turn.
`setupEnvironment()` resumes an existing config `thread_id`, or allocates a
setup thread if none exists. It rejects an active turn before sending input.
If setup fails after creation, the error retains the config ID for recovery.

### MCP onboarding workflow

1. Call `create_environment` with `start_onboarding: true`. Retain `id` and
   `setup_task.thread.id` / `setup_task.turn.id`; inspect progress with
   `list_task_turns` or `wait_for_task`. For a config created without onboarding,
   call `start_environment_setup` with its `environmentConfigId`.
2. Once setup finishes, read `get_environment`. Review its `draft` through
   `get_environment_draft` using the returned `draft.id`.
3. Call `begin_environment_publish` with that ID, the reviewed draft's
   `revision` as `expectedRevision`, and a new UUID `idempotencyKey`.
4. Keep the returned operation ID and `draft_scope`. Poll
   `wait_for_environment_operation` with the same operation ID after a timeout.
5. When the operation is `SUCCEEDED`, call `complete_environment_publish` with
   the config ID, original draft ID, operation ID, and `draftScope`. An explicit
   editing session also needs the original native editing `threadId`.
6. Confirm `get_environment` reports the expected published scripts and ready
   version. If completion errors, inspect that state before retrying. Do not
   start another publication just because completion's response was lost.

## Existing environment editing

A new edit of a published environment must start with **Edit environment** in
Codex's environment settings. The native flow allocates a separate draft with
`POST /v1/environment-configs/{configId}/drafts`, registers the editing session
in the client, and opens its thread. The MCP server cannot currently perform or
verify that UI registration. It therefore rejects new `open_environment_draft`
allocations and direct editing-session `update_environment_draft` writes.
It does not substitute an ordinary task or the config's original setup thread.

1. In the native UI, open the environment's editing session. Keep the original
   `configId` plus the allocation response's `draft_id`, `thread_id`, and
   `environment_id`. If a native edit is already in progress, continue that
   session instead of allocating another one.
2. Use the native editor or its chat to make the requested changes. MCP callers
   may send `follow_up_task` to that same native editing `thread_id` after its
   active turn finishes. Tell the agent to read
   `cloud_environment_onboarding.read_environment_config_draft`, verify the
   exact draft ID, preserve unrelated settings/secrets, and save without
   publishing. Those tools belong to the allocated runtime; a new `start_task`
   or `start_environment_setup` is not an editing-session substitute.
3. Call `get_environment_draft` with the original config and draft IDs. Verify
   the returned draft ID and review the saved fields and revision. The explicit
   draft response's `environment_id` is the editing runtime. `get_environment`
   can return `draft: null` while this explicit draft still exists.
4. Call `begin_environment_publish` with the reviewed revision and a fresh UUID
   idempotency key. Retain the operation ID and `draft_scope`.
5. Poll the same operation until `SUCCEEDED`, then call
   `complete_environment_publish` with the original config/draft IDs, operation
   ID, original editing `threadId`, and returned scope as `draftScope`.
6. Read `get_environment` and verify the published revision and intended fields.

An allocated thread without turns may be invisible in the sidebar. Naming or
sending a first turn can make a chat discoverable, but neither proves native UI
registration or repairs the environment icon and Continue editing state. Do not
use those steps as a workaround for a rejected allocation. Null `threadSource`
and missing `environmentConfigId` also occur on native editing threads and do
not diagnose whether their draft tools are available.

For legacy MCP-created sessions, keep the original IDs: reads and both
publication paths remain available for recovery. A missing config `draft` is
not permission to allocate a replacement. If a request times out, inspect the
same thread's turns or the same publication operation before retrying; never
begin a second publication to recover from a wait or completion error. A
succeeded operation can already have changed the published version before
completion returns an error.

`draftScope` is included in the server's `complete_environment_publish` schema.
If a connector omits it, refresh that connector's tool discovery. Older callers
can still use the original draft and owning thread IDs for scope resolution;
do not substitute a runtime ID for a config ID to work around a 403/404.

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
thread and turn IDs. Naming applies only to newly allocated threads; resuming
an existing setup keeps its title. An explicit name still reads the config to
find any existing setup thread.
`rename(threadId, name)` changes a stored thread's title without resuming its
environment and returns its metadata with the confirmed name.
`archive(threadId)` rejects an active thread, sends `thread/archive` without
resuming its environment, and returns `{ threadId, archived: true }` after
backend acknowledgement. Archived tasks are excluded from `list()`; `get()`
can still read their metadata without an explicit archived flag.
`restore(threadId)` sends `thread/unarchive` and returns the restored thread
metadata. Restored threads reappear in `list()`; restoring does not start a turn.

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
