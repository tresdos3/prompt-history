import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { processSession } from "../src/index.ts"
import { DEFAULT_OPTIONS } from "../src/options.ts"
import type { HistoryMessage } from "../src/core.ts"

const TEMP_ROOT = "/private/var/folders/cv/z4kr2kj95jgb41tjvgrpy10w0000gp/T/opencode"

interface FakeCtxOptions {
  messages: HistoryMessage[]
  session?: Record<string, unknown>
  location?: string
}

/** Fake OpenCode context backed by in-memory storage and session data. */
function fakeCtx({ messages, session = {}, location = TEMP_ROOT }: FakeCtxOptions) {
  const data = new Map<string, unknown>()
  const ctx = {
    location: { directory: location },
    storage: {
      async get(key: string) {
        return data.get(key)
      },
      async set(key: string, value: unknown) {
        data.set(key, value)
      },
    },
    session: {
      async get({ sessionID }: { sessionID: string }) {
        if (sessionID === "ses_root") return { id: "ses_root", agent: "build" }
        return { id: sessionID, agent: "build", ...session }
      },
      async context() {
        return messages
      },
    },
  }
  return { ctx: ctx as never, data }
}

function msg(id: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return { id, type: "user", time: { created: 1 }, ...overrides }
}

/** Session folders only — the archive root also holds INDEX.md. */
async function sessionFolders(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => /^\d/.test(name))
}

test("event pipeline writes a prompt/result pair in a numbered session folder", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add login form" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] })],
    })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
    assert.equal(folders.length, 1)
    assert.match(folders[0], /^0001-/)
    const files = (await readdir(path.join(base, folders[0]))).filter((f) => f.endsWith("-prompt.md") || f.endsWith("-result.md")).sort()
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
    const folders = await sessionFolders(base)
    assert.equal(folders.length, 1)
    const files = await readdir(path.join(base, folders[0]))
    assert.equal(files.filter((f) => f.endsWith("-prompt.md") || f.endsWith("-result.md")).length, 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("git metadata reaches frontmatter and INDEX.md", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const dir = path.join(base, ".git")
    await mkdir(dir)
    await writeFile(path.join(dir, "HEAD"), "ref: refs/heads/feature/login\n")
    await mkdir(path.join(dir, "refs/heads/feature"), { recursive: true })
    await writeFile(path.join(dir, "refs/heads/feature/login"), "abc123".padEnd(40, "0"))
    const { ctx } = fakeCtx({
      location: base,
      messages: [msg("msg_1", { text: "Add login form" })],
    })
    await processSession(ctx, DEFAULT_OPTIONS, path.join(base, "archive"), "ses_1", "succeeded")
    const folders = await sessionFolders(path.join(base, "archive"))
    const resultFile = (await readdir(path.join(base, "archive", folders[0]))).find((f) => f.endsWith("-result.md"))
    assert.ok(resultFile)
    const result = await readFile(path.join(base, "archive", folders[0], resultFile), "utf8")
    assert.match(result, /git_branch: "feature\/login"/)
    assert.match(result, /git_commit: "abc1230000/)
    const index = await readFile(path.join(base, "archive", "INDEX.md"), "utf8")
    assert.match(index, /Branch: `feature\/login`/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("INDEX.md links the recorded session and its files", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add login form" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] })],
    })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const index = await readFile(path.join(base, "INDEX.md"), "utf8")
    assert.match(index, /# Prompt archive index/)
    assert.match(index, /add-login-form/)
    assert.match(index, /01-add-login-form-prompt\.md/)
    assert.match(index, /02-build-result\.md/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("auto tags and hashtags reach frontmatter and INDEX.md", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add #LoginForm today" })],
    })
    const options = { ...DEFAULT_OPTIONS, autoTags: ["project-x"], tagFromTitle: true }
    await processSession(ctx, options, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
    const resultFile = (await readdir(path.join(base, folders[0]))).find((f) => f.endsWith("-result.md"))
    assert.ok(resultFile)
    const result = await readFile(path.join(base, folders[0], resultFile), "utf8")
    assert.match(result, /- "project-x"/)
    assert.match(result, /- "loginform"/)
    const index = await readFile(path.join(base, "INDEX.md"), "utf8")
    assert.match(index, /Tags: `project-x`, `loginform`/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("TRANSCRIPT.md is written in each session folder", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add login form" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] })],
    })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
    const transcript = await readFile(path.join(base, folders[0], "TRANSCRIPT.md"), "utf8")
    assert.match(transcript, /# Session transcript/)
    assert.match(transcript, /Add login form/)
    assert.match(transcript, /Done\./)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("configured export is regenerated with filtered content", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add login form" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] })],
    })
    const options = {
      ...DEFAULT_OPTIONS,
      export: { format: "md" as const, outFile: "SEARCH.md", text: "login" },
    }
    await processSession(ctx, options, base, "ses_1", "succeeded")
    const exported = await readFile(path.join(base, "SEARCH.md"), "utf8")
    assert.match(exported, /# Prompt archive export/)
    assert.match(exported, /Add login form/)
    await processSession(ctx, { ...options, export: { ...options.export, text: "nomatch" } }, base, "ses_1", "succeeded")
    assert.doesNotMatch(await readFile(path.join(base, "SEARCH.md"), "utf8"), /Add login form/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("force re-records already seen messages", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const messages = [msg("msg_1", { text: "Add login form" })]
    const { ctx } = fakeCtx({ messages })
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    await processSession(ctx, { ...DEFAULT_OPTIONS, force: true }, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
    const files = await readdir(path.join(base, folders[0]))
    assert.ok(files.filter((f) => f.endsWith("-prompt.md")).length >= 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("dryRun logs planned files without writing anything", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "))
  }
  try {
    const { ctx } = fakeCtx({
      messages: [msg("msg_1", { text: "Add login form" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Done." }] })],
    })
    await processSession(ctx, { ...DEFAULT_OPTIONS, dryRun: true }, base, "ses_1", "succeeded")
    assert.deepEqual(await readdir(base), [])
    assert.ok(logs.some((line) => line.includes("would write")))
    assert.ok(logs.some((line) => line.includes("01-add-login-form-prompt.md")))
  } finally {
    console.log = original
    await rm(base, { recursive: true, force: true })
  }
})

test("datePrefix adds a date to new session folder names", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx } = fakeCtx({ messages: [msg("msg_1", { text: "Add login form" })] })
    await processSession(ctx, { ...DEFAULT_OPTIONS, datePrefix: true }, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
    assert.match(folders[0], /^\d{4}-\d{2}-\d{2}-0001-/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("a rejected permission flag produces a failed result with a warning marker", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-integration-"))
  try {
    const { ctx, data } = fakeCtx({
      messages: [msg("msg_1", { text: "Read config" }), msg("msg_2", { type: "assistant", content: [{ type: "text", text: "Stopped." }] })],
    })
    data.set(
      "prompt-archive/session-flags",
      JSON.stringify({
        ses_1: { securityWarning: true, permissionRejected: true },
      }),
    )
    await processSession(ctx, DEFAULT_OPTIONS, base, "ses_1", "succeeded")
    const folders = await sessionFolders(base)
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
    const folders = await sessionFolders(base)
    assert.equal(folders.length, 1)
    assert.match(folders[0], /^0001-/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
