/**
 * opencode-prompt-archive (OpenCode V2).
 *
 * Records each agent interaction as Markdown under a configurable directory,
 * using the OpenCode event stream only as a trigger and the session context
 * as the source of truth.
 */

import { Plugin } from "@opencode/plugin"
import path from "node:path"
import {
  collectNewMessages,
  deriveStatus,
  groupInteractions,
  redactSecrets,
  renderPromptFile,
  renderResultFile,
  slugify,
  type HistoryMessage,
  type Outcome,
} from "./core.ts"
import { parseOptions, resolveDirectory, type ArchiveOptions } from "./options.ts"
import {
  createSessionFolder,
  getFolderMap,
  getLastInteractions,
  getSeen,
  highestNumber,
  readDirNames,
  setFolderMap,
  setLastInteractions,
  setSeen,
  writeNumbered,
  type LastInteraction,
} from "./store.ts"

type Ctx = Plugin.Context

interface SessionLike {
  id: string
  parentID?: string
  title?: string
  agent?: string
}

/**
 * Verified against OpenCode 2.4.1's live event stream:
 * - `session.execution.succeeded` fires for CLI runs where `session.idle` may
 *   never be emitted before the client disconnects.
 * - A turn can therefore be recorded in several steps; the continuation logic
 *   in `processSession` links later steps back to the original prompt.
 * - The `types` option of `event.subscribe` delivered no events in this
 *   version, so filtering is done explicitly below.
 */
const WATCHED_EVENTS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
] as const

/** Serialize processing so two events cannot allocate the same file numbers. */
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

function outcomeFor(eventType: string): Outcome {
  if (eventType === "session.execution.failed") return "failed"
  if (eventType === "session.execution.interrupted") return "interrupted"
  return "succeeded"
}

/** Follow parentID links so subagent sessions share their root session's folder. */
async function resolveRoot(ctx: Ctx, session: SessionLike): Promise<SessionLike> {
  let current = session
  const visited = new Set<string>([current.id])
  for (let depth = 0; depth < 16 && current.parentID; depth += 1) {
    if (visited.has(current.parentID)) break
    visited.add(current.parentID)
    try {
      current = (await ctx.session.get({ sessionID: current.parentID })) as unknown as SessionLike
    } catch {
      break
    }
  }
  return current
}

async function ensureFolder(
  ctx: Ctx,
  root: string,
  rootSession: SessionLike,
  firstPrompt: string,
): Promise<{ name: string; path: string }> {
  const folders = await getFolderMap(ctx)
  const existing = folders[rootSession.id]
  if (existing) return { name: existing, path: path.join(root, existing) }

  const seed = rootSession.title || firstPrompt || rootSession.id
  const folder = await createSessionFolder(root, slugify(redactSecrets(seed), 8, 64))
  folders[rootSession.id] = folder.name
  await setFolderMap(ctx, folders)
  return folder
}

