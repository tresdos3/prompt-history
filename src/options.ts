/**
 * Plugin option parsing. Invalid values fall back to defaults with a single
 * warning instead of throwing, so a bad option cannot break recording.
 */

import path from "node:path"

/** Configuration for the consolidated searchable export file. */
export interface ExportOptions {
  format: "md" | "jsonl"
  outFile: string
  dateFrom?: string
  dateTo?: string
  agent?: string
  status?: "complete" | "incomplete"
  text?: string
}

export interface ArchiveOptions {
  /** Output root; relative paths resolve against the OpenCode project directory. */
  directory: string
  includeReasoning: boolean
  includeTools: boolean
  includeChangedFiles: boolean
  maxChangedFiles: number
  /** Maximum characters per prompt/response body before truncation. */
  maxTextChars: number
  verbose: boolean
  /** Warn (stderr + archive) when a permission request looks credential-related. */
  warnOnCredentialPermission: boolean
  /** Re-record messages even if their IDs were already seen. */
  force: boolean
  /** Prefix new session folders with YYYY-MM-DD for chronological sorting. */
  datePrefix: boolean
  /** Maximum parentID hops when resolving a subagent's root session. */
  maxParentDepth: number
  /** Log what would be written without creating or modifying files. */
  dryRun: boolean
  /** When set, regenerate a consolidated export after each session. */
  export?: ExportOptions
  /** Optional custom Markdown body template for prompt files. */
  promptTemplate?: string
  /** Optional custom Markdown body template for result files. */
  resultTemplate?: string
  /** Write a chronological TRANSCRIPT.md in each session folder. */
  includeTranscript: boolean
  /** Override the transcript filename. */
  transcriptName: string
  /** Delete session folders older than this many days. */
  retentionDays?: number
  /** Keep at most this many session folders, deleting the oldest first. */
  maxSessions?: number
}

export const DEFAULT_OPTIONS: ArchiveOptions = {
  directory: "docs/prompt-history",
  includeReasoning: false,
  includeTools: true,
  includeChangedFiles: true,
  maxChangedFiles: 200,
  maxTextChars: 100_000,
  verbose: false,
  warnOnCredentialPermission: false,
  force: false,
  datePrefix: false,
  maxParentDepth: 32,
  dryRun: false,
  includeTranscript: true,
  transcriptName: "TRANSCRIPT.md",
}

/** Parse the optional export configuration. Invalid values are ignored with a warning. */
function parseExportOptions(raw: unknown, warnings: string[]): ExportOptions | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("export must be an object")
    return undefined
  }
  const input = raw as Record<string, unknown>
  const result: ExportOptions = {
    format: input.format === "jsonl" ? "jsonl" : "md",
    outFile: typeof input.outFile === "string" && input.outFile.trim() ? input.outFile.trim() : "ARCHIVE.md",
  }
  if (input.format !== undefined && input.format !== "md" && input.format !== "jsonl") {
    warnings.push("export.format must be 'md' or 'jsonl'")
  }
  for (const key of ["dateFrom", "dateTo", "agent", "text"] as const) {
    if (typeof input[key] === "string") result[key] = input[key]
    else if (input[key] !== undefined) warnings.push(`export.${key} must be a string`)
  }
  if (input.status === "complete" || input.status === "incomplete") result.status = input.status
  else if (input.status !== undefined) warnings.push("export.status must be 'complete' or 'incomplete'")
  return result
}

export function parseOptions(raw: unknown): ArchiveOptions {
  const options: ArchiveOptions = { ...DEFAULT_OPTIONS }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return options
  const input = raw as Record<string, unknown>
  const warnings: string[] = []

  if (typeof input.directory === "string" && input.directory.trim().length > 0) {
    options.directory = input.directory.trim()
  } else if (input.directory !== undefined) {
    warnings.push("directory must be a non-empty string")
  }

  for (const key of [
    "includeReasoning",
    "includeTools",
    "includeChangedFiles",
    "verbose",
    "warnOnCredentialPermission",
    "force",
    "datePrefix",
    "dryRun",
  ] as const) {
    const value = input[key]
    if (typeof value === "boolean") options[key] = value
    else if (value !== undefined) warnings.push(`${key} must be a boolean`)
  }

  if (typeof input.maxChangedFiles === "number" && Number.isFinite(input.maxChangedFiles)) {
    options.maxChangedFiles = Math.max(0, Math.trunc(input.maxChangedFiles))
  } else if (input.maxChangedFiles !== undefined) {
    warnings.push("maxChangedFiles must be a finite number")
  }

  if (typeof input.maxTextChars === "number" && Number.isFinite(input.maxTextChars)) {
    options.maxTextChars = Math.max(0, Math.trunc(input.maxTextChars))
  } else if (input.maxTextChars !== undefined) {
    warnings.push("maxTextChars must be a finite number")
  }

  if (typeof input.maxParentDepth === "number" && Number.isFinite(input.maxParentDepth)) {
    options.maxParentDepth = Math.max(0, Math.trunc(input.maxParentDepth))
  } else if (input.maxParentDepth !== undefined) {
    warnings.push("maxParentDepth must be a finite number")
  }

  for (const key of ["retentionDays", "maxSessions"] as const) {
    const value = input[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      options[key] = Math.max(0, Math.trunc(value))
    } else if (value !== undefined) {
      warnings.push(`${key} must be a finite number`)
    }
  }

  for (const key of ["includeTranscript"] as const) {
    const value = input[key]
    if (typeof value === "boolean") options[key] = value
    else if (value !== undefined) warnings.push(`${key} must be a boolean`)
  }
  if (typeof input.transcriptName === "string" && input.transcriptName.trim()) {
    options.transcriptName = input.transcriptName.trim()
  } else if (input.transcriptName !== undefined) {
    warnings.push("transcriptName must be a non-empty string")
  }

  for (const key of ["promptTemplate", "resultTemplate"] as const) {
    if (typeof input[key] === "string") options[key] = input[key]
    else if (input[key] !== undefined) warnings.push(`${key} must be a string`)
  }

  const exportOptions = parseExportOptions(input.export, warnings)
  if (exportOptions) options.export = exportOptions

  if (warnings.length > 0) {
    console.warn(`[prompt-archive] invalid options (using defaults): ${warnings.join("; ")}`)
  }
  return options
}

/** Resolve the configured directory against the OpenCode project directory. */
export function resolveDirectory(directory: string, projectDirectory: string): string {
  return path.isAbsolute(directory) ? path.normalize(directory) : path.resolve(projectDirectory, directory)
}
