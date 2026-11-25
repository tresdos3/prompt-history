# Security notice

This plugin writes a **plaintext transcript** of your OpenCode sessions to disk. Read this before using it with sensitive work.

## What is protected

- **Redaction before disk.** Prompt text, assistant responses, reasoning (when enabled), and generated filenames all pass through pattern-based redaction. Recognized credential formats are replaced with `[REDACTED]` before anything is written.
- **Recognized formats include:** API keys, bearer tokens, provider token prefixes (OpenAI, Anthropic, Stripe, GitHub, Slack, AWS, Google), raw JWTs, SSH key blobs, private-key blocks, URL userinfo (`scheme://user:password@host`), and `key=value` / JSON assignments — including compound names such as `MY_API_KEY=` and `SECRET_TOKEN=`.
- **Credential-bearing paths are excluded** from `changed_files` (`.env`, `.aws/`, `.ssh/`, `credentials`, `secrets`, `.pem`/`.key`, etc.).
- **Bounded file sizes.** `maxTextChars` (default 100,000) caps prompt/response bodies with a visible truncation marker, so a single oversized output cannot create an arbitrarily large archive file.
- **No external side effects.** The plugin does not read `.env` files, spawn processes, or modify source files. Writes are exclusive (`wx`) so existing records are never overwritten.
- **Opt-in credential-request warnings.** With `warnOnCredentialPermission: true`, permission requests that look credential-related produce a stderr warning and an entry in `SECURITY-WARNINGS.md`. Warning text is passed through the same redaction.

## What is NOT protected

- **Redaction is pattern-based and incomplete.** It cannot catch every secret format. Novel token shapes, secrets split across messages, or credentials described in prose may still be written. **Do not paste real credentials into a prompt.**
- **No PII detection.** Phone numbers, SSNs, credit-card numbers, and email addresses are not redacted.
- **Warnings are heuristic.** Credential-request detection inspects only the action string, resource paths, and message of a permission event. It never sees secret values, cannot detect reads the agent is already authorized to make, and may produce false positives or miss unusual phrasings. It is a notification aid, not an access control.
- **Archives are plaintext.** Anyone with filesystem access to the configured directory can read the full transcript. Protect that directory accordingly and consider adding it to `.gitignore` if you do not want it committed.

## Recommended use

- Keep the default output directory (`docs/prompt-history`) out of version control unless you intend to commit transcripts.
- Enable `warnOnCredentialPermission` when working with unfamiliar projects or agents.
- Periodically review `SECURITY-WARNINGS.md` and the archive itself.
- Never paste real credentials, tokens, or passwords into a prompt — even with redaction enabled.

## Reporting a security issue

Open an issue in this repository describing the gap and a **synthetic** example (never a real credential). Redaction patterns and warning heuristics are easy to extend; verified gaps will be prioritized.
