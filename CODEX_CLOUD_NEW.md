# New Codex Cloud API investigation

Last updated: 2026-10-01. This is a working contract inventory for rewriting the SDK and MCP server.

## Evidence and verification

- **Captured** means a successful request made by the running ChatGPT/Codex app and inspected in Proxyman HAR data.
- **Probed** means a request sent independently using the local Codex OAuth access token, without browser cookies.
- **Inferred** means a proposed interpretation that still needs a capture or controlled test.
- **Client source** means static code from the installed ChatGPT app's `app.asar`; it establishes client behavior, not independently verified server support.
- Examples replace account, config, version, draft, environment, thread, and operation identifiers with placeholders. No credentials or personal-secret values belong in this file.
- Capture previews from Proxyman MCP truncated config bodies. Subsequent inspection uses the installed `proxyman-cli` and complete HAR bodies.
- Raw captures are private files under `/tmp/codex-cloud-investigation/`, outside the repository. Directory permissions are 0700 and HAR permissions are 0600. They contain credentials and are not suitable for committing.

## Authentication

The existing Codex OAuth access token works against the new backend. It is the same token used by the captured app requests, verified by comparing values without printing them.

```http
Authorization: Bearer <Codex OAuth access token>
ChatGPT-Account-ID: <account ID>
Accept: application/json
Content-Type: application/json
```

`Content-Type` is used for JSON request bodies. Independent probes used the current SDK user agent, `codex-typescript-sdk/0.0.0`.

| Test | Result |
| --- | --- |
| Existing OAuth token plus account header on all 11 initial captured GET variants | 200 |
| Existing OAuth token without account header on user config list | 200 |
| No token on the same config list | 401 |
| Existing OAuth token PATCHing the newly created config with its current name | 200 |
| Browser cookies, `originator`, Sentry headers, product SKU | Omitted from successful independent probes |

The anonymous error body was:

```json
{"error":{"code":-32002,"message":"identity-edge rejected app-server-backend request authentication"}}
```

The access token was valid during testing. No OAuth refresh was needed or attempted. Refresh behavior, device login against this backend, and OpenAI platform API keys have not been tested. The account-header-free result only establishes behavior for that one endpoint and account; retain the header in the SDK.

## Hosts and transport

| Host | Observed purpose |
| --- | --- |
| `https://codex-cloud-backend.chatgpt.com` | Configs, drafts, publish operations, thread reads, turn history, model and collaboration-mode metadata |
| `https://codex-cloud-environments.chatgpt.com` | Runtime environment status at `/api/cloud/environment/{environmentId}/status` |
| `https://chatgpt.com/backend-api/wham` | Legacy environments and tasks remain reachable; relationship to new work is unverified |

New backend paths have explicit `/v1` and `/v2` versions. The current `HttpClient` appends `/wham` or `/api/codex` automatically, so changing only its base URL cannot produce the new routes.

The runtime status host was found by inspecting request metadata across the session after task creation was absent from the filtered backend export. No task-creation POST or cloud app-server WebSocket handshake was found in that snapshot. Subsequent installed-client inspection and a live probe established a separate cloud WebSocket at `wss://codex-cloud-backend.chatgpt.com/`. See the transport investigation below.

Computer Use refused access to the running ChatGPT/Codex app, so interactive capture actions were performed by the user.

### Cloud WebSocket transport

**Client source:** `/Applications/ChatGPT.app/Contents/Resources/app.asar` contains `.vite/build/main-BbeJ4AAR.js` and `.vite/build/application-network-startup-D74LEWDz.js`. Extracted copies are under the private investigation directory. The main bundle defines the durable host's URL as:

```text
wss://codex-cloud-backend.chatgpt.com/
```

The client supplies these WebSocket subprotocols:

```text
codex-app-server
codex-client.desktop
openai-bearer.<Codex OAuth access token>
```

Authentication therefore places a credential in `Sec-WebSocket-Protocol`. Treat that header as sensitive in captures and diagnostics. The client also supplies `ChatGPT-Account-ID` and `X-OpenAI-Product-Sku: codex` headers.

