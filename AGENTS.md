# AGENTS.md

How to work on this repository. Full details, including the project layout, are in [`docs/development.md`](docs/development.md).

(`AGENT_INSTRUCTIONS.md` is something else: a snippet that *users* of Synapse paste into their own projects.)

## Setup

```sh
bun install
```

Develop with Bun. The published package is plain JavaScript and must run on Node.js 20 or newer without Bun.

## Before you commit

Run every check that applies to your change:

| Change | Command |
|---|---|
| Any code (`src/`, `viewer/`, `tests/`) | `bun run typecheck` and `bun run test` |
| Anything that ships | `bun run build` |
| Docs (`docs/`) | `bun run docs:build` (fails on dead links) |

Add or update tests in `tests/` for any change in behavior. CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

## Rules

- **`src/` is Node code.** Don't use Bun-only APIs there; `tsconfig.json` only allows Node types.
- **`src/model/` owns the data model.** `schema.ts` (zod) defines the types and validates all data where it enters: disk, MCP tool input and HTTP. Validate at those boundaries, not ad hoc elsewhere. `kinds.ts` has no dependencies because the browser imports it.
- **The JSON files in the data directory are the contract** between the MCP server and the viewer. New fields must be optional so existing mindmaps still load.
- **Adding a change kind** means updating `CHANGE_KINDS` in `src/model/kinds.ts`, its glyph, label and color in `viewer/`, and its glyph in `src/renderer.ts`.
- **Tests must not touch real user state.** Use a temporary `SYNAPSE_DATA_DIR`. Installer tests run with a temporary `HOME` and `PATH`.
- **Don't commit generated files or local data:** `dist/`, `data/`, `docs/.vitepress/dist/`.
- **User-facing changes need doc updates:** MCP tools in `docs/reference/tools.md`, CLI in `docs/reference/cli.md`, and the README if needed.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <summary in lowercase, imperative, no period>
```

| Type | Use for |
|---|---|
| `feat` | New user-facing behavior |
| `fix` | Bug fixes |
| `docs` | Documentation, README, docs site and branding only |
| `style` | Formatting with no behavior change |
| `refactor` | Code changes that neither fix a bug nor add a feature |
| `perf` | Performance improvements |
| `test` | Adding or fixing tests only |
| `build` | Build system, tooling, dependencies, packaging |
| `ci` | GitHub Actions workflows |
| `chore` | Anything else that doesn't touch `src/` or the tests |

Common scopes are `viewer`, `cli`, `installer`, `tools`, `model`, `store` and `docs`. Mark breaking changes with `!` (`feat(model)!: ...`) and explain them in a `BREAKING CHANGE:` footer. Use the body to explain why, not what. Keep each commit to one logical change.

## Releasing

See [Releasing in `docs/development.md`](docs/development.md#releasing). Bump `version` in `package.json`, because the MCP server reports it to clients.
