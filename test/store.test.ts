import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import {
  appendToArchiveFile,
  clearSessionFlag,
  createSessionFolder,
  getIndex,
  getSeen,
  pruneOldSessions,
  readGitMetadata,
  setIndexEntry,
  writeArchiveFile,
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
        async get(key: string) {
          return data.get(key)
        },
        async set(key: string, value: unknown) {
          data.set(key, value)
        },
      },
    } as never,
    data,
  }
}

test("highestNumber parses only matching prefixes", () => {
  assert.equal(highestNumber(["01-a.md", "07-b.md", "x99.md", "10-c.md"], /^(\d{2})-/), 10)
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

test("date-prefixed folders do not break numbering", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    const root = path.join(base, "archive")
    await createSessionFolder(root, "first", "2026-11-25-")
    const second = await createSessionFolder(root, "second", "2026-11-25-")
    assert.equal(second.name, "2026-11-25-0002-second")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("index entries merge files and writeArchiveFile regenerates content", async () => {
  const { ctx } = storageCtx()
  await setIndexEntry(ctx, "0001-one", { title: "One", date: "2026-11-25", files: ["01-a.md"] })
  await setIndexEntry(ctx, "0001-one", { title: "", date: "", files: ["02-b.md"] })
  assert.deepEqual(await getIndex(ctx), {
    "0001-one": { title: "One", date: "2026-11-25", files: ["01-a.md", "02-b.md"] },
  })
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-store-"))
  try {
    await writeArchiveFile(base, "INDEX.md", "v1\n")
    await writeArchiveFile(base, "INDEX.md", "v2\n")
    assert.equal(await readFile(path.join(base, "INDEX.md"), "utf8"), "v2\n")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

const FAKE_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

test("git metadata is read from HEAD and loose refs", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-git-"))
  try {
    const dir = path.join(base, ".git")
    await mkdir(dir)
    await writeFile(path.join(dir, "HEAD"), "ref: refs/heads/feature/dev\n")
    await mkdir(path.join(dir, "refs/heads/feature"), { recursive: true })
    await writeFile(path.join(dir, "refs/heads/feature/dev"), `${FAKE_SHA}\n`)
    assert.deepEqual(await readGitMetadata(base), { branch: "feature/dev", commit: FAKE_SHA })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("git metadata falls back to packed-refs and returns empty without .git", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-git-"))
  try {
    assert.deepEqual(await readGitMetadata(base), {})
    const dir = path.join(base, ".git")
    await mkdir(dir)
    await writeFile(path.join(dir, "HEAD"), "ref: refs/heads/main\n")
    await writeFile(path.join(dir, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${FAKE_SHA} refs/heads/main\n`)
    assert.deepEqual(await readGitMetadata(base), { branch: "main", commit: FAKE_SHA })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("retention deletes old folders and purges their state", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-retention-"))
  try {
    const { ctx } = storageCtx()
    for (const [folder, date] of [
      ["0001-old", "2020-01-01"],
      ["0002-new", new Date().toISOString().slice(0, 10)],
    ]) {
      await mkdir(path.join(base, folder))
      await setIndexEntry(ctx, folder, {
        title: folder,
        date,
        files: [],
        sessionID: `ses-${folder}`,
        seenIDs: [`msg-${folder}`],
      })
    }
    const removed = await pruneOldSessions(ctx, base, "0002-new", 30)
    assert.deepEqual(removed, ["0001-old"])
    assert.deepEqual(await readdir(base), ["0002-new"])
    assert.deepEqual(Object.keys(await getIndex(ctx)), ["0002-new"])
    assert.deepEqual(await getSeen(ctx), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("maxSessions keeps only the newest folders", async () => {
  const base = await mkdtemp(path.join(TEMP_ROOT, "prompt-archive-retention-"))
  try {
    const { ctx } = storageCtx()
    for (const [folder, date] of [
      ["0001-a", "2020-01-01"],
      ["0002-b", "2020-01-02"],
      ["0003-c", "2020-01-03"],
    ]) {
      await mkdir(path.join(base, folder))
      await setIndexEntry(ctx, folder, { title: folder, date, files: [] })
    }
    assert.deepEqual((await pruneOldSessions(ctx, base, "0003-c", undefined, 1)).sort(), ["0001-a", "0002-b"])
    assert.deepEqual(await readdir(base), ["0003-c"])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("malformed stored flags are ignored", async () => {
  const { ctx, data } = storageCtx()
  data.set("prompt-archive/session-flags", "not json")
  assert.deepEqual(await getSessionFlags(ctx), {})
})