**Probed:** an independent connection using the existing local OAuth token opened successfully. The selected protocol was `codex-app-server`. These text JSON messages succeeded:

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {"name":"codex_cloud_investigation","version":"0.0.0"},
    "capabilities": {"experimentalApi":true}
  }
}
```

The initialization response used `{id, result}` with result fields `userAgent`, `codexHome`, `platformFamily`, `platformOs`, and `persistentMcpElicitations`.

After initialization:

```json
{"method":"initialized"}
```

```json
{"id":2,"method":"model/list","params":{"limit":1,"includeHidden":false}}
```

The model response used `{id, result: {data: [...], nextCursor}}` and returned one model. The probe closed its own socket with code 1000. No task or config mutation was sent over this connection. These messages use the app-server request envelope without a `jsonrpc` property; request IDs correlate responses and notifications use `method`.

**Client source:** the durable transport wraps a Node WebSocket connection with an HTTP read adapter. Requests outside the adapter's read allowlist are forwarded to the WebSocket. Selected mappings are:

| App-server method | HTTP route used by client |
| --- | --- |
| `thread/read` with `includeTurns` absent/false | `/v1/threads/{threadId}` |
| `model/list` | `/v2/models` |
| `collaborationMode/list` | `/v2/collaboration-modes` |
| `account/rateLimits/read` | `/v2/account/rate-limits` |
| `thread/realtime/listVoices` | `/v2/realtime/voices` |
| `thread/turns/list` | `/v2/threads/{threadId}/turns` |
| `thread/items/list` | `/v2/threads/{threadId}/items` |

Parameters other than `threadId` and `includeTurns` become query parameters. The adapter uses Electron `net.fetch` for HTTP. For turn/item history, an HTTP timeout can fall back to the original request over the WebSocket with a remapped request ID. The client separately answers `account/read`, `getAuthStatus`, and `configRequirements/read` through its desktop account connection. Rate-limit and voice HTTP routes remain source-derived and unprobed; the item HTTP route was subsequently verified in the SDK smoke.

The Node socket constructor supplies an explicit SOCKS agent only for selected host configurations; the production durable host path does not supply it. No system HTTP-proxy agent is supplied in that constructor. This is consistent with Electron HTTP reads appearing in Proxyman while the cloud socket connects directly; explicit proxy capture would verify the routing behavior.

### Capture troubleshooting evidence

- Live connection inspection found the main ChatGPT process and its Codex child with direct TCP connections to remote port 443, alongside helper/child connections to Proxyman at `127.0.0.1:9090`. Port 443 alone does not identify an application protocol or hostname.
- A system-proxy snapshot showed HTTP/HTTPS proxy disabled. The user then explained they had just temporarily disabled it. A subsequent snapshot confirmed both re-enabled at `127.0.0.1:9090`; the disabled snapshot does not explain the earlier missing captures.
- Diagnostic logs under `~/Library/Logs/com.openai.codex/2026/10/01/` show successful `thread/start` and `turn/start` routing and environment-connected events on `hostId=durable` during the captured workflow. SSH and remote-control WebSocket logs are separate transports and must not be used as cloud-task evidence.
- The refreshed `ws.chatgpt.com` HAR contained 947 deduplicated frames. Text messages contained presence, connect, subscribe, and reply types; remaining frames were ping, pong, and close control frames. No task/app-server method or task payload was found in this export. That connection is not the demonstrated cloud app-server socket.

The next capture attempt should route the Node cloud socket explicitly through the proxy and establish a fresh connection. Re-enabling the system proxy alone does not guarantee that an existing socket is rerouted. The investigation did not change proxy configuration, inject a network client, or restart the app; the user controlled proxy toggles and the subsequent restart.

The user subsequently restarted ChatGPT and created a cloud task with the prompt `what can you do for meee`. The backend HAR export after that restart still contained no 101 handshake or WebSocket frames. Restart alone did not make this connection visible through Proxyman. The independently authenticated socket remains the verified transport evidence.

### Local app-server schemas and candidate task requests

The bundled CLI can generate its protocol schemas without starting a task:

```sh
codex app-server generate-json-schema --experimental --out <private output directory>
```

Generated files are under `/tmp/codex-cloud-investigation/app-server-schema/`. These are **local protocol schemas**, not a guarantee that the cloud backend supports every method or optional field. The cloud socket's initialization, model read, thread resume, and follow-up turn are independently verified. Cloud config thread allocation is verified in the SDK validation section; remaining methods and optional fields are schema-derived candidates.

| Method | Required parameters in local schema | Purpose |
| --- | --- | --- |
| `thread/start` | None | Create a thread; config allocation independently verified below |
| `thread/resume` | `threadId` | Resume an existing thread; verified with `excludeTurns: true` |
| `turn/start` | `threadId`, `input` | Submit input to a thread; verified on an existing test session |
| `turn/steer` | `threadId`, `expectedTurnId`, `input` | Add input subject to an active-turn precondition |
| `turn/interrupt` | `threadId`, `turnId` | Interrupt a specific turn |

Verified follow-up text-input envelope:

```json
{
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "<threadId>",
    "input": [{"type":"text","text":"<prompt>","text_elements":[]}]
  }
}
```

The local text-input schema requires `type` and `text`; `text_elements` defaults to an empty array. Additional local input variants include image, local image, audio, local audio, skill, and mention. Their cloud availability is untested.

Both thread-start and turn-start schemas accept `environments` entries with required `environmentId` and `cwd`, plus optional `runtimeWorkspaceRoots`. The schema distinguishes omitted environments (use defaults/sticky selection), an empty list (disable environment access), and a non-empty list (select its first environment). This accepts runtime environment IDs; it does not establish how a config ID should be allocated into a new task runtime.

Optional thread-start fields include `model`, `modelProvider`, `config`, `baseInstructions`, `developerInstructions`, `historyMode`, `projectId`, `threadSource`, `ephemeral`, `permissions`, and `sandbox`. Optional turn-start fields include `model`, `effort`, `serviceTier`, `serviceTierForTurn`, `collaborationMode`, `clientUserMessageId`, and `outputSchema`. Selection, permission, and default semantics must be validated against the cloud backend before exposing them in MCP tools.

The generated request union also includes thread resume/fork/archive/unarchive/delete, naming, metadata/settings, queue operations, search/list/read, history reads, compaction, attachment operations, goal operations, and realtime operations. This is a candidate capability inventory only. Archive and delete remain untested. Cloud config task-start, steering, and interruption were subsequently exercised below.

### Verified follow-up to an existing cloud session

Sent a follow-up to the completed test session named `Explain what I can do`, identified by its user message `what can you do for meee`. Thread ID: `01a0f646-4bad-779b-8659-1199e715e0a3`.

After the authenticated socket initialization and `initialized` notification, sent:

```json
{"id":2,"method":"thread/resume","params":{"threadId":"01a0f646-4bad-779b-8659-1199e715e0a3","excludeTurns":true}}
```

The successful resume returned `thread`, `model`, `modelProvider`, `serviceTier`, `cwd`, `runtimeWorkspaceRoots`, `instructionSources`, `approvalPolicy`, `approvalsReviewer`, `sandbox`, `activePermissionProfile`, `reasoningEffort`, `collaborationMode`, `multiAgentMode`, `disabledPluginIds`, `threadInstructionsEnabled`, `initialTurnsPage`, `turnsBackwardsCursor`, `itemsBackwardsCursor`, and `resumeKind`. The returned thread ID matched the target. This verifies the resume-then-start sequence; whether resume is mandatory before every follow-up remains untested.

Sent the `turn/start` envelope above with the prompt `Follow-up API test: reply with exactly 'follow-up received'. Do not run tools or change files.` The response was `{id: 3, result: {turn: ...}}`, with turn ID `01a0f64d-caf2-730a-aa23-c0372922042c` and status `inProgress`. No environment or model override was supplied.

Observed notifications:

| Method | Observed parameter keys |
| --- | --- |
| `thread/status/changed` | `threadId`, `status` |
| `turn/started`, `turn/completed` | `threadId`, `turn` |
| `item/started` | `threadId`, `turnId`, `item`, `startedAtMs` |
| `item/completed` | `threadId`, `turnId`, `item`, `completedAtMs` |
| `item/agentMessage/delta` | `threadId`, `turnId`, `itemId`, `delta` |
| `rawResponseItem/completed` | `threadId`, `turnId`, `item` |
| `thread/tokenUsage/updated` | `threadId`, `turnId`, `tokenUsage` |
| `mcpServer/startupStatus/updated` | `threadId`, `name`, `status`, `error`, `failureReason` |

The target's completed agent item contained `follow-up received`; `turn/completed` reported `completed`. An independent HTTP history read with `itemsView=full` returned 200 and confirmed the same turn ID, completed status, user input, and agent reply. Its persisted item types were only `userMessage` and `agentMessage`.

The connection also received a `turn/completed` notification for a different thread before resume returned. Therefore this connection's notifications are not confined to the resumed thread. Correlate RPC responses by request ID, and route notifications by `threadId` plus `turnId` or `turn.id` before declaring a task complete. The probe did not send an interrupt request.

## IDs and relationships

| Identifier | Observed format | Role |
| --- | --- | --- |
| Config ID | `<account UUID>~asenvcfg_<hex>` | Persistent environment configuration |
| Version ID | `<UUID>~cecfgver_<hex>` | Config version |
| Draft ID | `<UUID>~cecfgdraft_<hex>` | Editable config draft |
| Environment ID | `ccarenv_b64_<opaque suffix>` | Runtime environment |
| Thread ID | UUID | Conversation/session |
| Operation ID | `ceop_<hex>` | Asynchronous environment operation |
| Repository ID | `github-<numeric ID>` | GitHub repository reference |

Treat IDs as opaque. Config IDs, version IDs, runtime IDs, and thread IDs are distinct and must not be substituted for one another.

Observed editing sequence:

1. Read or create a config.
2. Create/open its editing runtime with `POST /environment-configs/{configId}/drafts`. The response contains `draft_id`, `environment_id`, and `thread_id`.
3. Read the config plus draft using the explicit draft ID.
4. Save changes with the draft PATCH route and revision fields.
5. Begin approval/publication with the expected draft revision and an idempotency key.
6. Poll the returned environment operation until it succeeds.
7. Complete approval with the operation ID and editing thread ID, then re-read the config before reporting publication complete.

The user describes environment onboarding as a conversation that sets the environment up. Captures establish the config/draft/runtime/thread relationship, but the request that begins that conversation is still missing. The captured config creation sets `start_onboarding: false`; behavior with `true` is unverified.

## Endpoint inventory

Paths in this table are relative to the new backend host unless a different host is stated. Captured-only writes have not been independently replayed.

| Method | Path | Verification | Response |
| --- | --- | --- | --- |
| GET | `/v1/environment-configs?scope=user&limit=100&omitDraft=true` | Captured + probed 200 | `{data, next_cursor}` |
| GET | `/v1/environment-configs?scope=workspace&limit=100&omitDraft=true` | Captured + probed 200 | `{data, next_cursor}` |
| POST | `/v1/environment-configs` | Captured + SDK smoke 200 | Config |
| GET | `/v1/environment-configs/{configId}` | Captured + probed 200 | Config |
| PATCH | `/v1/environment-configs/{configId}` | Captured + probed 200 for name | Config |
| PATCH | `/v1/environment-configs/{configId}/draft` | Captured 200 | Config with `draft` |
| POST | `/v1/environment-configs/{configId}/drafts` | Captured + SDK smoke 200, empty body | `{draft_id, environment_id, thread_id}` |
| GET | `/v1/environment-configs/{configId}/drafts/{draftId}` | Captured + probed 200 | Config with `draft` |
| PATCH | `/v1/environment-configs/{configId}/drafts/{draftId}` | Captured + SDK smoke 200 | Config with incremented draft revision |
| POST | `/v1/environment-configs/{configId}/drafts/{draftId}/approve/begin` | Captured + SDK smoke 200 | Environment operation |
| POST | `/v1/environment-configs/{configId}/drafts/{draftId}/approve/complete` | Captured + SDK smoke 200 | Published config with retained `draft` |
| GET | `/v1/environment-operations/{operationId}` | Captured + probed 200 | Environment operation |
| GET | `/v1/environment-configs/{configId}/vpn` | Captured 200 | VPN capabilities/connection |
| GET | `/v1/environment-configs/{configId}/vpn?draft_id={draftId}` | Captured + probed 200 | VPN capabilities/connection |
| GET | `/v1/personal-secrets?namespace=not_sensitive` | Captured + probed 200 | `{secrets, next_cursor}` |
| GET | `/v1/personal-secrets?namespace=sensitive` | Captured + probed 200 | `{secrets, next_cursor}` |
| GET | `/v1/threads?limit=5` | Probed 200, including cursor pagination | `{data, nextCursor, backwardsCursor}` |
| GET | `/v1/threads/{threadId}` | Captured + probed 200 for existing threads | `{thread}` |
| GET | `/v2/threads/{threadId}/turns?limit=5&sortDirection=desc&itemsView=notLoaded` | Captured + probed 200 | `{data, nextCursor, backwardsCursor}` |
| GET | `/v2/threads/{threadId}/turns?limit=1&sortDirection=desc&itemsView=full` | Probed 200 with populated items | Same turn page envelope |
| GET | `/v2/models?limit=100&includeHidden=true` | Captured + probed 200 | `{data, nextCursor}` |
| GET | `/v2/collaboration-modes` | Captured + probed 200 | `{data}` |
| GET | Runtime host: `/api/cloud/environment/{environmentId}/status` | Captured + probed 200 | `{environment_id, status, type?}` |

Other probes: `GET /v2/threads?limit=5` returned 405; `GET /openapi.json` returned 404. Neither result establishes the complete method set. The app also captured two 404 responses for a newly referenced thread; an independent later read returned the same result. The body was `{"error":{"code":-32600,"data":{"grpcStatusCode":5},"message":"Some requested entity was not found: thread not found"}}`. The reason and retry semantics are unknown.

## Environment config formats

### Create

Captured request:

```http
POST /v1/environment-configs
```

```json
{
  "name": "example",
  "repositories": [{"repository_id": "github-123", "ref": "master"}],
  "network_policy": {
    "type": "restricted",
    "presets": ["package_managers"],
    "egress_rules": []
  },
  "share_settings": "private",
  "start_onboarding": false
}
```

The response contained config/version fields and `status: "ready"`. It initially omitted runtime/thread IDs. Later reads of that config included `environment_id` and `thread_id`. Exact timing and allocation behavior need verification.

### Config detail

Observed fields, with optionality unresolved unless noted:

```typescript
interface ConfigObserved {
  provider_metadata: Record<string, unknown>;
  id: string;
  name: string;
  is_owner: boolean;
  provider: string; // Observed: "caas".
  repositories: Array<{
    repository_id: string;
    ref: string;
    mount_path?: string;
  }>;
  install_script?: string;
  start_skill?: string;
  portals: { ssh: boolean };
  network_policy: NetworkPolicyObserved;
  secrets: unknown[];
  outbound_identity_requirements: unknown[];
  share_settings: string; // Observed: "private".
  version_id: string;
  version_revision: number;
  vpn_connection_id: string | null;
  status: string; // Observed: "ready".
  latest_ready_version_id: string;
  environment_id?: string;
  thread_id?: string;
  draft?: DraftObserved;
}

