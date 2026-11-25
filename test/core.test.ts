import assert from "node:assert/strict"
import test from "node:test"
import {
  changedFiles,
  classifyCredentialPermission,
  collectNewMessages,
  groupInteractions,
  deriveStatus,
  redactSecrets,
  renderPromptFile,
  renderResultFile,
  renderWarningEntry,
  slugify,
  truncateText,
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

test("a rejected permission marks an otherwise successful turn as failed", () => {
  const messages = [message({ id: "msg-1" })]
  assert.deepEqual(deriveStatus(messages, "succeeded", true), {
    status: "incomplete",
    outcome: "failed",
  })
  assert.deepEqual(deriveStatus(messages, "succeeded", false), {
    status: "complete",
    outcome: "succeeded",
  })
})

test("result files carry a security warning flag when requested", () => {
  const base = {
    interactionID: "ses::msg",
    sessionID: "ses",
    rootSessionID: "ses",
    agent: "build",
    promptFile: "01-prompt.md",
    timestamp: 1,
    status: "complete" as const,
    outcome: "succeeded" as const,
    responses: [],
  }
  const plain = renderResultFile(base)
  assert.doesNotMatch(plain, /security_warning/)
  const flagged = renderResultFile({ ...base, securityWarning: true })
  assert.match(flagged, /security_warning: "true"/)
})

test("slugify produces short safe names and never leaks a credential", () => {
  assert.equal(slugify("Fix the login form in src/app.ts", 6, 24), "fix-the-login-form-in-sr")
  assert.equal(slugify("***"), "interaction")
  const slug = slugify("Deploy API_KEY=sk-abc1234567890 now", 6, 48)
  assert.doesNotMatch(slug, /sk-abc1234567890/)
  assert.match(slug, /redacted/)
})

// All values below are deliberately fake; no real credentials appear in tests.
const REDACTION_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["URL credentials", "Use postgres://user:fakepass123@db.example.com:5432/app", "fakepass123"],
  ["https userinfo", "https://admin:fakesupersecret@internal.example.com", "fakesupersecret"],
  ["compound assignment", "SECRET_TOKEN=faketoken1234567890", "faketoken1234567890"],
  ["export assignment", "export MY_API_KEY=fake1234567890xyz", "fake1234567890xyz"],
  ["stripe key", "sk_live_fake1234567890abcdef", "sk_live_fake1234567890abcdef"],
  ["raw jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.abcdefghijklmnop", "abcdefghijklmnop"],
  ["ssh key", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCfakefakefake test@host", "AAAAB3NzaC1yc2E"],
  ["json password", '{"password":"fakehunter2","user":"admin"}', "fakehunter2"],
]

test("redaction removes a broad set of credential formats", () => {
  for (const [label, input, fakeSecret] of REDACTION_CASES) {
    const out = redactSecrets(input)
    assert.doesNotMatch(out, new RegExp(fakeSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), label)
    assert.match(out, /\[REDACTED\]/, label)
  }
})

test("redaction keeps ordinary prose intact", () => {
  const prose = "Refactor the login form and update the README with the new API docs."
  assert.equal(redactSecrets(prose), prose)
})

test("credential-bearing file paths never reach the archive", () => {
  const assistant = message({
    id: "msg-10",
    type: "assistant",
    snapshot: {
      files: [
        ".env",
        ".env.local",
        "/work/.aws/credentials",
        "/work/.ssh/id_rsa",
        "config/secrets.yml",
        "server/private.pem",
        "my-token.txt",
        "src/app.ts",
        "src/lib.ts",
        // Legitimate files that merely contain credential-ish substrings.
        "src/tokenizer/index.ts",
        "src/auth/password-reset.ts",
      ],
    },
  })
  assert.deepEqual(changedFiles([assistant]), [
    "src/app.ts",
    "src/lib.ts",
    "src/tokenizer/index.ts",
    "src/auth/password-reset.ts",
  ])
})

test("fake credentials never appear in rendered prompt or result files", () => {
  const fake = "sk-fake1234567890xyz"
  const prompt = renderPromptFile({
    interactionID: "ses::msg",
    sessionID: "ses",
    rootSessionID: "ses",
    agent: "build",
    title: "demo",
    timestamp: 1,
    text: `Here is a key: ${fake}`,
    status: "complete",
  })
  const result = renderResultFile({
    interactionID: "ses::msg",
    sessionID: "ses",
    rootSessionID: "ses",
    agent: "build",
    promptFile: "01-demo-prompt.md",
    timestamp: 1,
    status: "complete",
    outcome: "succeeded",
    responses: [
      message({
        id: "msg-11",
        type: "assistant",
        content: [{ type: "text", text: `Stored ${fake} in config` }],
      }),
    ],
    includeReasoning: true,
  })
  for (const rendered of [prompt, result]) {
    assert.doesNotMatch(rendered, /sk-fake1234567890xyz/)
    assert.match(rendered, /\[REDACTED\]/)
  }
})

test("credential permission classifier flags sensitive requests", () => {
  const cases = [
    { action: "read", resources: ["/work/.env"], message: "" },
    { action: "read", resources: ["/work/.aws/credentials"], message: "" },
    { action: "bash", resources: [], message: "export MY_API_KEY=fake1234567890" },
    { action: "webfetch", resources: [], message: "fetch the auth token for the API" },
    { action: "edit", resources: ["src/app.ts"], message: "update the login form" },
  ]
  const flagged = cases.map((c) => classifyCredentialPermission(c) !== undefined)
  assert.deepEqual(flagged, [true, true, true, true, false])
})

test("long bodies are truncated with a visible marker", () => {
  assert.equal(truncateText("abcdef", 10), "abcdef")
  assert.equal(truncateText("abcdef", 3), "abc\n\n[... truncated at 3 characters ...]")
  const prompt = renderPromptFile({
    interactionID: "ses::msg",
    sessionID: "ses",
    rootSessionID: "ses",
    agent: "build",
    title: "demo",
    timestamp: 1,
    text: "a".repeat(200),
    status: "complete",
    maxTextChars: 50,
  })
  assert.match(prompt, /a{50}/)
  assert.match(prompt, /truncated at 50 characters/)
})

test("slugify avoids Windows reserved names and trailing dots", () => {
  assert.equal(slugify("CON"), "con-archive")
  assert.equal(slugify("NUL.txt"), "nul-txt") // punctuation becomes a separator, so not a device name
  assert.equal(slugify("report."), "report")
  assert.equal(slugify("LPT1"), "lpt1-archive")
})

test("overlapping secret formats are all removed from one string", () => {
  const input = [
    "postgres://user:fakepass123@db",
    "Authorization: Bearer abcdef123456",
    "MY_TOKEN=faketoken1234567890",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  ].join("\n")
  const out = redactSecrets(input)
  for (const secret of ["fakepass123", "abcdef123456", "faketoken1234567890", "abcdefghijklmnop", "BEGIN PRIVATE KEY"]) {
    assert.doesNotMatch(out, new RegExp(secret), secret)
  }
  assert.equal((out.match(/\[REDACTED\]/g) ?? []).length >= 4, true)
})

test("warning reasons are sanitized and never contain raw secret values", () => {
  const warning = classifyCredentialPermission({
    action: "bash",
    resources: [".env"],
    message: "export TOKEN=sk-fake1234567890xyz",
  })
  assert.ok(warning)
  const joined = warning.reasons.join(" ")
  assert.doesNotMatch(joined, /sk-fake1234567890xyz/)
  assert.match(joined, /\[REDACTED\]/)

  const entry = renderWarningEntry({
    sessionID: "ses_fake123",
    timestamp: 1,
    reasons: warning.reasons,
    reply: "once",
  })
  assert.match(entry, /## 1970-01-01T00:00:00\.001Z — ses_fake123/)
  assert.doesNotMatch(entry, /sk-fake1234567890xyz/)
  assert.match(entry, /User reply: once/)
})
