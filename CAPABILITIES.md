# Capability map: Codex Cloud SDK

| Module | Responsibility | Depends on |
|---|---|---|
| `auth-core` | Explicit credentials, token stores, Codex auth-file loading, OAuth refresh | — |
| `environments` | List, find, create, and partially update cloud environments | `auth-core` |
| `tasks` | Create, list, inspect, await, and extract output from cloud tasks | `auth-core` |
| `package` | Public exports, npm metadata, documentation, and verification | all modules |

Build order: `auth-core` → `environments`, `tasks` → `package`.