type NetworkPolicyObserved =
  | { type: "unrestricted" }
  | { type: "restricted"; presets: string[]; egress_rules: unknown[] };
```

Config-list entries are summaries: `id`, `provider`, `name`, `is_owner`, `version_id`, `version_revision`, `share_settings`, `repositories`, and optionally associated thread data. Use detail reads for scripts and network settings. Config pagination uses snake_case `next_cursor`; `cursor` was subsequently verified by requesting two different one-entry pages through stdio MCP.

### Rename

```http
PATCH /v1/environment-configs/{configId}
```

```json
{"name":"example renamed"}
```

The app's rename succeeded. An independent probe submitted the existing name for the newly created config and received 200. This proves write authentication for that route, not support for arbitrary config-field edits.

### Singular draft PATCH

The app changed network access through:

```http
PATCH /v1/environment-configs/{configId}/draft
```

```json
{
  "base_version_id": "<versionId>",
  "network_policy": {"type":"unrestricted"}
}
```

The response retained the published config's restricted network policy and included a draft with unrestricted access and `revision: 1`. This route edits draft state. Its interaction with the explicit `/drafts/{draftId}` route needs further testing.

### Editing runtime and explicit draft

```http
POST /v1/environment-configs/{configId}/drafts
Content-Length: 0
```

```json
{
  "draft_id": "<draftId>",
  "environment_id": "<runtimeEnvironmentId>",
  "thread_id": "<threadId>"
}
```

The same-config relationship between the singular draft PATCH and this request is observed, but preservation of prior singular-draft edits is not guaranteed by the capture. In this session a later explicit draft read showed restricted policy again; do not assume both routes operate on interchangeable state.

Observed draft fields:

```typescript
interface DraftObserved {
  provider_metadata: Record<string, unknown>;
  id: string;
  base_version_id: string;
  revision: number;
  repositories: ConfigObserved["repositories"];
  install_script?: string;
  start_skill?: string;
  portals: { ssh: boolean };
  network_policy: NetworkPolicyObserved;
  secrets: unknown[];
  outbound_identity_requirements: unknown[];
  vpn_connection_id: string | null;
}
```

### Save start script and start skill

```http
PATCH /v1/environment-configs/{configId}/drafts/{draftId}
```

```json
{
  "base_version_id": "<versionId>",
  "expected_revision": 1,
  "install_script": "echo \"hellooo\"",
  "start_skill": "echo \"start skikll \""
}
```

These script/skill strings are the user's captured test values. The response included them in `draft` and advanced its revision to 2. The published top-level config still represented the earlier version. Preserve `base_version_id` and `expected_revision` in the rewrite; conflict responses have not been tested.

### Publish

```http
POST /v1/environment-configs/{configId}/drafts/{draftId}/approve/begin
```

```json
{
  "expected_revision": 2,
  "idempotency_key": "<UUID>"
}
```

Initial response:

```json
{
  "id": "<operationId>",
  "kind": "APPROVE_ENVIRONMENT_CONFIG_DRAFT",
  "environment_id": "<runtimeEnvironmentId>",
  "state": "PENDING"
}
```

The client then polls `GET /v1/environment-operations/{operationId}`. Captured polls show `PENDING`, followed by `RUNNING`, then `SUCCEEDED`. The latest capture includes the subsequent completion request (flow 1524):

```http
POST /v1/environment-configs/{configId}/drafts/{draftId}/approve/complete
```

```json
{
  "operation_id": "<operationId>",
  "thread_id": "<editingThreadId>"
}
```

Completion returned a config with the new version, published script/skill values, and retained draft. An independent operation read also verified `state: "SUCCEEDED"`; an independent config read after the app's completion request verified:

- `status: "ready"` and `version_revision: 2`.
- A new `version_id`, equal to `latest_ready_version_id`.
- The captured `install_script` and `start_skill` values at the published config's top level.
- A `draft` property still present, so publication does not establish that draft state is absent.

A 200 from `/approve/begin` means the operation was accepted, not that publication completed. Follow the observed begin/poll/complete sequence; the captures do not isolate whether operation success alone would change the published version. Idempotency retention and duplicate-request behavior are untested. Operation terminal states other than `SUCCEEDED` are unknown.

The separate runtime-status endpoint also accepted the existing OAuth token/account header, without cookies, and returned `{"environment_id":"<runtimeEnvironmentId>","status":"connected"}`. Its `type` field was present in a captured example but omitted in this live response.

## Threads and turn history

### Thread list/detail

List pagination accepts `cursor=<opaque nextCursor>` and was independently verified to return the next page. Keep cursors opaque.

Observed thread fields include:

- `id`, `sessionId`, `forkedFromId`, `parentThreadId`.
- `environments`: entries with `environmentId`, optional `environmentConfigId`, `cwd`, and `runtimeWorkspaceRoots`. `environmentConfigId` provides a direct link to the persistent config when present.
- `name`, `preview`, `status: {type, activeFlags?}`, `createdAt`, `updatedAt`, `recencyAt`.
- `model`, `modelProvider`, `reasoningEffort`, `historyMode`.
- `originator`, `source`, `threadSource`, `canAcceptDirectInput`.
- `ephemeral`, `section`, `sectionEnteredAt`, `projectId`, `extra`, `path`, `cwd`, `cliVersion`, `gitInfo`.
- `agentNickname`, `agentRole`, `daybreakEnabled`.

Timestamp values observed on threads are epoch seconds. Many metadata fields were null. Detail responses use `{thread: {...}}`; list responses use `{data: [...], nextCursor, backwardsCursor}`.

### Turns

```json
{
  "data": [{
    "id": "<turnId>",
    "items": [],
    "itemsView": "notLoaded",
    "status": "<status>",
    "error": null,
    "startedAt": 0,
    "completedAt": null,
    "durationMs": null
  }],
  "nextCursor": null,
  "backwardsCursor": null
}
```

`itemsView=notLoaded` returns turn metadata with empty item arrays. `itemsView=full` independently returned populated items, including a completed turn containing 120 items. Therefore an empty `items` array with `notLoaded` does not mean the turn has no history. Turn timestamp units and all status variants still need checking.

Observed item discriminators and fields:

| `type` | Fields beyond `type` and `id` |
| --- | --- |
| `userMessage` | `clientId`, `content[]` with `type`, `text`, `text_elements` |
| `agentMessage` | `text`, `phase`, `memoryCitation`, `delivery`, `questions` |
| `mcpToolCall` | `server`, `tool`, `status`, `arguments`, `appContext`, `mcpAppUi`, `pluginId`, `readOnlyHint`, `result`, `error`, `durationMs` |
| `reasoning` | `summary`, `content` |
| `contextCompaction` | No additional fields in the inspected example |

The discriminator inventory is partial. The inspected completed turn used `status: "completed"`. Diffs and review remain unverified. Steering acceptance and interruption are verified below. New-thread creation against a config is verified below. Follow-up and its live notifications are verified above.

## Models and collaboration modes

Model metadata fields include `id`, `model`, `displayName`, `description`, `hidden`, `isDefault`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`, `supportsPersonality`, `multiAgentVersion`, `additionalSpeedTiers`, `serviceTiers`, `defaultServiceTier`, `upgrade`, `upgradeInfo`, `availabilityNux`, `modelSpecialty`, and `availableAccessPrograms`.

