# Spec: Codex Cloud TypeScript SDK

## Objective

Build an experimental TypeScript SDK named `codex` for the internal API used by
`codex cloud`. It must support local Codex credentials and externally persisted
tokens, environment management, and cloud task execution without exposing
credentials in logs or process arguments.

## Tech stack

- TypeScript 7
- ESM targeting modern Node.js
- Native `fetch`; no runtime dependencies
- Bun for dependency management and tests
- TypeScript compiler for JavaScript and declaration output
- Biome for formatting and linting
- mise as the task runner

## Commands

- Install: `bun install`
- Check: `mise run check`
- Test: `mise run test`
- Build: `mise run build`
- Package validation: `mise run pack`

## Project structure

- `src/`: SDK source
- `test/`: mocked unit tests
- `examples/`: runnable examples
- `dist/`: generated ESM and declarations
- `API.md`: reverse-engineered protocol notes

## Public API

- `new CodexCloudClient(options)` accepts explicit credentials or a `TokenStore`.
- `CodexCloudClient.fromCodexHome(options?)` reads and updates Codex's auth file.
- Auth refresh occurs before expiration and persists rotated credentials through
  the configured token store.
- Environments: list globally/by repository, get by ID, create, and patch.
- Tasks: list, create, retrieve details, list sibling turns, wait for completion,
  and extract assistant text or unified diffs.

## Code style

```ts
const client = await CodexCloudClient.fromCodexHome();
const environment = await client.environments.create({
  label: "test",
  machineId: "wham-public/wham-universal",
  repositories: [CodexCloudClient.githubRepositoryId(12345)],
});
```

Use strict types, descriptive camelCase names, explicit exported return types,
and wire-format types only at the HTTP boundary.

## Testing strategy

- Mock `fetch` for routes, request bodies, errors, and auth refresh.
- Use temporary files for auth-file persistence and permission tests.
- Test response normalization and task-output extraction with representative
  payloads.
- Keep live tests opt-in so normal verification never mutates real resources.

## Boundaries

- Always: redact auth headers and secret values from errors; validate identifiers;
  preserve rotated refresh tokens; expose abort signals and injectable `fetch`.
- Ask first: publish to npm, delete environments, or add inferred endpoints.
- Never: bundle credentials, print tokens, run live mutation tests by default, or
  present this internal API as stable/public.

## Success criteria

- Consumers can initialize from `~/.codex/auth.json` or a custom token store.
- Expiring OAuth tokens refresh and replacements are persisted.
- Consumers can perform every environment and task operation verified in
  `API.md`.
- Build emits Node-compatible ESM and `.d.ts` files.
- Tests, type checking, Biome, and package dry-run pass through mise.

## Open questions

- npm publication ownership and final package scope.
- Stable server contracts for these undocumented endpoints.
- Delete and cache-reset routes, which have not yet been tested.
