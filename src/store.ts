/**
 * Filesystem and plugin-storage helpers.
 *
 * Writes are exclusive (`wx`): an existing record is never modified or
 * overwritten. No child processes are spawned by this plugin.
 */

import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ExportEntry } from "./core.ts"

type Ctx = Plugin.Context

const SEEN_KEY = "prompt-archive/seen-message-ids"
const FOLDERS_KEY = "prompt-archive/session-folders"
const LAST_KEY = "prompt-archive/last-interactions"
const FLAGS_KEY = "prompt-archive/session-flags"
const INDEX_KEY = "prompt-archive/index"
const EXPORT_KEY = "prompt-archive/export-entries"

export interface LastInteraction {
  interactionID: string
  promptFile: string
  agent: string
  title: string
}

/** Per-session flags carried across events (e.g. a warning or a rejected permission). */
export interface SessionFlags {
  securityWarning?: boolean
  permissionRejected?: boolean
}

/** One row in the generated INDEX.md. */
export interface IndexEntry {
  title: string
  date: string
  files: string[]
  branch?: string
}

/** Local git metadata, read from .git files only — no shell or child processes. */
export interface GitMetadata {
  branch?: string
  commit?: string
}

/** Resolve the git directory, which may be a file pointing elsewhere (worktrees). */
async function gitDir(projectDirectory: string): Promise<string | undefined> {
  const candidate = path.join(projectDirectory, ".git")
  try {
    const info = await stat(candidate)
    if (info.isDirectory()) return candidate
    if (info.isFile()) {
      const content = await readFile(candidate, "utf8")
      const match = /^gitdir:\s*(.+)$/m.exec(content)
      if (match) return path.resolve(projectDirectory, match[1].trim())
    }
  } catch {
    return undefined
  }
  return undefined
}

/** Read the current branch and commit hash from .git/HEAD, refs, and packed-refs. */
export async function readGitMetadata(projectDirectory: string): Promise<GitMetadata> {
  const dir = await gitDir(projectDirectory)
  if (!dir) return {}
  let head: string
  try {
    head = (await readFile(path.join(dir, "HEAD"), "utf8")).trim()
  } catch {
    return {}
  }
  const result: GitMetadata = {}
  const refMatch = /^ref:\s*(.+)$/.exec(head)
  if (!refMatch) {
    // Detached HEAD: the file contains the commit hash directly.
    if (/^[0-9a-f]{40}$/i.test(head)) result.commit = head
    return result
  }
  const ref = refMatch[1]
  result.branch = ref.replace(/^refs\/heads\//, "")
  try {
    const commit = (await readFile(path.join(dir, ref), "utf8")).trim()
    if (/^[0-9a-f]{40}$/i.test(commit)) result.commit = commit
    return result
  } catch {
    // Fall through to packed-refs.
  }
  try {
    const packed = await readFile(path.join(dir, "packed-refs"), "utf8")
    const line = packed.split("\n").find((row) => row.endsWith(` ${ref}`))
    const commit = line?.split(" ")[0]
    if (commit && /^[0-9a-f]{40}$/i.test(commit)) result.commit = commit
  } catch {
    // No packed refs; branch without commit is still useful.
  }
  return result
}

export async function getIndex(ctx: Ctx): Promise<Record<string, IndexEntry>> {
  const raw = await ctx.storage.get(INDEX_KEY)
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, IndexEntry> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.title === "string" &&
      typeof record.date === "string" &&
      Array.isArray(record.files) &&
      record.files.every((f) => typeof f === "string")
    ) {
      result[key] = {
        title: record.title,
        date: record.date,
        files: record.files as string[],
        ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
      }
    }
  }
  return result
}

export async function getExportEntries(ctx: Ctx): Promise<ExportEntry[]> {
  const raw = await ctx.storage.get(EXPORT_KEY)
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is ExportEntry => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return (
      typeof e.interactionID === "string" &&
      typeof e.sessionID === "string" &&
      typeof e.agent === "string" &&
      typeof e.timestamp === "number" &&
      typeof e.promptText === "string"
    )
  })
}

export async function addExportEntries(ctx: Ctx, entries: ReadonlyArray<ExportEntry>): Promise<void> {
  const all = await getExportEntries(ctx)
  const ids = new Set(entries.map((entry) => entry.interactionID))
  const merged = [...all.filter((entry) => !ids.has(entry.interactionID)), ...entries]
  await ctx.storage.set(EXPORT_KEY, JSON.stringify(merged))
}

export async function setIndexEntry(ctx: Ctx, folder: string, entry: IndexEntry): Promise<void> {
  const all = await getIndex(ctx)
  const previous = all[folder]
  all[folder] = {
    title: entry.title || previous?.title || folder,
    date: entry.date || previous?.date || "",
    files: [...new Set([...(previous?.files ?? []), ...entry.files])],
    ...(entry.branch || previous?.branch ? { branch: entry.branch || previous?.branch } : {}),
  }
  await ctx.storage.set(INDEX_KEY, JSON.stringify(all))
}