The independent model-list probe returned 11 entries. Avoid hardcoding the result; use this endpoint to populate supported model/reasoning/service-tier choices.

Collaboration modes return `{data: [{name, mode, model, reasoning_effort}]}`. Model and collaboration-mode objects mix camelCase and snake_case; use endpoint-specific wire types.

## Secrets and VPN metadata

Personal-secret metadata returned `env_var`, `target: {type}`, `id`, and `name` in the non-sensitive namespace. The sensitive namespace and config/draft secret arrays were empty in inspected responses. Secret value transport and write formats are unknown.

VPN reads include `connection`, `capabilities: [{provider, auth_methods}]`, `tcp_network_access_supported`, `base_version_id`, and `draft_revision`; draft-specific reads also include `draft_id`. The captured connection was null. VPN configuration/authentication methods are untested.

## Rewrite implications

1. Retain the existing OAuth/token-store mechanism initially. Cookie-free reads and a config PATCH are verified; refresh still needs a smoke test when required.
2. Replace transport path-prefix assumptions with exact versioned paths and host selection.
3. Model environment configs, versions, drafts, operations, runtime environments, threads, and turns separately.
4. Separate published metadata edits from draft edits and asynchronous publication. Track revisions and operation outcomes.
5. Replace legacy task-history mappers with thread/turn/item wire contracts. Preserve explicit `itemsView` semantics.
6. Use the verified cloud app-server WebSocket transport, use the verified resume/follow-up sequence and notification routing. Config allocation and interruption are verified below; validate additional options before expanding task inputs.

