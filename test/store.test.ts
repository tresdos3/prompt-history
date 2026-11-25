import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import {
  appendToArchiveFile,
  clearSessionFlag,
  createSessionFolder,
  getSessionFlags,
  highestNumber,
  readDirNames,
  setSessionFlags,
  writeNumbered,
} from "../src/store.ts"

const TEMP_ROOT = "/private/var/folders/cv/z4kr2kj95jgb41tjvgrpy10w0000gp/T/opencode"

/** Minimal ctx.storage stub backed by a Map, shared by flag tests. */
function storageCtx() {
  const data = new Map<string, unknown>()
  return {
    ctx: {
      storage: {
        async get(key: string) { return data.get(key) },
        async set(key: string, value: unknown) { data.set(key, value) },
      },
    } as never,
    data,
  }
}

test("highestNumber parses only matching prefixes", () => {
  assert.equal(highestNumber(["01-a.md", "07-b.md", "x99.md", "10-c.md"], /^(\d{2})-/,), 10)
  assert.equal(highestNumber([], /^(\d{4})-/), 0)
})

test("readDirNames returns an empty list for a missing directory", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    assert.deepEqual(await readDirNames(path.join(base, "missing")), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("createSessionFolder numbers folders and bumps on collisions", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    const root = path.join(base, "archive")
    const first = await createSessionFolder(root, "add-login")
    assert.equal(first.name, "0001-add-login")
    const second = await createSessionFolder(root, "add-login")
    assert.equal(second.name, "0002-add-login")
    assert.deepEqual((await readdir(root)).sort(), ["0001-add-login", "0002-add-login"])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("writeNumbered bumps past existing files without overwriting", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    const dir = path.join(base, "session")
    const a = await writeNumbered(dir, 1, "prompt", "first")
    assert.equal(a, "01-prompt.md")
    // Number 01 already exists, so this must become 02 and keep the first file.
    const b = await writeNumbered(dir, 1, "prompt", "second")
    assert.equal(b, "02-prompt.md")
    assert.equal(await readFile(path.join(dir, a), "utf8"), "first")
    assert.equal(await readFile(path.join(dir, b), "utf8"), "second")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("appendToArchiveFile creates then appends", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    const root = path.join(base, "archive")
    await appendToArchiveFile(root, "SECURITY-WARNINGS.md", "one\n")
    await appendToArchiveFile(root, "SECURITY-WARNINGS.md", "two\n")
    assert.equal(await readFile(path.join(root, "SECURITY-WARNINGS.md"), "utf8"), "one\ntwo\n")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("session flags persist, merge, and can be cleared", async () => {
  const { ctx } = storageCtx()
  await setSessionFlags(ctx, "ses_1", { securityWarning: true })
  await setSessionFlags(ctx, "ses_1", { permissionRejected: true })
  assert.deepEqual(await getSessionFlags(ctx), {
    ses_1: { securityWarning: true, permissionRejected: true },
  })
  await clearSessionFlag(ctx, "ses_1", "permissionRejected")
  assert.deepEqual(await getSessionFlags(ctx), { ses_1: { securityWarning: true } })
  await clearSessionFlag(ctx, "ses_1", "securityWarning")
  assert.deepEqual(await getSessionFlags(ctx), {})
})

test("malformed stored flags are ignored", async () => {
  const { ctx, data } = storageCtx()
  data.set("prompt-archive/session-flags", "not json")
  assert.deepEqual(await getSessionFlags(ctx), {})
})