export async function getSessionFlags(ctx: Ctx): Promise<Record<string, SessionFlags>> {
  const raw = await ctx.storage.get(FLAGS_KEY)
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, SessionFlags> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const flags: SessionFlags = {}
    if (record.securityWarning === true) flags.securityWarning = true
    if (record.permissionRejected === true) flags.permissionRejected = true
    if (Object.keys(flags).length > 0) result[key] = flags
  }
  return result
}

/** Merge flags for one session, persisting them for later events. */
export async function setSessionFlags(ctx: Ctx, sessionID: string, patch: Partial<SessionFlags>): Promise<void> {
  const all = await getSessionFlags(ctx)
  all[sessionID] = { ...all[sessionID], ...patch }
  await ctx.storage.set(FLAGS_KEY, JSON.stringify(all))
}

/** Remove a flag from one session (used for one-shot signals such as a rejection). */
export async function clearSessionFlag(ctx: Ctx, sessionID: string, flag: keyof SessionFlags): Promise<void> {
  const all = await getSessionFlags(ctx)
  const current = all[sessionID]
  if (!current || !current[flag]) return
  const updated = { ...current }
  delete updated[flag]
  if (Object.keys(updated).length === 0) delete all[sessionID]
  else all[sessionID] = updated
  await ctx.storage.set(FLAGS_KEY, JSON.stringify(all))
}

export async function getSeen(ctx: Ctx): Promise<string[]> {
  const value = await ctx.storage.get(SEEN_KEY)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export async function setSeen(ctx: Ctx, ids: ReadonlyArray<string>): Promise<void> {
  await ctx.storage.set(SEEN_KEY, [...ids])
}

export async function getFolderMap(ctx: Ctx): Promise<Record<string, string>> {
  const value = await ctx.storage.get(FOLDERS_KEY)
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry
  }
  return result
}

export async function setFolderMap(ctx: Ctx, map: Record<string, string>): Promise<void> {
  await ctx.storage.set(FOLDERS_KEY, map)
}

/** Remember which prompt a later assistant-only batch belongs to. */
export async function getLastInteractions(ctx: Ctx): Promise<Record<string, LastInteraction>> {
  const raw = await ctx.storage.get(LAST_KEY)
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, LastInteraction> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (
      typeof record.interactionID === "string" &&
      typeof record.promptFile === "string" &&
      typeof record.agent === "string" &&
      typeof record.title === "string"
    ) {
      result[key] = {
        interactionID: record.interactionID,
        promptFile: record.promptFile,
        agent: record.agent,
        title: record.title,
      }
    }
  }
  return result
}

export async function setLastInteractions(ctx: Ctx, map: Record<string, LastInteraction>): Promise<void> {
  await ctx.storage.set(LAST_KEY, JSON.stringify(map))
}

export async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export function highestNumber(names: ReadonlyArray<string>, pattern: RegExp): number {
  let max = 0
  for (const name of names) {
    const match = pattern.exec(name)
    if (match) max = Math.max(max, Number.parseInt(match[1] ?? "0", 10) || 0)
  }
  return max
}

/** Create a numbered session folder without colliding with an existing one. */
export async function createSessionFolder(
  root: string,
  titleSlug: string,
  datePrefix = "",
  dryRun = false,
): Promise<{ name: string; path: string }> {
  if (!dryRun) await mkdir(root, { recursive: true })
  const names = await readDirNames(root)
  let number = highestNumber(names, /^(?:\d{4}-\d{2}-\d{2}-)?(\d{4})-/i) + 1
  while (true) {
    const name = `${datePrefix}${String(number).padStart(4, "0")}-${titleSlug}`
    if (dryRun) return { name, path: path.join(root, name) }
    try {
      await mkdir(path.join(root, name))
      return { name, path: path.join(root, name) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        number += 1
        continue
      }
      throw error
    }
  }
}

/** Append a section to a named file in the archive root, creating it on first use. */
export async function appendToArchiveFile(root: string, filename: string, content: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await appendFile(path.join(root, filename), content, "utf8")
}

/** Regenerate a derived file such as INDEX.md. Records themselves are never overwritten. */
export async function writeArchiveFile(root: string, filename: string, content: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, filename), content, "utf8")
}

/** Write a numbered Markdown file exclusively; bump the number on collision. */
export async function writeNumbered(dir: string, number: number, base: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  let next = Math.max(1, number)
  while (true) {
    const name = `${String(next).padStart(2, "0")}-${base}.md`
    try {
      const handle = await open(path.join(dir, name), "wx", 0o644)
      try {
        await handle.writeFile(content, "utf8")
      } finally {
        await handle.close()
      }
      return name
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        next += 1
        continue
      }
      throw error
    }
  }
}