Legacy probes returned 200 for `/backend-api/wham/environments` and `/backend-api/wham/tasks/list?limit=1&task_filter=current`. This verifies reachability only. It does not prove legacy tools can manage new configs or threads.

## Open investigation items

- Verify additional model/service-tier options, runtime overrides, and onboarding. Published-config task allocation is independently verified.
- Test steering behavior beyond request acceptance and stale-turn conflicts. Follow-up, notification streaming, persisted history, and interruption are verified.
- Capture publication failures and cancellation; success and published script/skill readback are verified.
- Determine whether singular draft edits survive opening an explicit editing runtime.
- Capture onboarding with `start_onboarding: true`, plus failure/retry behavior.
- Test draft conflicts and idempotent operation retries in an isolated config.
- Resolve repository discovery, deletion/archive, and secret writes. Config cursor pagination is verified.
- Determine task result/diff/PR mappings and migration behavior for legacy tasks.

## SDK rewrite live validation

The installed app serializer `Yr` in `.vite/build/src-ghAWefM3.js` transforms a saved-config thread start into a cloud-only environment selection. Unlike the local CLI schema, it accepts `environmentConfigId` rather than a preallocated runtime ID, clears top-level cwd/root overrides, sets `deferredEnvironment: true`, and adds `pluginsMcp: {productSku: "codex"}`. An onboarding selection uses `onboardingConfigId` instead; that variant is source-derived and not yet independently exercised.

Independently verified new-thread request:

```json
{
  "id": 2,
  "method": "thread/start",
  "params": {
    "environments": [{"environmentConfigId": "<publishedConfigId>"}],
    "deferredEnvironment": true,
    "pluginsMcp": {"productSku": "codex"}
  }
}
```

The result contains `thread` plus configuration fields similar to resume. Follow it with `turn/start` using the returned `thread.id`. A task against the existing test config completed and returned the exact requested reply. No runtime ID or environment allocation HTTP call was necessary.

The rewritten SDK then passed an isolated live flow using cookie-free OAuth:

1. Created config `MCP rewrite smoke <timestamp>` with repository refs copied from the test config, `network_policy: {type: "unrestricted"}`, and `start_onboarding: false`.
2. Opened an explicit editing draft and read its base version/revision.
3. Saved an install script and start skill with the expected revision guard.
4. Began publication with a persisted UUID idempotency key, polled the same operation to `SUCCEEDED`, and completed using the editing thread ID.
5. Re-read the config and verified both published strings and `version_id === latest_ready_version_id`.
6. Created a new task using that published config and verified the completed persisted reply `rewrite task received`.
7. Resumed the same thread, sent a follow-up, and verified the completed persisted reply `rewrite follow-up received`.
8. Read `/v2/threads/{threadId}/items?turnId={turnId}&limit=10&sortDirection=desc`; it returned the follow-up's two persisted items.

SDK smoke identifiers and intermediate state are saved privately in `/tmp/codex-cloud-investigation/rewrite-smoke-state.json`; this allows subsequent probes to reuse the same config and thread. The source credential was read in memory, with no refresh or source-file write. These requests used the Node-compatible `ws` transport under Bun; compiled Node and Worker checks are recorded below.

### Node transport, steering, interruption, and Worker verification

With the same OAuth token, URL, account header, and user agent, Node native `fetch` returned HTML HTTP 403 for turn history, while `node:https` returned 200. Three user-agent variants preserved that difference. This identifies a transport-dependent response but does not isolate its cause. The Node default now uses native HTTP streaming with manual redirects; `fetch` remains injectable and the Worker uses its existing egress binding.

The compiled Node SDK opened the authenticated socket, resumed the isolated smoke thread, and accepted `turn/steer` with `{threadId, expectedTurnId, input}`. The response was `{turnId}` matching the requested active turn. Model generation already in progress continued; immediate steering effect and exact reply behavior were not verified. The probe later requested interruption with `turn/interrupt` and `{threadId, turnId}`. The response had no task payload, and independent HTTP history confirmed `status: "interrupted"` for that exact turn. SDK cancellation therefore reports `interruptRequested`, rather than claiming the request itself proves termination.

An active-thread `turn/start` returned the existing active turn ID during testing. The SDK follow-up path now rejects a resumed thread with `status.type === "active"`, directing callers to steer the expected turn or wait first. This avoids treating an active-turn input as a new follow-up turn.

