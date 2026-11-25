/**
 * Pure helpers for the prompt-archive plugin.
 *
 * This module has no filesystem, network or OpenCode dependencies so it can be
 * unit tested in isolation. All content that reaches disk is redacted here.
 */

export type InteractionStatus = "complete" | "incomplete"
export type Outcome = "succeeded" | "failed" | "interrupted" | "unknown"

export interface AssistantContent {
  type: string
  text?: string
  name?: string
  state?: { status?: string }
}

/** The subset of an OpenCode session message that this plugin records. */
export interface HistoryMessage {
  id: string
  type: string
  time: { created: number; completed?: number }
  text?: string
  agent?: string
  model?: { providerID?: string; id?: string }
  content?: AssistantContent[]
  snapshot?: { files?: string[] }
  finish?: string
  error?: unknown
  outcome?: "succeeded" | "failed" | "interrupted"
}

export interface Interaction {
  prompt: HistoryMessage
  responses: HistoryMessage[]
}

/** Ordered patterns; each replacement is applied to the whole text. */
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED]",
  },
  {
    // URL userinfo: scheme://user:password@host -> scheme://user:[REDACTED]@host.
    // Runs before generic assignments so a pasted DSN is fully sanitized.
    re: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^/\s@]*)?@/gi,
    replacement: "$1$2:[REDACTED]@",
  },
  {
    // key: value / KEY=value / "key": "value" style assignments.
    // The name may have prefixes/suffixes (MY_API_KEY, SECRET_TOKEN, DB_PASSWORD)
    // but a `:` or `=` separator is still required to avoid mangling prose.
    re: /\b([a-z0-9_-]*(?:api[_-]?key|apikey|secret|password|passwd|pwd|token|auth|authorization|credential|credentials|private[_-]?key|access[_-]?key)[a-z0-9_-]*)(["']?)(\s*[:=]\s*)(["']?)(?!bearer\b)([^\s"',;#\n]+)/gi,
    replacement: "$1$2$3$4[REDACTED]",
  },
  {
    // JSON style: "api_key": "value"
    re: /(["'](?:api[_-]?key|apikey|secret|password|token|authorization|credential)\1\s*:\s*)(["'])([^"']+)\2/gi,
    replacement: "$1$2[REDACTED]$2",
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: "Bearer [REDACTED]" },
  { re: /\b(?:sk-ant-|sk_(?:proj|live|test)_|sk-)[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
  { re: /\b(?:rk_(?:live|test)_)[A-Za-z0-9]{8,}/g, replacement: "[REDACTED]" },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replacement: "[REDACTED]" },
  // Raw JWT (three base64url segments) even without a `Bearer ` prefix.
  { re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: "[REDACTED]" },
  // SSH public/private key blobs.
  { re: /\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]{20,}/g, replacement: "[REDACTED]" },
]

/** Replace credential-shaped values with a fixed marker. Never throws. */
export function redactSecrets(value: string): string {
  let out = typeof value === "string" ? value : ""
  for (const { re, replacement } of SECRET_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, replacement)
  }
  return out
}

