import assert from "node:assert/strict"
import test from "node:test"
import {
  changedFiles,
  collectNewMessages,
  groupInteractions,
  deriveStatus,
  redactSecrets,
  renderPromptFile,
  renderResultFile,
  slugify,
  type HistoryMessage,
} from "../src/core.ts"

function message(overrides: Partial<HistoryMessage> & { id: string }): HistoryMessage {
  return {
    type: "user",
    time: { created: 1 },
    ...overrides,
  }
}

test("secret redaction removes credential-shaped values but keeps normal prose", () => {
  const input =
    "Use API_KEY=sk-abc1234567890 and Bearer abcdef123456. " +
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" +
    "Keep this sentence."
  const out = redactSecrets(input)
  assert.doesNotMatch(out, /sk-abc1234567890/)
  assert.doesNotMatch(out, /abcdef123456/)
  assert.doesNotMatch(out, /BEGIN PRIVATE KEY/)
  assert.match(out, /\[REDACTED\]/)
  assert.match(out, /Keep this sentence\./)
})

test("prompt capture writes a redacted prompt with identifying frontmatter", () => {
  const markdown = renderPromptFile({
    interactionID: "ses-1::msg-1",
    sessionID: "ses-1",
    parentSessionID: "ses-parent",
    rootSessionID: "ses-root",
    agent: "build",
    title: "add-login",
    timestamp: 1,
    text: "Set TOKEN=hunter2 here",
    status: "complete",
  })
  assert.match(markdown, /^---\n/)
  assert.match(markdown, /kind: "prompt"/)
  assert.match(markdown, /interaction: "ses-1::msg-1"/)
  assert.match(markdown, /session_id: "ses-1"/)
  assert.match(markdown, /agent: "build"/)
  assert.match(markdown, /timestamp: "1970-01-01T00:00:00\.001Z"/)
  assert.match(markdown, /TOKEN=\[REDACTED\]/)
  assert.doesNotMatch(markdown, /hunter2/)
})

test("response capture extracts text, tools, changed files and outcome", () => {
  const assistant = message({
    id: "msg-2",
    type: "assistant",
    agent: "build",
    content: [
      { type: "text", text: "Done." },
      { type: "tool", name: "bash" },
      { type: "tool", name: "read" },
    ],
    snapshot: { files: ["src/app.ts", "src/lib.ts"] },
  })
  const markdown = renderResultFile({
    interactionID: "ses-1::msg-1",
    sessionID: "ses-1",
    rootSessionID: "ses-1",
    agent: "build",
    promptFile: "01-prompt.md",
    timestamp: 1,
    status: "complete",
    outcome: "succeeded",
    responses: [assistant],
  })
  assert.match(markdown, /kind: "result"/)
  assert.match(markdown, /outcome: "succeeded"/)
  assert.match(markdown, /prompt_file: "01-prompt.md"/)
  assert.match(markdown, /Done\./)
  assert.match(markdown, /## Tools used/)
  assert.match(markdown, /- bash/)
  assert.match(markdown, /## Changed files/)
  assert.deepEqual(changedFiles([assistant]), ["src/app.ts", "src/lib.ts"])
})

test("response text is redacted and dependency internals are excluded", () => {
  const assistant = message({
    id: "msg-9",
    type: "assistant",
    agent: "build",
    content: [{ type: "text", text: "Done. API_KEY=sk-secret1234567890" }],
    snapshot: {
      files: ["node_modules/pkg/index.js", "src/app.ts", ".git/config", "src/app.ts"],
    },
  })
  const markdown = renderResultFile({
    interactionID: "ses-1::msg-1",
    sessionID: "ses-1",
    rootSessionID: "ses-1",
    agent: "build",
    promptFile: "01-prompt.md",
    timestamp: 1,
    status: "complete",
    outcome: "succeeded",
    responses: [assistant],
  })
  assert.doesNotMatch(markdown, /sk-secret1234567890/)
  assert.match(markdown, /API_KEY=\[REDACTED\]/)
  assert.doesNotMatch(markdown, /node_modules/)
  assert.doesNotMatch(markdown, /\.git\/config/)
  assert.deepEqual(changedFiles([assistant]), ["src/app.ts"])
})

test("reasoning is opt-in and finite changed-file limits are respected", () => {
  const assistant = message({
    id: "msg-3",
    type: "assistant",
    content: [{ type: "reasoning", text: "secret reasoning TOKEN=abc123456789" }],
    snapshot: { files: ["a.ts", "b.ts", "c.ts"] },
  })
  const without = renderResultFile({
    interactionID: "x",
    sessionID: "s",
    rootSessionID: "s",
    agent: "build",
    promptFile: "01-prompt.md",
    timestamp: 1,
    status: "complete",
    outcome: "succeeded",
    responses: [assistant],
  })
  assert.doesNotMatch(without, /## Reasoning/)
  assert.deepEqual(changedFiles([assistant], 0), [])
  const withReasoning = renderResultFile({
    interactionID: "x",
    sessionID: "s",
    rootSessionID: "s",
    agent: "build",
    promptFile: "01-prompt.md",
    timestamp: 1,
    status: "complete",
    outcome: "succeeded",
    responses: [assistant],
    includeReasoning: true,
  })
  assert.match(withReasoning, /## Reasoning/)
  assert.doesNotMatch(withReasoning, /abc123456789/)
  assert.match(withReasoning, /TOKEN=\[REDACTED\]/)
})

test("duplicate prevention skips already recorded messages", () => {
  const messages = [
    message({ id: "msg-1" }),
    message({ id: "msg-2", type: "assistant" }),
    message({ id: "msg-3" }),
  ]
  assert.deepEqual(collectNewMessages(messages, new Set()).map((m) => m.id), ["msg-1", "msg-2", "msg-3"])
  assert.deepEqual(collectNewMessages(messages, new Set(["msg-1", "msg-2"])).map((m) => m.id), ["msg-3"])
})

test("interactions pair prompts with their assistant responses", () => {
  const messages = [
    message({ id: "msg-1", text: "first" }),
    message({ id: "msg-2", type: "assistant" }),
    message({ id: "msg-3", type: "assistant" }),
    message({ id: "msg-4", text: "second" }),
    message({ id: "msg-5", type: "assistant" }),
  ]
  const groups = groupInteractions(messages)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].responses.map((m) => m.id), ["msg-2", "msg-3"])
  assert.deepEqual(groups[1].responses.map((m) => m.id), ["msg-5"])
})

test("interrupted executions are marked incomplete", () => {
  const messages = [message({ id: "msg-1" })]
  assert.deepEqual(deriveStatus(messages, "interrupted"), {
    status: "incomplete",
    outcome: "interrupted",
  })
  assert.deepEqual(deriveStatus(messages, "succeeded"), {
    status: "complete",
    outcome: "succeeded",
  })
})

test("slugify produces short safe names and never leaks a credential", () => {
  assert.equal(slugify("Fix the login form in src/app.ts", 6, 24), "fix-the-login-form-in-sr")
  assert.equal(slugify("***"), "interaction")
  const slug = slugify("Deploy API_KEY=sk-abc1234567890 now", 6, 48)
  assert.doesNotMatch(slug, /sk-abc1234567890/)
  assert.match(slug, /redacted/)
})