A separate compiled Node follow-up completed with persisted reply `node follow-up received`, with 17 matching thread notifications. Results are in `/tmp/codex-cloud-investigation/node-followup-results.json` and `/tmp/codex-cloud-investigation/node-interrupt-results.json`.

The Worker was tested locally through Wrangler with the configured **remote VPC egress binding**, local KV, and a temporary non-production admin value. The admin token was not written to project configuration. A real MCP connection listed 25 tools, read the published smoke config through egress, sent a follow-up over an HTTP-to-WebSocket upgrade through the same binding, closed the request's socket, and independently polled HTTP history to verify `worker follow-up received`. This verifies the actual Worker runtime/egress upgrade path, not only a mocked factory. No production Worker deployment was performed.

A final read also confirmed the smoke thread retained the selected config in `environments[].environmentConfigId`, its runtime ID was distinct, the published version matched the saved version, and the thread was idle.

The real compiled Node CLI was then connected through MCP stdio using the source auth file without refreshing it. It listed 25 tools, verified distinct one-entry config pages using `next_cursor` as the next request's `cursor`, sent a follow-up, and independently read the completed reply `stdio follow-up received`. Its MCP transport closed cleanly. Results are in `/tmp/codex-cloud-investigation/stdio-live-results.json`.

The stdio runtime closes both MCP and cloud resources on input EOF, transport closure, SIGINT, and SIGTERM. Child-process tests exercise EOF and SIGTERM after opening a retained cloud connection. Final `mise run check` passed 66 tests, lint, Node and Worker types, the Node build, and the Worker dry-run build. `mise run pack` verified generated package contents. The local Worker token seed was deleted with explicit `--local` scope and the development server was stopped. No release or production deployment was performed.

## Local artifacts

- `/tmp/codex-cloud-investigation/probe-results.json`: initial read/authentication status and response shapes.
- `/tmp/codex-cloud-investigation/probe-more-results.json`: config PATCH, thread pagination/history, and legacy route probes.
- `/tmp/codex-cloud-investigation/history-schema.json`: populated history item shapes without message contents.
- `/tmp/codex-cloud-investigation/operation-results.json`: successful publication, published config readback, runtime authentication, and missing-thread error.
- `/tmp/codex-cloud-investigation/followup-results.json`: private RPC/notification trace for the successful follow-up.
- `/tmp/codex-cloud-investigation/followup-verification.json`: independent persisted history confirmation and notification inventory.
- `/tmp/codex-cloud-investigation/ws-probe-results.json`: successful OAuth WebSocket handshake, initialization, model read, and clean close.
- `/tmp/codex-cloud-investigation/ws-current.har`: private presence-channel capture used to distinguish it from the cloud socket.
- `/tmp/codex-cloud-investigation/app-server-schema/`: bundled CLI protocol schemas for validating candidate RPC formats.
- Temporary probe scripts read the local access token in memory and never print it. Raw HAR files stay outside the repository.


## Web personal vault capture (2026-10-01)

Captured in connected Chrome at `https://chatgpt.com/settings/codex-cloud?tab=personal-vault`, with Proxyman CLI HAR exports kept privately under `/tmp/codex-cloud-investigation/vault-*-1001.har`. The web client proxies requests through `https://chatgpt.com/api/codex-cloud`; the corresponding direct cloud routes were independently verified with cookie-free OAuth writes below.

- `GET /v1/personal-secrets?namespace=not_sensitive` lists environment variable metadata.
- `GET /v1/personal-secrets?namespace=sensitive` lists network secret metadata.
- Both create and update use `POST /v1/personal-secrets` with `{namespace, secrets: [...]}`.
- Create entries contain `{name, env_var, value, target}`. Updates additionally contain the existing `id`.
- Captured selected-environment target is `{type: "environment_config_ids", ids: ["<configId>"]}`. Existing global variable metadata uses `{type: "all_environment_configs"}`.
- POST response is `{secrets: [{id, name}]}` and contains no values. Subsequent lists return `{id, name, env_var, target}` with `next_cursor`.
- UI scope selection allows up to 100 configs. Tests used only the isolated `MCP rewrite smoke` config and dummy keys `MCP_CAPTURE_VAR_1001` and `MCP_CAPTURE_SECRET_1001`; existing credentials were untouched.
- Environment variables expose their real value to task tools where the environment requests the key. Network secrets expose a placeholder, which is replaced in outgoing requests to domains allowed by the environment. This behavior is described by the UI; runtime substitution is not yet verified.
- Secret edit form keeps saved values hidden and says blank preserves the value. Variable edit attempted to load its value but showed a failure; no working value-read request has been established.

Captured create body (values and IDs replaced):

```json
{"namespace":"sensitive","secrets":[{"env_var":"EXAMPLE_SECRET","target":{"type":"environment_config_ids","ids":["<configId>"]},"name":"EXAMPLE_SECRET","value":"<value>"}]}
```

Captured replacement body:

```json
{"namespace":"not_sensitive","secrets":[{"id":"<secretId>","name":"EXAMPLE_VAR","value":"<replacement>","env_var":"EXAMPLE_VAR","target":{"type":"environment_config_ids","ids":["<configId>"]}}]}
```


### Direct OAuth writes and environment attachments

Cookie-free requests to `https://codex-cloud-backend.chatgpt.com/v1/personal-secrets` successfully replaced both captured dummy values using the existing MCP OAuth access token and account header. Responses retained each entry ID, and independent metadata reads contained no values. A web metadata-only network-secret edit omitted `value` and returned 200; `name` retained the original label while `env_var` changed to the renamed key.

Shared environment values use a separate storage operation before saving the draft:

```json
POST /v1/environment-values
{"namespace":"proxy","name":"EXAMPLE_SECRET","value":"<value>"}
```

`namespace: "runtime"` stores a direct environment variable instead. Both return `{id: "sec_...", name}` without the value. The web draft saves reference these opaque IDs:

```json
{"base_version_id":"<base>","expected_revision":2,"secrets":[{"id":"<valueId>","name":"EXAMPLE_SECRET","source":"environment","target":{"environment_variable":"EXAMPLE_SECRET","allowed_domains":["example.com"]}}]}
```

```json
{"base_version_id":"<base>","expected_revision":3,"runtime_requirements":[{"source":{"type":"user_provided"},"optional":true,"delivery":{"type":"direct_environment_variable","variable_name":"PERSONAL_VAR"}},{"source":{"type":"vault_secret","id":"<valueId>"},"optional":false,"delivery":{"type":"direct_environment_variable","variable_name":"SHARED_VAR"}}]}
```

