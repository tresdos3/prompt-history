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
  verbose: boolean
  /** Warn (stderr + archive) when a permission request looks credential-related. */
  warnOnCredentialPermission: boolean
}

export const DEFAULT_OPTIONS: ArchiveOptions = {
  directory: "docs/prompt-history",
  includeReasoning: false,
  includeTools: true,
  includeChangedFiles: true,
  maxChangedFiles: 200,
  verbose: false,
  warnOnCredentialPermission: false,
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

  for (const key of ["includeReasoning", "includeTools", "includeChangedFiles", "verbose", "warnOnCredentialPermission"] as const) {
    const value = input[key]
    if (typeof value === "boolean") options[key] = value
    else if (value !== undefined) warnings.push(`${key} must be a boolean`)
  }

  if (typeof input.maxChangedFiles === "number" && Number.isFinite(input.maxChangedFiles)) {
    options.maxChangedFiles = Math.max(0, Math.trunc(input.maxChangedFiles))
  } else if (input.maxChangedFiles !== undefined) {
    warnings.push("maxChangedFiles must be a finite number")
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
