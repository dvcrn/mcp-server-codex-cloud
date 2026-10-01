# Codex Cloud MCP server

Expose cloud environment configuration, draft publication, and thread execution
over stdio and Streamable HTTP. Publish the same client as an ESM TypeScript SDK.

## Contracts

- Use ChatGPT OAuth tokens from a configurable `TokenStore`.
- Preserve rotated tokens atomically and reject stale file-store writes.
- Use exact versioned HTTP paths on `codex-cloud-backend.chatgpt.com`.
- Authenticate the cloud app-server socket with the account header and bearer
  subprotocol, initialize once, and correlate responses by request ID.
- Do not replay mutations when their outcome is unknown.
- Keep config, version, draft, runtime, thread, operation, and turn IDs distinct.
- Save drafts with base version and expected revision guards.
- Store personal vault entries or shared values without returning their values.
- Attach shared value IDs and personal variable requirements through drafts,
  preserving unrelated entries in replaced lists.
- Publish through begin, poll, complete, and published-config readback.
- Create threads from published config IDs and retain thread and turn IDs.
- Resume existing threads for follow-up, steer active turns with an expected
  turn ID, and interrupt only the requested turn.
- Read paginated turn/item history and preserve wire fields and discriminators.
- Filter live notifications by thread and turn identity.
- Keep tokens and upstream error details out of MCP errors and logs.
- Close sockets after SDK use and at the end of each Worker MCP request.

## Implementation

TypeScript ESM targets Node.js 20+. HTTP uses injectable `fetch`. Node WebSockets
use `ws`; Workers use an injected upgrade factory through `CODEX_EGRESS`.
Runtime dependencies also include the MCP server SDK, Zod, and `proper-lockfile`.
Bun manages dependencies and runs tests. Biome controls formatting.

`src/` contains the SDK, MCP tools, and CLI. `worker/` contains HTTP routing and KV
credential storage. `test/` covers transport behavior and orchestration with mocks.
`examples/` contains SDK usage. `API.md` documents the caller API and
`CODEX_CLOUD_NEW.md` tracks protocol evidence.

## Verification

Run `mise run format`, `mise run check`, and `mise run pack`. Check covers lint,
types, tests, Node build, Worker types, and Worker dry-run build. Live mutation
checks must be explicitly invoked and use isolated configs/test threads. Verify
published scripts and completed replies through independent HTTP reads.

Deployment and npm publication require an explicit user request.
