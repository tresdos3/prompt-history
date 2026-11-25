/**
 * Filesystem and plugin-storage helpers.
 *
 * Writes are exclusive (`wx`): an existing record is never modified or
 * overwritten. No child processes are spawned by this plugin.
 */

import { appendFile, mkdir, open, readdir } from "node:fs/promises"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"

type Ctx = Plugin.Context

const SEEN_KEY = "prompt-archive/seen-message-ids"
const FOLDERS_KEY = "prompt-archive/session-folders"
const LAST_KEY = "prompt-archive/last-interactions"
const FLAGS_KEY = "prompt-archive/session-flags"

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
export async function setSessionFlags(
  ctx: Ctx,
  sessionID: string,
  patch: Partial<SessionFlags>,
): Promise<void> {
  const all = await getSessionFlags(ctx)
  all[sessionID] = { ...all[sessionID], ...patch }
  await ctx.storage.set(FLAGS_KEY, JSON.stringify(all))
}

/** Remove a flag from one session (used for one-shot signals such as a rejection). */
export async function clearSessionFlag(
  ctx: Ctx,
  sessionID: string,
  flag: keyof SessionFlags,
): Promise<void> {
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
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

export async function setLastInteractions(
  ctx: Ctx,
  map: Record<string, LastInteraction>,
): Promise<void> {
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
): Promise<{ name: string; path: string }> {
  await mkdir(root, { recursive: true })
  const names = await readDirNames(root)
  let number = highestNumber(names, /^(\d{4})-/i) + 1
  while (true) {
    const name = `${String(number).padStart(4, "0")}-${titleSlug}`
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

/** Write a numbered Markdown file exclusively; bump the number on collision. */
export async function writeNumbered(
  dir: string,
  number: number,
  base: string,
  content: string,
): Promise<string> {
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
