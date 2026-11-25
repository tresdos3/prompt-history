# Changelog

## 0.1.0

- Initial release.
- Records user prompts and assistant responses as Markdown under a configurable directory (default `docs/prompt-history`).
- Prompt/response pairing via shared `interaction` frontmatter.
- Session folders named `NNNN-<session-title>`; files named `NN-<slug>-prompt.md` and `NN-<agent>-result.md`.
- Interrupted and failed executions marked `status: incomplete`.
- Pattern-based secret redaction.
- Deduplication by OpenCode message ID.
- Exclusive file creation: existing records are never overwritten.
