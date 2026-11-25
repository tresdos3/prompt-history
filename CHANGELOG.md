# Changelog

## Unreleased

### Added

- Consolidated searchable export (`export` option) with Markdown/JSONL output and filters by date, agent, status, text, and tag.
- Local git branch/commit metadata in result frontmatter and `INDEX.md`, read directly from `.git` files.
- Custom `promptTemplate` / `resultTemplate` Markdown body templates.
- Per-session `TRANSCRIPT.md` with chronological prompt → response blocks (`includeTranscript`, `transcriptName`).
- Retention pruning with `retentionDays` / `maxSessions`, including storage-state cleanup.
- Session tags via `autoTags` and `#hashtag` extraction (`tagFromTitle`).
- Per-project namespacing (`includeProjectName`) for global configs.
- Pause recording via `paused` option or a `.paused` sentinel file.
- Credential-request warnings (`warnOnCredentialPermission`) with `SECURITY-WARNINGS.md`.
- `dryRun` mode, `force` re-record, `datePrefix`, `maxTextChars`, and `maxParentDepth` options.

### Changed

- Redaction now covers URL userinfo, compound env names, Stripe/JWT/SSH-key formats, and credential-bearing file paths.
- Added `INDEX.md`, Prettier formatting, integration/store tests, and a tag-driven CI pipeline.

### Fixed

- Rejected permissions now mark turns `incomplete` / `failed`.
- Pending permission state is bounded by TTL and size.
- `changed_files` filtering matches whole path components so files such as `src/tokenizer/index.ts` are retained.

## 0.1.0

- Initial release.
- Records user prompts and assistant responses as Markdown under a configurable directory (default `docs/prompt-history`).
- Prompt/response pairing via shared `interaction` frontmatter.
- Session folders named `NNNN-<session-title>`; files named `NN-<slug>-prompt.md` and `NN-<agent>-result.md`.
- Interrupted and failed executions marked `status: incomplete`.
- Pattern-based secret redaction.
- Deduplication by OpenCode message ID.
- Exclusive file creation: existing records are never overwritten.
