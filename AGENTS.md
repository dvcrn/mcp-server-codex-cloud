# Development instructions

## Commands

- Use `mise` for project tasks.
- Run `mise run format` after editing supported source or configuration files.
- Run `mise run check` before finishing an implementation.

## Formatting

- Treat `biome.json` as the source of truth for formatting and lint rules.
- Keep one blank line between imports, declarations, and logical blocks of statements.
- Keep tightly related statements together without blank lines between every step.
- Let Biome wrap and indent code. Do not align code manually with extra spaces.
- Use braces for control flow, including single-statement branches and loops.

The Claude Code and Codex `PostToolUse` hooks format supported files after edits. The
final `mise run check` remains required because hooks do not cover every way a file can
change.

## Function documentation

- Add a one-sentence JSDoc comment to exported functions and public methods.
- Describe what the function provides and any non-obvious contract or side effect.
- Do not repeat parameter names, return types, or details already clear from the signature.
- Document private and local functions only when they enforce a non-obvious invariant.
