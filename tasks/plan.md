# Implementation plan

1. Establish package tooling and strict compiler/linter configuration.
2. Implement transport, errors, token stores, JWT expiry checks, and OAuth refresh.
3. Add environment operations and wire/public type normalization.
4. Add task operations, polling, and output extraction.
5. Export the SDK, document usage, and validate the npm package contents.

Risks: undocumented response drift, rotating refresh tokens, accidental secret
logging, and Bun-only output. Mitigate with permissive wire types, strict public
models, redacted errors, injected fetch tests, and Node-targeted TypeScript emit.
