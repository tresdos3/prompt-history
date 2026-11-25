# AGENTS.md

## What this is

OpenCode V2 server plugin (`opencode-prompt-archive`) that archives prompts and assistant responses as Markdown. Single package, no monorepo, no build step: TypeScript source is shipped directly via `package.json` `"exports"` → `./src/index.ts`. `@opencode/plugin` is a dev dependency used only for typechecking; OpenCode provides it at runtime. Do not add a bundler or emitted output without changing the export contract and CI.

## Commands

- `pnpm install` (pnpm 12 in CI; lockfile is `pnpm-lock.yaml`).
- `pnpm test` — Node's built-in test runner (`node --test`), no test framework. `pnpm run test:root` runs only `test/*.test.ts`.
- `pnpm run typecheck` — `tsc --noEmit`.
- `pnpm run pack:check` — `pnpm pack` to the pre-created OpenCode temp dir; verifies the published tarball.
- CI order: `pnpm install --frozen-lockfile` → `pnpm test` → `pnpm run typecheck` → `pnpm pack`. Release (`v*` tags) adds a check that the tag matches `package.json` version, then `pnpm publish --provenance`.

## Toolchain quirks

- Tests rely on Node's native TS stripping (`import` of `../src/core.ts` with extension). Node 24 is used in CI, 22.6+ is the declared minimum; prefer Node 24 locally.
- `tsconfig.json` uses `NodeNext`, `verbatimModuleSyntax: true`, and `allowImportingTsExtensions: true` — imports between `src/` files must include the `.ts` extension and use `import type` for type-only imports.
- No lint or formatter config exists; do not assume one.

## Architecture / execution flow

- `src/index.ts`: plugin entry. Subscribes to the event stream and filters to `session.execution.succeeded|failed|interrupted` and `session.idle` (`WATCHED_EVENTS`). Events are only triggers; `ctx.session.context()` is the source of truth.
- `src/core.ts`: pure helpers (redaction, grouping, status, markdown rendering) with no filesystem/OpenCode dependencies — unit tests target this module.
- `src/store.ts`: filesystem writes and `ctx.storage` state (seen message IDs, session-folder map, last-interaction map). Writes are exclusive (`wx`); existing files are never overwritten and numbers bump on collision.
- `src/options.ts`: option parsing. Invalid values warn and fall back to defaults rather than throwing.
- `ctx.storage` keys are namespaced `prompt-archive/*`; dedupe by message ID means state persists across runs, so clearing storage is required to re-record a session.
- Subagent sessions follow `parentID` links and share the root session's folder (`resolveRoot`).
- An assistant-only batch (no captured user prompt) is labeled with an `orphan:` pseudo-ID and written as a continuation result pointing at the previous prompt, not a new prompt file.

## Gotchas enforced by runtime behavior (do not "fix" without testing)

- `ctx.event.subscribe({ types })` delivered no events on OpenCode 2.4.1. The plugin subscribes to all events and filters in the loop. Keep it that way unless verified against a newer version.
- `session.idle` is unreliable for short CLI runs, hence `session.execution.succeeded` is also a trigger. A single turn can produce multiple result files sharing one prompt file.
- `redactSecrets()` must run **before** `slugify()` strips punctuation — removing `=`/`:` first would defeat credential patterns and leak secrets into filenames (`core.ts` `slugify`).
- Keep redaction applied to every content surface: prompt text, response text, reasoning, and filenames. Tests assert secrets never reach disk.
- File numbering is global serial work: keep updates going through the `enqueue()` promise chain in `index.ts`, otherwise two events can allocate the same number.
- Writes use `wx`, never overwrite. Changing this breaks the "never overwrites" guarantee and the tests.

## Verification / release notes

- Releases are tag-driven from `main`/`dev` pushes; version lives in `package.json`, tag must be `v<version>`.
- `pack:check` output directory is hardcoded to `/private/var/folders/cv/z4kr2kj95jgb41tjvgrpy10w0000gp/T/opencode` (pre-created temp dir); `.gitignore` excludes `*.tgz`.
- README is the user-facing source for options and behavior; keep it in sync when changing `src/options.ts` defaults or file naming.
