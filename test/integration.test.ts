import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { processSession } from "../src/index.ts"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import type { HistoryMessage } from "../src/core.ts"

const TEMP_ROOT = "/private/var/folders/cv/z4kr2kj95jgb41tjvgrpy10w0000gp/T/opencode"

interface FakeCtxOptions {
  messages: HistoryMessage[]
  session?: Record<string, unknown>
}

/** Fake OpenCode context backed by in-memory storage and session data. */
function fakeCtx({ messages, session = {} }: FakeCtxOptions) {
  const data = new Map<string, unknown>()
  const ctx = {
    storage: {
      async get(key: string) { return data.get(key) },
      async set(key: string, value: unknown) { data.set(key, value) },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "ses_root") return { id: "ses_root", agent: "build" }
        return { id: sessionID, agent: "build", ...session }
      },
      async context() { return messages },
    },
  }
  return { ctx: ctx as never, data }
}

function msg(id: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return { id, type: "user", time: { created: 1 }, ...overrides }
}

test("event pipeline writes a prompt/result pair in a numbered session folder", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [
        msg("msg_1", { text: "Add login form" }),
        msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] }),
      ],
    })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await readdir(base)
    assert.equal(folders.length, 1)
    assert.match(folders[0], /^0001-/)
    const files = (await readdir(path.join(base, folders[0]))).sort()
    assert.deepEqual(files, ["01-add-login-form-prompt.md", "02-build-result.md"])
    const prompt = await readFile(path.join(base, folders[0], files[0]), "utf8")
    assert.match(prompt, /interaction: "ses_1::msg_1"/)
    assert.match(prompt, /Add login form/)
    const result = await readFile(path.join(base, folders[0], files[1]), "utf8")
    assert.match(result, /interaction: "ses_1::msg_1"/)
    assert.match(result, /Done\./)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("a second event for the same session does not duplicate recorded messages", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const messages = [
      msg("msg_1", { text: "Add login form" }),
      msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] }),
    ]
    const { ctx } = fakeCtx({ messages })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await readdir(base)
    assert.equal(folders.length, 1)
    const files = await readdir(path.join(base, folders[0]))
    assert.equal(files.length, 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("a rejected permission flag produces a failed result with a warning marker", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx, data } = fakeCtx({
      messages: [
        msg("msg_1", { text: "Read config" }),
        msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Stopped." }] }),
      ],
    })
    data.set("prompt-archive/session-flags", JSON.stringify({
      ses_1: { securityWarning: true, permissionRejected: true },
    }))
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await readdir(base)
    const resultFile = (await readdir(path.join(base, folders[0]))).find((f) => f.endsWith("-result.md"))
    assert.ok(resultFile)
    const result = await readFile(path.join(base, folders[0], resultFile), "utf8")
    assert.match(result, /status: "incomplete"/)
    assert.match(result, /outcome: "failed"/)
    assert.match(result, /security_warning: "true"/)
    // The rejection is one-shot: it must be cleared after being applied.
    assert.deepEqual(JSON.parse(data.get("prompt-archive/session-flags") as string), {
      ses_1: { securityWarning: true },
    })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("subagent messages share the root session folder", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      session: { id: "ses_child", parentID: "ses_root", agent: "explore" },
      messages: [
        msg("msg_1", { text: "Search code" }),
        msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Found it." }] }),
      ],
    })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_child", "succeeded")
    const folders = await readdir(base)
    assert.equal(folders.length, 1)
    assert.match(folders[0], /^0001-/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