async function processSession(
  ctx: Ctx,
  options: ArchiveOptions,
  root: string,
  sessionID: string,
  hint: Outcome,
): Promise<void> {
  const session = (await ctx.session.get({ sessionID })) as unknown as SessionLike
  const messages = (await ctx.session.context({ sessionID })) as unknown as HistoryMessage[]
  const seen = new Set(await getSeen(ctx))
  const fresh = collectNewMessages(messages, seen)
  if (fresh.length === 0) return

  const rootSession = await resolveRoot(ctx, session)
  const firstPrompt = fresh.find((m) => m.type === "user")?.text ?? ""
  const folder = await ensureFolder(ctx, root, rootSession, firstPrompt)
  const { status, outcome } = deriveStatus(messages, hint)
  const interactions = groupInteractions(fresh)
  const lastInteractions = await getLastInteractions(ctx)
  const lastUser = [...messages].reverse().find((m) => m.type === "user")
  let number = highestNumber(await readDirNames(folder.path), /^(\d{2})-/) + 1

  for (const interaction of interactions) {
    const agent =
      interaction.responses.find((r) => !!r.agent)?.agent ?? session.agent ?? "assistant"
    const lastResponse = interaction.responses[interaction.responses.length - 1]
    const isContinuation = interaction.prompt.id.startsWith("orphan:")
    const previous = lastInteractions[sessionID]

    if (isContinuation) {
      // A later step of an already recorded turn: add another result file that
      // points at the original prompt instead of inventing a new prompt.
      const interactionID =
        previous?.interactionID ?? (lastUser ? `${sessionID}::${lastUser.id}` : `${sessionID}::unknown`)
      await writeNumbered(
        folder.path,
        number,
        `${slugify(agent, 4, 32)}-result`,
        renderResultFile({
          interactionID,
          sessionID,
          rootSessionID: rootSession.id,
          agent,
          promptFile: previous?.promptFile ?? "",
          timestamp: lastResponse?.time?.completed ?? lastResponse?.time?.created ?? Date.now(),
          status,
          outcome,
          responses: interaction.responses,
          includeReasoning: options.includeReasoning,
          includeTools: options.includeTools,
          includeChangedFiles: options.includeChangedFiles,
          maxChangedFiles: options.maxChangedFiles,
        }),
      )
      number += 1
      for (const message of interaction.responses) seen.add(message.id)
      await setSeen(ctx, [...seen])
      continue
    }

    const title = slugify(redactSecrets(interaction.prompt.text || "prompt"))
    const interactionID = `${sessionID}::${interaction.prompt.id}`
    const promptFile = await writeNumbered(
      folder.path,
      number,
      `${title}-prompt`,
      renderPromptFile({
        interactionID,
        sessionID,
        parentSessionID: session.parentID,
        rootSessionID: rootSession.id,
        agent,
        title,
        timestamp: interaction.prompt.time?.created ?? Date.now(),
        text: interaction.prompt.text ?? "",
        status,
      }),
    )
    number += 1

    await writeNumbered(
      folder.path,
      number,
      `${slugify(agent, 4, 32)}-result`,
      renderResultFile({
        interactionID,
        sessionID,
        rootSessionID: rootSession.id,
        agent,
        promptFile,
        timestamp: lastResponse?.time?.completed ?? lastResponse?.time?.created ?? Date.now(),
        status,
        outcome,
        responses: interaction.responses,
        includeReasoning: options.includeReasoning,
        includeTools: options.includeTools,
        includeChangedFiles: options.includeChangedFiles,
        maxChangedFiles: options.maxChangedFiles,
      }),
    )
    number += 1

    const record: LastInteraction = { interactionID, promptFile, agent, title }
    lastInteractions[sessionID] = record
    await setLastInteractions(ctx, lastInteractions)

    // Persist progress after each pair so a later failure cannot duplicate it.
    for (const message of [interaction.prompt, ...interaction.responses]) seen.add(message.id)
    await setSeen(ctx, [...seen])
  }
}

const plugin = Plugin.define({
  id: "opencode.prompt-archive",
  setup(ctx) {
    const options = parseOptions(ctx.options)
    const root = resolveDirectory(options.directory, ctx.location.directory)
    const controller = new AbortController()

    void (async () => {
      const events = ctx.event.subscribe({ signal: controller.signal })
      for await (const raw of events) {
        const event = raw as unknown as { type: string; data?: { sessionID?: string } }
        if (!(WATCHED_EVENTS as readonly string[]).includes(event.type)) continue
        const sessionID = event.data?.sessionID
        if (!sessionID) continue
        await enqueue(async () => {
          try {
            await processSession(ctx, options, root, sessionID, outcomeFor(event.type))
          } catch (error) {
            console.error("[prompt-archive] failed to record session", sessionID, error)
          }
        })
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("[prompt-archive] event stream stopped", error)
    })

    if (options.verbose) console.log(`[prompt-archive] recording to ${root}`)
    return () => controller.abort()
  },
})

export default plugin