The UI calls shared values `Environment` (all users of the environment can use the value) and personal requirements `Personal` (each user supplies their own key). Draft `runtime_requirements` and `secrets` are lists of attachments, not plaintext value maps. Read and preserve unrelated entries before replacing either list. Domain input accepts exact hostnames and says an empty domain list sends the network secret to no site. The test draft was saved without publishing; original published config remains intact.


### SDK/MCP verification

The SDK now provides `savePersonalSecrets(namespace, entries)` and `createValue(input)`. MCP exposes `save_personal_secrets` and `create_environment_value`; `update_environment_draft` accepts typed shared `secrets` and variable `runtime_requirements`. Mutation results explicitly return IDs/names without upstream extra fields. New personal entries require a value; existing entries can omit it.

Live cookie-free OAuth checks stored `runtime` and `proxy` shared values, saved their references against the current draft revision, and independently read both IDs back from the draft. Revision advanced to 6 and the published config version remained unchanged. Evidence is private in `vault-direct-results.json` and `vault-shared-direct-results.json`. Replacing a shared variable in the web UI creates a new value ID and replaces the draft reference, rather than updating the stored value in place.

`mise run check` passed 69 tests, lint, types, Node build, Worker types, and Worker dry-run build. No release or deployment was performed. Dummy personal vault entries and the saved smoke draft remain available for inspection. Deletion, value reads, and runtime substitution remain unverified. Personal network-secret attachments were subsequently captured and implemented below.


### Personal network-secret requirements

After the browser connection recovered, the web saved this additional draft secret with HTTP 200:

```json
{"name":"PERSONAL_SECRET","source":"user_provided","optional":true,"target":{"environment_variable":"PERSONAL_SECRET","allowed_domains":["example.com"]}}
```

There is no stored-value ID in a personal requirement. The user's vault supplies the matching key, subject to its config target. The same save preserved the shared secret ID with `source: "environment"` and `optional: false`. SDK/MCP draft secret types now include both variants and preserve the optional flag. Unknown future attachment variants are rejected by MCP; callers must not work around validation by sending only a subset of an existing list.


Compiled Node SDK also saved the captured personal/shared secret list through direct OAuth, re-read both variants and domain restrictions, and verified the published version was unchanged (draft revision 8). Results are private in `vault-personal-attachment-results.json`. Final checks passed 69 tests with 240 assertions and all configured build/type/lint gates. Saved browser proof is private in `vault-draft-proof.png`.


## Exact web Save and publish action

Clicked the `Save and publish` conversation button on the isolated smoke editing thread. With no unsaved changes, it sent explicit-draft `POST .../approve/begin` with `expected_revision: 8` and a UUID `idempotency_key`, polled its environment operation, then sent `POST .../approve/complete` with the operation ID and editing thread ID. Both POSTs returned 200. The UI changed from `Publishing` to `Environment published`. No extra draft PATCH was required for this already-saved draft. Captures are private in `save-and-publish-start-1001.har` and `save-and-publish-complete-1001.har`. This matches the SDK publication sequence; independent published-version readback is still required before reporting activation programmatically.

## Conversational onboarding follow-up

The user identified the initial setup message as `Use Cloud Environment Onboarding: Setup to set up this cloud environment`. A newly captured web creation of the user-created outnite config still sets `start_onboarding: false`. The flag alone therefore does not reproduce the observed web flow. Installed app serialization selects `environments: [{onboardingConfigId: configId}]` for the setup thread. A cookie-free RPC probe with this selection rejected `thread/start` with `environment onboarding requires a durable thread/start` before returning a thread ID. No setup turn was sent for that failed allocation. The isolated onboarding config ID is recorded privately in `onboarding-smoke-state.json` for reuse.


Independent published-config readback confirmed a new version equals `latest_ready_version_id` and retains personal/shared variable and network-secret attachments after the exact web button completed. Evidence is `published-vault-readback.json`.

### Captured web onboarding thread start

Created an additional isolated web setup environment against the smoke repository to observe the actual socket request. The web sent `thread/start` with `serviceName: "codex_cloud"`, `threadSource: "user"`, `environments: [{onboardingConfigId: configId}]`, `deferredEnvironment: true`, and `pluginsMcp: {productSku: "codex"}`. Other fields included model selection, nullable defaults and UI feature overrides. The initial user message is the named setup skill instruction above. A second direct probe adding only `historyMode: "paginated"` and `ephemeral: false` still failed the durable-thread precondition; those fields alone are insufficient. Raw browser network events stay private in `browser-onboarding-network.json`.


The direct onboarding start succeeded after adding the captured `serviceName: "codex_cloud"` and `threadSource: "user"`. It returned a thread/runtime and accepted a setup turn. The web subsequently sent `turn/start` with two text items, repository-name/ref context followed by `Use $cloud-environment-onboarding:setup to set up this cloud environment`. The visible display expands that skill identifier into `Cloud Environment Onboarding: Setup`. The web setup agent explicitly reported using the setup skill and was observed inspecting repository build/configuration files.

SDK `tasks.setupEnvironment({environmentConfigId})` and MCP `start_environment_setup` use the durable service selection and canonical skill instruction. They return thread/turn IDs and do not publish automatically. Existing follow-up, interruption, and history APIs apply to the setup conversation. Config creation and setup allocation remain separate steps so a failed or unknown setup start does not silently recreate a config.


Compiled Node SDK `tasks.setupEnvironment()` launched its own isolated config using the canonical skill invocation. The task retained its config ID and persisted its initial turn after a brief delay; an immediate history read had been empty. Socket resume also succeeded. The web UI independently showed that SDK-created task using the onboarding skill, inspecting repository configuration, identifying the Phoenix/SQLite/Elixir/OTP/Bun workflow, and beginning tool installation. This verifies actual repository discovery, not just an accepted socket request. It remains an asynchronous agent task; publication is a separate operation after reviewing the generated configuration. State and progress metadata are private in `onboarding-sdk-state.json` and `onboarding-sdk-read-results.json`.

Final checks passed 70 tests with 244 assertions plus all configured type/build/lint gates. The combined review approved the variable/secret and onboarding additions. The exact Save and publish capture has independent published-version readback proving activation. Runtime secret substitution and deletion/value-read APIs remain outside the verified scope.