/** Turn arbitrary text into a short, filesystem-safe slug. */
export function slugify(input: string, maxWords = 6, maxChars = 48): string {
  // Redact before punctuation is stripped: removing `=` or `:` first would
  // otherwise defeat the credential patterns and leak a secret into a filename.
  const cleaned = redactSecrets(typeof input === "string" ? input : "")
    .toLowerCase()
    .replace(/[`*_~#>/\\|{}[\]()"'!,.:;?=@+^&$%<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return "interaction"
  const words = cleaned.split(" ").slice(0, maxWords).join("-")
  let slug = words.slice(0, maxChars).replace(/-+$/, "")
  // Windows treats these as device names and forbids trailing dots/spaces.
  slug = slug.replace(/[. ]+$/, "")
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) slug = `${slug}-archive`
  return slug || "interaction"
}

export function toIso(ms: number): string {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

/** Replace `{{key}}` placeholders with values; unknown placeholders become empty. */
export function applyTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "")
}

/** Cap body length with a visible marker instead of writing unbounded files. */
export function truncateText(value: string, maxChars: number): string {
  const max = Math.max(0, Math.trunc(maxChars))
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n\n[... truncated at ${max} characters ...]`
}

/** Return only user/assistant messages that have not been recorded yet. */
export function collectNewMessages(messages: ReadonlyArray<HistoryMessage>, seen: ReadonlySet<string>): HistoryMessage[] {
  return messages.filter((m) => (m.type === "user" || m.type === "assistant") && !!m.id && !seen.has(m.id))
}

/** Pair each user prompt with the assistant messages that follow it. */
export function groupInteractions(messages: ReadonlyArray<HistoryMessage>): Interaction[] {
  const interactions: Interaction[] = []
  for (const message of messages) {
    if (message.type === "user") {
      interactions.push({ prompt: message, responses: [] })
      continue
    }
    if (message.type === "assistant") {
      if (interactions.length === 0) {
        // A response without a captured prompt (e.g. plugin loaded mid-session).
        interactions.push({
          prompt: {
            id: `orphan:${message.id}`,
            type: "user",
            time: message.time,
            text: "(The originating prompt was not captured by this plugin.)",
          },
          responses: [],
        })
      }
      interactions[interactions.length - 1].responses.push(message)
    }
  }
  return interactions
}

function partsOf(message: HistoryMessage, types: ReadonlySet<string>): string[] {
  return (message.content ?? [])
    .filter((part) => types.has(part.type) && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string)
}

export function responseText(message: HistoryMessage): string {
  return partsOf(message, new Set(["text"])).join("\n\n")
}

export function reasoningText(message: HistoryMessage): string {
  return partsOf(message, new Set(["reasoning"])).join("\n\n")
}

export function toolNames(message: HistoryMessage): string[] {
  return (message.content ?? []).filter((part) => part.type === "tool" && typeof part.name === "string").map((part) => part.name as string)
}

const IGNORED_CHANGE = /(^|\/)(node_modules|\.git)\//

/**
 * Credential-bearing path components. Matched whole, so ordinary files such as
 * `src/tokenizer/index.ts` or `src/auth/password-reset.ts` are not discarded.
 */
const SECRET_PATH_COMPONENT =
  /^(?:\.env[^/]*|(?:(?:[a-z0-9]+[-_])?(?:credentials|secrets?|tokens?|passwords?)(?:\.(?:txt|json|ya?ml|env|key|pem))?)|(?:\.aws|\.ssh|\.npmrc|\.netrc|\.htpasswd|id_rsa|id_ed25519))$/i
const SECRET_PATH_EXT = /\.(?:pem|key|p12|pfx)$/i

/** True when a path looks like it holds credentials. Exported for tests. */
export function isSecretPath(file: string): boolean {
  const normalized = file.replace(/\\/g, "/")
  return normalized.split("/").some((part) => SECRET_PATH_COMPONENT.test(part)) || SECRET_PATH_EXT.test(normalized)
}

/**
 * Deduplicate changed-file paths reported on assistant messages.
 * Dependency/VCS internals and credential-bearing paths are omitted so the
 * frontmatter stays readable and cannot disclose where secrets live.
 */
export function changedFiles(responses: ReadonlyArray<HistoryMessage>, maxFiles = 200): string[] {
  const files = new Set<string>()
  for (const response of responses) {
    for (const file of response.snapshot?.files ?? []) {
      if (typeof file === "string" && file.length > 0 && !IGNORED_CHANGE.test(file) && !isSecretPath(file)) {
        files.add(redactSecrets(file))
      }
    }
  }
  return [...files].slice(0, Math.max(0, Math.trunc(maxFiles)))
}

/** Decide whether an interaction completed, failed or was interrupted. */
export function deriveStatus(
  messages: ReadonlyArray<HistoryMessage>,
  hint: Outcome,
  permissionRejected = false,
): { status: InteractionStatus; outcome: Outcome } {
  let outcome: Outcome = hint
  const lastIdle = [...messages].reverse().find((m) => m.type === "idle")
  if (lastIdle?.outcome === "failed" || lastIdle?.outcome === "interrupted") {
    outcome = lastIdle.outcome
  } else if (messages.some((m) => m.type === "assistant" && (m.error !== undefined || m.finish === "error"))) {
    outcome = "failed"
  }
  // An explicitly rejected permission ends the turn as a failure, even when the
  // execution itself reported success.
  if (permissionRejected) outcome = "failed"
  return { status: outcome === "succeeded" ? "complete" : "incomplete", outcome }
}

function frontmatter(fields: ReadonlyArray<readonly [string, string | ReadonlyArray<string>]>): string {
  const lines = fields.map(([key, value]) => {
    if (Array.isArray(value)) {
      return value.length === 0 ? `${key}: []` : `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`
    }
    return `${key}: ${JSON.stringify(value)}`
  })
  return `---\n${lines.join("\n")}\n---\n`
}

export interface PromptFileInput {
  interactionID: string
  sessionID: string
  parentSessionID?: string
  rootSessionID: string
  agent: string
  title: string
  timestamp: number
  text: string
  status: InteractionStatus
  maxTextChars?: number
  template?: string
}

export function renderPromptFile(input: PromptFileInput): string {
  const fields: Array<readonly [string, string | ReadonlyArray<string>]> = [
    ["kind", "prompt"],
    ["interaction", input.interactionID],
    ["session_id", input.sessionID],
    ["parent_session_id", input.parentSessionID ?? ""],
    ["root_session_id", input.rootSessionID],
    ["agent", input.agent],
    ["timestamp", toIso(input.timestamp)],
    ["status", input.status],
    ["title", input.title],
  ]
  const body = truncateText(redactSecrets(input.text), input.maxTextChars ?? 100_000)
  const content = input.template
    ? applyTemplate(input.template, {
        body,
        timestamp: toIso(input.timestamp),
        agent: input.agent,
        session_id: input.sessionID,
        interaction: input.interactionID,
        status: input.status,
        title: input.title,
      })
    : `# Prompt — ${input.title}\n\n${body}`
  return `${frontmatter(fields)}\n${redactSecrets(content)}\n`
}

export interface ResultFileInput {
  interactionID: string
  sessionID: string
  rootSessionID: string
  agent: string
  promptFile: string
  timestamp: number
  status: InteractionStatus
  outcome: Outcome
  responses: ReadonlyArray<HistoryMessage>
  includeReasoning?: boolean
  includeTools?: boolean
  includeChangedFiles?: boolean
  maxChangedFiles?: number
  maxTextChars?: number
  template?: string
  gitBranch?: string
  gitCommit?: string
  /** True when a credential-related permission was flagged in this session. */
  securityWarning?: boolean
}

export function renderResultFile(input: ResultFileInput): string {
  const files = input.includeChangedFiles === false ? [] : changedFiles(input.responses, input.maxChangedFiles)
  const tools = input.includeTools === false ? [] : [...new Set(input.responses.flatMap(toolNames))]
  const maxTextChars = input.maxTextChars ?? 100_000
  const text = truncateText(redactSecrets(input.responses.map(responseText).filter(Boolean).join("\n\n")), maxTextChars)
  const reasoning = input.includeReasoning
    ? truncateText(redactSecrets(input.responses.map(reasoningText).filter(Boolean).join("\n\n")), maxTextChars)
    : ""
  const fields: Array<readonly [string, string | ReadonlyArray<string>]> = [
    ["kind", "result"],
    ["interaction", input.interactionID],
    ["session_id", input.sessionID],
    ["root_session_id", input.rootSessionID],
    ["agent", input.agent],
    ["prompt_file", input.promptFile],
    ["timestamp", toIso(input.timestamp)],
    ["status", input.status],
    ["outcome", input.outcome],
    ["changed_files", files],
  ]
  if (input.gitBranch) fields.push(["git_branch", input.gitBranch])
  if (input.gitCommit) fields.push(["git_commit", input.gitCommit])
  if (input.securityWarning) fields.push(["security_warning", "true"])
  const body = [`# Result — ${input.agent}`, "", text || "_No assistant response was recorded for this interaction._"]
  if (reasoning) body.push("", "## Reasoning", "", reasoning)
  if (tools.length) body.push("", "## Tools used", "", ...tools.map((t) => `- ${t}`))
  if (files.length) body.push("", "## Changed files", "", ...files.map((f) => `- ${f}`))
  const content = input.template
    ? applyTemplate(input.template, {
        body: body.join("\n"),
        timestamp: toIso(input.timestamp),
        agent: input.agent,
        session_id: input.sessionID,
        interaction: input.interactionID,
        status: input.status,
        outcome: input.outcome,
        prompt_file: input.promptFile,
        git_branch: input.gitBranch ?? "",
        git_commit: input.gitCommit ?? "",
        tools: tools.join(", "),
        changed_files: files.join(", "),
      })
    : body.join("\n")
  return `${frontmatter(fields)}\n${redactSecrets(content)}\n`
}

/** One turn in a session transcript. */
export interface TranscriptEntry {
  timestamp: number
  agent: string
  promptText: string
  responseText: string
  status: InteractionStatus
  outcome: Outcome
}

/** Render a chronological prompt → response transcript. All output is redacted. */
export function renderTranscript(entries: ReadonlyArray<TranscriptEntry>): string {
  const lines = ["# Session transcript", ""]
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)
  for (const entry of sorted) {
    lines.push(`## ${toIso(entry.timestamp)} — ${redactSecrets(entry.agent)}`, "")
    lines.push("### Prompt", "", redactSecrets(entry.promptText) || "_No prompt recorded._", "")
    lines.push("### Response", "", redactSecrets(entry.responseText) || "_No response recorded._", "")
    lines.push(`_Status: ${entry.status} (${entry.outcome})_`, "")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

/** One archived interaction, stored for consolidated export. */
export interface ExportEntry {
  interactionID: string
  sessionID: string
  agent: string
  timestamp: number
  status: InteractionStatus
  outcome: Outcome
  promptFile: string
  promptText: string
  responseText: string
  tools: string[]
  changedFiles: string[]
}

/** Filters applied when rendering a consolidated export. */
export interface ExportFilter {
  dateFrom?: string
  dateTo?: string
  agent?: string
  status?: InteractionStatus
  text?: string
  tag?: string
}

/** Filter export entries. All conditions are ANDed; text matches prompt or response. */
export function filterExportEntries(entries: ReadonlyArray<ExportEntry>, filters: ExportFilter): ExportEntry[] {
  const needle = filters.text?.toLowerCase()
  return entries.filter((entry) => {
    const iso = new Date(entry.timestamp).toISOString()
    const date = iso.slice(0, 10)
    if (filters.dateFrom && date < filters.dateFrom) return false
    if (filters.dateTo && date > filters.dateTo) return false
    if (filters.agent && !entry.agent.toLowerCase().includes(filters.agent.toLowerCase())) return false
    if (filters.status && entry.status !== filters.status) return false
    if (needle && !`${entry.promptText}\n${entry.responseText}`.toLowerCase().includes(needle)) return false
    return true
  })
}

/** Render a consolidated export as Markdown or JSONL. All output is redacted. */
export function renderExport(entries: ReadonlyArray<ExportEntry>, format: "md" | "jsonl", filters: ExportFilter = {}): string {
  const selected = filterExportEntries(entries, filters)
  if (format === "jsonl") {
    return (
      selected
        .map((entry) =>
          JSON.stringify({
            interaction: redactSecrets(entry.interactionID),
            session_id: redactSecrets(entry.sessionID),
            agent: redactSecrets(entry.agent),
            timestamp: toIso(entry.timestamp),
            status: entry.status,
            outcome: entry.outcome,
            prompt_file: redactSecrets(entry.promptFile),
            prompt: redactSecrets(entry.promptText),
            response: redactSecrets(entry.responseText),
            tools: entry.tools.map(redactSecrets),
            changed_files: entry.changedFiles.map(redactSecrets),
          }),
        )
        .join("\n") + (selected.length ? "\n" : "")
    )
  }
  const lines = ["# Prompt archive export", ""]
  for (const entry of selected) {
    lines.push(`## ${redactSecrets(entry.agent)} — ${toIso(entry.timestamp)}`, "")
    lines.push(`- Interaction: \`${redactSecrets(entry.interactionID)}\``)
    lines.push(`- Status: ${entry.status} (${entry.outcome})`)
    lines.push(`- Prompt file: [${redactSecrets(entry.promptFile)}](./${redactSecrets(entry.promptFile)})`)
    lines.push("", "### Prompt", "", redactSecrets(entry.promptText), "", "### Response", "")
    lines.push(redactSecrets(entry.responseText) || "_No response recorded._")
    if (entry.tools.length) lines.push("", "Tools: " + entry.tools.map((t) => `\`${redactSecrets(t)}\``).join(", "))
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

/** Render the archive root INDEX.md from persisted session entries. */
export function renderIndex(
  entries: Readonly<Record<string, { title: string; date: string; files: ReadonlyArray<string>; branch?: string }>>,
): string {
  const lines = ["# Prompt archive index", ""]
  const folders = Object.keys(entries).sort()
  if (folders.length === 0) lines.push("_No sessions recorded yet._")
  for (const folder of folders) {
    const entry = entries[folder]
    lines.push(`## ${entry.title || folder}`, "")
    if (entry.date) lines.push(`- Date: ${entry.date}`)
    if (entry.branch) lines.push(`- Branch: \`${entry.branch}\``)
    lines.push(`- Folder: [${folder}](./${folder}/)`)
    for (const file of entry.files) {
      lines.push(`- [${file}](./${folder}/${file})`)
    }
    lines.push("")
  }
  return `${lines.join("\n").trimEnd()}\n`
}

/* -------------------------------------------------------------------------- */
/* Credential-permission warnings                                             */
/* -------------------------------------------------------------------------- */

/** The subset of a `permission.asked` event used for credential detection. */
export interface PermissionInput {
  action: string
  resources?: ReadonlyArray<string>
  message?: string
  metadata?: Record<string, unknown>
}

export interface CredentialWarning {
  /** Sanitized, human-readable reasons — never contains raw credential values. */
  reasons: string[]
}

const CREDENTIAL_PATH =
  /(?:\.env(?:\.|$)|(?:^|\/)\.aws\/|(?:^|\/)\.ssh\/|credentials|(?:^|\/)secret|\btoken\b|password|\.pem$|\.key$|id_rsa|\.npmrc$|\.netrc$)/i
const CREDENTIAL_ACTION = /(token|password|passwd|secret|credential|api[_-]?key|private[_-]?key|sign[_-]?in|\bauth\b)/i
const CREDENTIAL_COMMAND =
  /(export\s+[a-z0-9_-]*(?:key|token|secret|password)[a-z0-9_-]*=|cat\s+[^\s]*(?:\.env|credentials|\.aws)|\$?(?:api[_-]?key|token|secret|password)\b)/i

/**
 * Heuristically decide whether a permission request looks credential-related.
 * This is a warning signal, not a security guarantee — it inspects only action
 * strings and resource paths carried by the event, never secret values, and
 * cannot detect reads allowed without a permission prompt.
 */
export function classifyCredentialPermission(input: PermissionInput): CredentialWarning | undefined {
  const reasons: string[] = []
  const push = (value: string): void => {
    const safe = redactSecrets(value)
    if (!reasons.includes(safe)) reasons.push(safe)
  }

  for (const resource of input.resources ?? []) {
    if (typeof resource === "string" && CREDENTIAL_PATH.test(resource)) {
      push(`credential-like path: ${resource}`)
    }
  }
  if (typeof input.action === "string" && CREDENTIAL_ACTION.test(input.action)) {
    push(`credential-like action: ${input.action}`)
  }
  if (typeof input.message === "string") {
    if (CREDENTIAL_ACTION.test(input.message)) push(`credential-like request: ${input.message}`)
    if (CREDENTIAL_COMMAND.test(input.message)) push(`credential-like command: ${input.message}`)
  }
  if (input.metadata && typeof input.metadata === "object") {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (CREDENTIAL_ACTION.test(key) && typeof value === "string") {
        push(`credential-like metadata: ${key}`)
      }
    }
  }

  return reasons.length > 0 ? { reasons } : undefined
}

export interface WarningFileInput {
  sessionID: string
  timestamp: number
  reasons: ReadonlyArray<string>
  reply?: string
}

/** Render a sanitized warning entry for the shared SECURITY-WARNINGS.md file. */
export function renderWarningEntry(input: WarningFileInput): string {
  const iso = toIso(input.timestamp)
  const lines = [`## ${iso} — ${redactSecrets(input.sessionID)}`, "", ...input.reasons.map((reason) => `- ${redactSecrets(reason)}`)]
  if (input.reply) lines.push("", `User reply: ${redactSecrets(input.reply)}`)
  return `${lines.join("\n")}\n`
}
