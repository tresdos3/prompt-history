import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_OPTIONS, parseOptions, resolveDirectory } from "../src/options.ts"

test("options use safe defaults with no configuration", () => {
  assert.deepEqual(parseOptions(undefined), DEFAULT_OPTIONS)
  assert.deepEqual(parseOptions({}), DEFAULT_OPTIONS)
})

test("options accept valid overrides", () => {
  const parsed = parseOptions({
    directory: "/tmp/archive",
    includeReasoning: true,
    includeTools: false,
    includeChangedFiles: false,
    maxChangedFiles: 5,
    maxTextChars: 1234,
    verbose: true,
    warnOnCredentialPermission: true,
  })
  assert.equal(parsed.directory, "/tmp/archive")
  assert.equal(parsed.includeReasoning, true)
  assert.equal(parsed.includeTools, false)
  assert.equal(parsed.includeChangedFiles, false)
  assert.equal(parsed.maxChangedFiles, 5)
  assert.equal(parsed.maxTextChars, 1234)
  assert.equal(parsed.verbose, true)
  assert.equal(parsed.warnOnCredentialPermission, true)
})

test("invalid options fall back to defaults", () => {
  const parsed = parseOptions({
    directory: "",
    includeReasoning: "yes",
    maxChangedFiles: -3,
  })
  assert.equal(parsed.directory, DEFAULT_OPTIONS.directory)
  assert.equal(parsed.includeReasoning, false)
  assert.equal(parsed.maxChangedFiles, 0)
  assert.equal(parsed.maxTextChars, DEFAULT_OPTIONS.maxTextChars)
})

test("relative directories resolve against the project directory", () => {
  assert.equal(resolveDirectory("docs/history", "/work/project"), "/work/project/docs/history")
  assert.equal(resolveDirectory("/var/history", "/work/project"), "/var/history")
})