The SDK-created onboarding agent also saved draft configuration while investigating tool installation. After verifying skill execution, repository discovery, and draft preparation, its test turn was interrupted through the SDK; persisted history confirmed `interrupted`. The earlier two isolated onboarding test turns were also stopped. The test configs and dummy vault entries remain available for inspection. Browser proof is private in `onboarding-sdk-proof.png`; stop verification is in `onboarding-sdk-stop.json`. A final `mise run check` passed all 70 tests and configured gates, and `git diff --check` passed. No release or deployment was performed.

## User-requested Kikuyo onboarding trial

Resolved `dvcrn/kikuyo` through GitHub to repository ID `1183961938` and default branch `main`. No existing user-scope config referenced this repository. Created a private `kikuyo` config with `repositories: [{repository_id: "github-1183961938", ref: "main"}]`, the SDK default package-manager network policy, and `start_onboarding: false`, then invoked `tasks.setupEnvironment()` on the returned config ID. State was saved between mutations so an unknown setup result does not trigger duplicate config creation.

Config ID: `471458c8-c98d-4154-83ff-a46a102c0282~asenvcfg_cb100b0f0cf08191991c15528e62183c`. Setup thread: `01a0f752-dc9b-7660-947e-8e5c2563709f`. Turn: `01a0f752-ec06-7563-8126-90d30b2ad18d`. HTTP readback confirmed the selected config and persisted canonical skill instruction with turn status `inProgress`. The browser independently showed the onboarding skill running and identifying Phoenix, PostgreSQL, pinned Erlang/Elixir, and Bun. The agent is preparing and validating the workflow asynchronously; it has not been reported as completed or published. This user-requested setup remains running. Private state/proof are `kikuyo-setup-state.json` and `kikuyo-onboarding-proof.png`.

## Existing-environment editing investigation (2026-10-04)

**Captured and probed:** an empty-body `POST /v1/environment-configs/{id}/drafts`
allocates a draft, editing runtime, and thread. A read-only agent turn in that
thread successfully called `cloud_environment_onboarding.read_environment_config_draft`
and returned the exact allocated draft ID. The update tool was also available.
The API provides real draft-editing context; a missing sidebar icon does not
establish that it created an ordinary task runtime.

**Probed:** the published config can report `draft: null` while the explicit
`GET /v1/environment-configs/{id}/drafts/{draftId}` returns its editing-session
draft. Retain the original config ID, draft ID, thread ID, and editing runtime;
do not substitute the source config ID or published runtime.

**User-observed:** allocating, naming, and resuming an editing thread did not
initially make it visible in the sidebar. After its first read-only turn it
appeared, but lacked the environment-edit icon. This remains unresolved.

**Client source:** the inspected desktop client stores a separate mapping in
`environment-setup-server-configs-v1`, keyed by thread ID, containing config,
draft, runtime, account, and user IDs. The sidebar checks that mapping. Desktop
writes use persisted-atom messages backed by local application state. This does
not establish how the web client persists the association or whether a server
API can register it. The uploaded WebSocket capture contains name/resume calls
but no corresponding HTTP state-persistence evidence.

**Captured:** native UI-created editing threads also had null `threadSource`
and lacked `environmentConfigId`. Neither field is a reliable standalone test
of native editing registration. Adding a title is not proof of registration.

The MCP must support the editing lifecycle without requiring a UI handoff.
Backend draft creation and publication are supported. The config-owning editor
path verified below provides automatic sidebar registration. Unit tests
of REST routing cannot establish UI visibility or classification.

### Local investigation, 2026-10-04

**Web source:** Proxyman identified the current ChatGPT web bundle
`https://chatgpt.com/cdn/assets/async/385910.71a81f043e.js`. Its browser host
handles `persisted-atom-update` by updating IndexedDB database
`codex-browser-host`, object store `records`, record
`codex.browser.persistedAtomState`. The editing association is the
`environment-setup-server-configs-v1` entry within that record. This write does
not use the cloud thread API.

**Two registration paths:** the editor first reads this association by thread
ID. If absent, it fetches the config identified by the thread's
`environmentConfigId` and accepts it only when the config's `thread_id` matches.
That recovery path sets `publicationStateUnknown: true`. It explains why a
config-owning setup task can retain its setup classification in another client;
it does not recover a separate editing-session draft/runtime association.

**Independent browser comparison:** Chrome's native Edit action on the dedicated
regression config created an editing thread with the setup icon, environment
panel, and Save and publish button. Opening that exact thread from Dia's sidebar
showed a plain cloud chat without those controls. Chrome still showed them.
Dia retained the setup icon for the existing `Set up codex` task. No turn was
submitted and neither draft nor published settings were changed during this
comparison. Reloading both browsers preserved the editing-task difference;
Proxyman captured successful page requests from both clients.

**Cloud metadata:** both authenticated HTTP reads and WebSocket `thread/resume`
returned the native-created editing runtime without `environmentConfigId` or
`threadStartKind`, with null `threadSource` and `extra`. The current app-server
metadata-update schema provides Git metadata, project assignment, and Daybreak
fields, without an environment-editor registration field. No equivalent cloud
registration operation has been identified for separate editing sessions.

**Native turn metadata probe:** the web request serializer supports
`productMetadata.environment_onboarding` with `environment_config_id`,
`draft_id`, and `expected_draft_id` for draft replacement on `turn/start`.
A read-only turn using those fields completed and the onboarding draft-read
tool returned the exact editing draft at revision 1. Independent Worker reads
still showed no thread config association, and refreshing Dia still produced
a plain chat without environment controls. These fields are not verified as
a native UI initialization mechanism. The agent reported an internal runtime
config ID, so callers must retain the original persistent config ID rather
than replacing it with that agent response.

**Verified config-owning editor path:** `thread/start` with the published config
as `onboardingConfigId`, `serviceName: "codex_cloud"`, `threadSource: "user"`,
and `deferredEnvironment: true` persists the thread/config association even
without an agent turn. `PATCH /v1/environment-configs/{id}/draft` with the
published `base_version_id` and unchanged `repositories` initializes its draft.
No `expected_revision` is supplied for initialization; a supplied revision or
an existing pending draft produces HTTP 409. Subsequent saves retain revision
guards. After reload, Dia displayed the setup icon, actual environment editor,
and Save and publish control through server recovery alone. A read-only agent
turn returned the exact initialized draft ID, revision, and published base.

The deployed APIs independently saved this draft and published the dedicated
regression config through begin, polling, and config-scope completion. Readback
confirmed ready revision 4 and the intended install-script comment. The native
editor can be reopened by reusing the config's owning thread and initializing
another draft from the latest published version. Retain existing pending drafts
and reject stale bases rather than replacing unpublished work.
