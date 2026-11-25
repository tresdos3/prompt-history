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
  return words.slice(0, maxChars).replace(/-+$/, "") || "interaction"
}

export function toIso(ms: number): string {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

/** Return only user/assistant messages that have not been recorded yet. */
export function collectNewMessages(
  messages: ReadonlyArray<HistoryMessage>,
  seen: ReadonlySet<string>,
): HistoryMessage[] {
  return messages.filter(
    (m) => (m.type === "user" || m.type === "assistant") && !!m.id && !seen.has(m.id),
  )
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
  return (message.content ?? [])
    .filter((part) => part.type === "tool" && typeof part.name === "string")
    .map((part) => part.name as string)
}

const IGNORED_CHANGE = /(^|\/)(node_modules|\.git)\//

/** Paths that are likely to hold credentials; never written to the archive. */
const SECRET_PATH = /(?:\.env(?:\.|$)|(?:^|\/)\.aws\/|(?:^|\/)\.ssh\/|(?:^|\/)credentials(?:$|\/)|secret|token|password|\.pem$|\.key$|id_rsa|\.npmrc$|\.netrc$)/i

/**
 * Deduplicate changed-file paths reported on assistant messages.
 * Dependency/VCS internals and credential-bearing paths are omitted so the
 * frontmatter stays readable and cannot disclose where secrets live.
 */
export function changedFiles(
  responses: ReadonlyArray<HistoryMessage>,
  maxFiles = 200,
): string[] {
  const files = new Set<string>()
  for (const response of responses) {
    for (const file of response.snapshot?.files ?? []) {
      if (
        typeof file === "string" &&
        file.length > 0 &&
        !IGNORED_CHANGE.test(file) &&
        !SECRET_PATH.test(file)
      ) {
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
): { status: InteractionStatus; outcome: Outcome } {
  let outcome: Outcome = hint
  const lastIdle = [...messages].reverse().find((m) => m.type === "idle")
  if (lastIdle?.outcome === "failed" || lastIdle?.outcome === "interrupted") {
    outcome = lastIdle.outcome
  } else if (
    messages.some(
      (m) => m.type === "assistant" && (m.error !== undefined || m.finish === "error"),
    )
  ) {
    outcome = "failed"
  }
  return { status: outcome === "succeeded" ? "complete" : "incomplete", outcome }
}

function frontmatter(fields: ReadonlyArray<readonly [string, string | ReadonlyArray<string>]>): string {
  const lines = fields.map(([key, value]) => {
    if (Array.isArray(value)) {
      return value.length === 0
        ? `${key}: []`
        : `${key}:\n${value.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`
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
  return `${frontmatter(fields)}\n# Prompt — ${input.title}\n\n${redactSecrets(input.text)}\n`
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
}

export function renderResultFile(input: ResultFileInput): string {
  const files = input.includeChangedFiles === false ? [] : changedFiles(input.responses, input.maxChangedFiles)
  const tools = input.includeTools === false ? [] : [...new Set(input.responses.flatMap(toolNames))]
  const text = redactSecrets(input.responses.map(responseText).filter(Boolean).join("\n\n"))
  const reasoning = input.includeReasoning
    ? redactSecrets(input.responses.map(reasoningText).filter(Boolean).join("\n\n"))
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
  const body = [
    `# Result — ${input.agent}`,
    "",
    text || "_No assistant response was recorded for this interaction._",
  ]
  if (reasoning) body.push("", "## Reasoning", "", reasoning)
  if (tools.length) body.push("", "## Tools used", "", ...tools.map((t) => `- ${t}`))
  if (files.length) body.push("", "## Changed files", "", ...files.map((f) => `- ${f}`))
  return `${frontmatter(fields)}\n${body.join("\n")}\n`
}
