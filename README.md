# opencode-prompt-archive

[![CI](https://github.com/tresdos/prompt-history/actions/workflows/ci.yml/badge.svg)](https://github.com/tresdos/prompt-history/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [OpenCode](https://opencode.ai/) plugin that automatically saves prompts and complete assistant responses as Markdown, so you keep a searchable record of every development session without copying anything by hand.

- Captures user prompts and full assistant responses.
- Records session ID, agent, timestamps, outcome, tools used, and changed files.
- Links each prompt and its response with a shared `interaction` ID.
- Organizes records into dynamically named session folders.
- **Never overwrites** existing files.
- Marks interrupted and failed interactions as incomplete.
- Redacts common credential formats before anything reaches disk.

## Install

### From GitHub (recommended until npm publication)

```sh
opencode plugin add github:tresdos/prompt-history#main
```

OpenCode installs the package, reloads it, and keeps it pinned to that branch. To update later:

```sh
opencode plugin update opencode-prompt-archive
```

### From a local checkout

```sh
git clone https://github.com/tresdos/prompt-history.git
opencode plugin add ~/Documents/Apps/prompt-history
```

### Project-level configuration

Instead of the CLI, add the plugin to `opencode.json(c)` in your project (or to your global config to use it everywhere):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-prompt-archive"]
}
```

Plugins under `.opencode/plugins/` or `~/.config/opencode/plugins/` are also discovered automatically.

### Verify it loaded

```sh
opencode plugin list
```

You should see `opencode.prompt-archive`. Config changes reload automatically; use `/reload` in the TUI to force a refresh.

## What it writes

By default, records go to `docs/prompt-history/` in the current project:

```
docs/prompt-history/
  0001-initial-architecture/
    01-plan-prompt.md
    02-build-result.md
  0002-add-login/
    01-add-login-prompt.md
    02-build-result.md
```

- Folder names are `NNNN-<session-title>`, numbered in order.
- File names are `NN-<prompt-slug>-prompt.md` and `NN-<agent>-result.md`.
- Subagent sessions share the root session's folder.
- Prompt and result files share the same `interaction` frontmatter value:
  `"<sessionID>::<userMessageID>"`.

Example prompt file:

```markdown
---
kind: "prompt"
interaction: "ses_123::msg_456"
session_id: "ses_123"
parent_session_id: ""
root_session_id: "ses_123"
agent: "build"
timestamp: "2026-11-25T12:00:00.000Z"
status: "complete"
title: "add-login"
---

# Prompt — add-login

Implement the login form.
```

## Options

Pass options in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-prompt-archive",
      "options": {
        "directory": "docs/prompt-history",
        "includeReasoning": false,
        "includeTools": true,
        "includeChangedFiles": true,
        "maxChangedFiles": 200,
        "maxTextChars": 100000,
        "verbose": false,
        "warnOnCredentialPermission": false,
        "force": false,
        "datePrefix": false,
        "maxParentDepth": 32,
        "dryRun": false,
        "export": {
          "format": "md",
          "outFile": "ARCHIVE.md",
          "dateFrom": "2026-01-01",
          "agent": "build",
          "status": "complete",
          "text": "login"
        }
      }
    }
  ]
}
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `directory` | string | `docs/prompt-history` | Output root. Relative paths resolve against the project directory; absolute paths are used as-is. |
| `includeReasoning` | boolean | `false` | Include assistant reasoning blocks in result files. Off by default to keep archives small and private. |
| `includeTools` | boolean | `true` | List tool names used by the assistant. |
| `includeChangedFiles` | boolean | `true` | Record changed files from the assistant snapshot. |
| `maxChangedFiles` | number | `200` | Maximum number of changed-file paths per result. `node_modules/` and `.git/` paths are always excluded. |
| `maxTextChars` | number | `100000` | Maximum characters per prompt/response body. Longer bodies are truncated with a visible marker. Set `0` to allow only the marker. |
| `verbose` | boolean | `false` | Log the output directory once at plugin load. |
| `warnOnCredentialPermission` | boolean | `false` | Warn (stderr + `SECURITY-WARNINGS.md` in the archive) when a permission request looks credential-related. See below. |
| `force` | boolean | `false` | Re-record messages even if their IDs were already seen. Useful after deleting an archive file. |
| `datePrefix` | boolean | `false` | Name new session folders `YYYY-MM-DD-NNNN-<title>` for chronological sorting. |
| `maxParentDepth` | number | `32` | Maximum `parentID` hops when resolving a subagent's root session. |
| `dryRun` | boolean | `false` | Log the files that would be written without creating or modifying anything. |
| `export` | object | unset | Generate a consolidated, searchable export file. See below. |

### Consolidated export

Set `export` to generate a single file containing every recorded interaction, filtered by `dateFrom` / `dateTo` (YYYY-MM-DD), `agent` (substring), `status` (`complete` or `incomplete`), and `text` (case-insensitive substring of prompt or response). `format` is `md` (default) or `jsonl`; `outFile` defaults to `ARCHIVE.md`. The file is regenerated after each session, so filter changes on reload take effect immediately. All content is redacted before writing.

An `INDEX.md` in the archive root lists every recorded session with links to its prompt and result files. It is regenerated after each session; session records themselves are never overwritten.

Invalid option values fall back to the defaults with a warning; they never stop recording.

### Credential-request warnings

Set `warnOnCredentialPermission: true` to be notified when the agent asks for permission to do something that looks credential-related — for example reading a `.env` file, an `~/.aws/credentials` file, or a shell command that exports a token. The plugin:

- logs a warning to stderr with the reason and sanitized resource path;
- appends a sanitized entry to `SECURITY-WARNINGS.md` in the archive root (never overwriting prior entries);
- records the user's reply (`once` / `always` / `reject`) when available.

This is a **heuristic**, not a security guarantee. It only sees the action, resource paths, and message carried by the permission event — never actual secret values — and cannot detect reads the agent is already allowed to make. Treat it as a notice to review the archive, not as a barrier. See [SECURITY.md](SECURITY.md) for details.

## Privacy and safety

Read this before using the plugin with sensitive work.

- **Full prompts and responses are written to disk.** The archive is a plaintext transcript of your sessions. Protect the output directory accordingly and consider adding it to `.gitignore` if you do not want it committed.
- **Redaction is pattern-based.** API keys, bearer tokens, provider token prefixes (OpenAI, Anthropic, Stripe, GitHub, Slack, AWS, Google), JWTs, SSH key blobs, private-key blocks, URL userinfo (`scheme://user:password@host`), and `key=value` / JSON credential assignments (including compound names like `MY_API_KEY=` and `SECRET_TOKEN=`) become `[REDACTED]` in both prompt and result text, including reasoning and filenames. Credential-bearing file paths (`.env`, `.aws/`, `.ssh/`, `credentials`, `secrets`, `.pem`/`.key`) are excluded from `changed_files`. This cannot catch every secret format and does not detect PII (phone numbers, SSNs, card numbers) — **do not paste real credentials into a prompt**. See [SECURITY.md](SECURITY.md) for the full threat model.
- The plugin never reads `.env` files and never spawns shell commands or child processes.
- It never modifies source files or agent instructions. It only creates new files under the configured directory.
- An agent recommendation is recorded verbatim; the plugin never treats it as an approved human decision.

## How it works

- Subscribes to the OpenCode event stream and reacts to `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`, and `session.idle`.
- Reads `ctx.session.context()` as the source of truth and records only messages whose IDs have not been seen before. Deduplication state is stored via `ctx.storage`.
- Groups each user prompt with the assistant messages that follow it. A later step of an already recorded turn adds another result file pointing at the original prompt instead of inventing a new prompt.
- Writes with exclusive creation (`wx`): an existing file is never rewritten, and a colliding number is bumped instead.
- Interrupted and failed executions are written with `status: incomplete` and the matching `outcome`.

## Compatibility

Tested with **OpenCode 2.4.1**. The plugin uses the V2 server plugin API (`@opencode/plugin`) and ships TypeScript source directly, matching the [official plugin guide](https://opencode.ai/docs/build/plugins). No build step or runtime dependencies are required.

`@opencode/plugin` is a dev dependency used for type checking; OpenCode provides it at runtime.

## Known limitations

- OpenCode 2.4.1's `event.subscribe({ types })` filter delivered no events in testing, so the plugin subscribes to all events and filters explicitly.
- `session.idle` is not reliably emitted for short-lived CLI runs, so `session.execution.succeeded` is also a trigger. A multi-step turn can produce several result files that share one prompt file.
- If OpenCode crashes mid-turn, that turn may not be recorded.
- `changed_files` comes from the assistant snapshot and is best-effort.
- Only server-part events are observed; TUI-only interactions that never reach the server cannot be recorded.

## Development

```sh
pnpm install
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run pack:check
```

Tests use Node's built-in runner and Node's TypeScript stripping (Node 24 recommended). No test framework is needed. `pack:check` writes the tarball to `$PACK_DEST` (defaults to a local temp dir); `pnpm run format` applies the Prettier config.

## License

[MIT](LICENSE) © 2026 Luis Juarez
