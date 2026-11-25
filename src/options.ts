/**
 * Plugin option parsing. Invalid values fall back to defaults with a single
 * warning instead of throwing, so a bad option cannot break recording.
 */

import path from "node:path"

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

  if (warnings.length > 0) {
    console.warn(`[prompt-archive] invalid options (using defaults): ${warnings.join("; ")}`)
  }
  return options
}

/** Resolve the configured directory against the OpenCode project directory. */
export function resolveDirectory(directory: string, projectDirectory: string): string {
  return path.isAbsolute(directory) ? path.normalize(directory) : path.resolve(projectDirectory, directory)
}
