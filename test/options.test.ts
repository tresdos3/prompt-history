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
    force: true,
    datePrefix: true,
    maxParentDepth: 8,
    dryRun: true,
    export: { format: "jsonl", outFile: "all.jsonl", agent: "build", status: "complete" },
    promptTemplate: "# {{title}}\n{{body}}",
    resultTemplate: "{{agent}}: {{body}}",
    includeTranscript: false,
    transcriptName: "TALK.md",
    retentionDays: 7,
    maxSessions: 10,
    autoTags: ["team-a", "team-a", "team-b"],
    tagFromTitle: true,
    includeProjectName: true,
    paused: true,
  })
  assert.equal(parsed.directory, "/tmp/archive")
  assert.equal(parsed.includeReasoning, true)
  assert.equal(parsed.includeTools, false)
  assert.equal(parsed.includeChangedFiles, false)
  assert.equal(parsed.maxChangedFiles, 5)
  assert.equal(parsed.maxTextChars, 1234)
  assert.equal(parsed.verbose, true)
  assert.equal(parsed.warnOnCredentialPermission, true)
  assert.equal(parsed.force, true)
  assert.equal(parsed.datePrefix, true)
  assert.equal(parsed.maxParentDepth, 8)
  assert.equal(parsed.dryRun, true)
  assert.deepEqual(parsed.export, { format: "jsonl", outFile: "all.jsonl", agent: "build", status: "complete" })
  assert.equal(parsed.promptTemplate, "# {{title}}\n{{body}}")
  assert.equal(parsed.resultTemplate, "{{agent}}: {{body}}")
  assert.equal(parsed.includeTranscript, false)
  assert.equal(parsed.transcriptName, "TALK.md")
  assert.equal(parsed.retentionDays, 7)
  assert.equal(parsed.maxSessions, 10)
  assert.deepEqual(parsed.autoTags, ["team-a", "team-a", "team-b"])
  assert.equal(parsed.tagFromTitle, true)
  assert.equal(parsed.includeProjectName, true)
  assert.equal(parsed.paused, true)
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
