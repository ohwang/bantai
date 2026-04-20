/**
 * Stories for Conversation category — all block types, streaming, tasks, toasts.
 * Ordered to match how blocks appear in the conversation flow.
 */

import type { Story } from "../types"
import { UserBlock } from "../../frontends/tui/components/blocks/user-block"
import { AssistantBlock } from "../../frontends/tui/components/blocks/assistant-block"
import { SystemBlock } from "../../frontends/tui/components/blocks/system-block"
import { ErrorBlock } from "../../frontends/tui/components/blocks/error-block"
import { ShellBlock } from "../../frontends/tui/components/blocks/shell-block"
import { CompactBlock } from "../../frontends/tui/components/blocks/compact-block"
import { QueuedMessage } from "../../frontends/tui/components/blocks/queued-message"
import { ThinkingBlock } from "../../frontends/tui/components/thinking-block"
import { ToolBlockView } from "../../frontends/tui/components/tool-view"
import { SkillToolView, CollapsedSkillLine } from "../../frontends/tui/components/skill-tool-view"
import { CollapsedToolGroup } from "../../frontends/tui/components/collapsed-tool-group"
import { StreamingSpinner } from "../../frontends/tui/components/streaming-spinner"
import { TaskView } from "../../frontends/tui/components/task-view"
import { TurnSummary } from "../../frontends/tui/components/turn-summary"
import { ToastDisplay } from "../../frontends/tui/components/toast"
import { BlockView } from "../../frontends/tui/components/block-view"
import { useMessages } from "../../frontends/tui/context/messages"
import type { ViewLevel } from "../../frontends/tui/components/tool-view"
import type { ToolGroup } from "../../frontends/tui/utils/tool-grouping"
import type { Block, TaskInfo, TurnFileChange } from "../../protocol/types"
import {
  userBlock,
  assistantBlock,
  toolBlock,
  systemBlock,
  errorBlock,
  shellBlock,
  compactBlock,
} from "../fixtures/blocks"
import { idleSession, runningSession, conversationMessages } from "../fixtures/state"

type ToolBlock = Extract<Block, { type: "tool" }>

function makeToolGroup(blocks: ToolBlock[]): ToolGroup {
  const toolCounts: Record<string, number> = {}
  for (const b of blocks) {
    toolCounts[b.tool] = (toolCounts[b.tool] ?? 0) + 1
  }
  return {
    type: "group",
    blocks,
    totalDuration: blocks.reduce((sum, b) => sum + (b.duration ?? 0), 0),
    toolCounts,
    status: blocks.some((b) => b.status === "running") ? "running" : blocks.some((b) => b.status === "error") ? "error" : "done",
  }
}

function makeTasks(entries: { id: string; desc: string; status: "running" | "completed"; output?: string }[]): [string, TaskInfo][] {
  return entries.map((e) => [e.id, { taskId: e.id, description: e.desc, output: e.output ?? "", status: e.status, startTime: Date.now() - 30_000 }])
}

/** Helper: renders blocks from messages context */
function ConversationBlocks(props: { viewLevel: ViewLevel }) {
  const { state } = useMessages()
  return (
    <box flexDirection="column">
      {state.blocks.map((block, i) => (
        <BlockView block={block} viewLevel={props.viewLevel} prevType={i > 0 ? state.blocks[i - 1]?.type : undefined} showThinking={props.viewLevel !== "collapsed"} />
      ))}
    </box>
  )
}

export const conversationStories: Story[] = [
  // ── User messages ──
  {
    id: "user-block",
    title: "UserBlock",
    description: "User message with prompt indicator",
    category: "Conversation",
    render: () => <UserBlock block={userBlock("Fix the authentication bug in the login flow")} />,
    variants: [
      { label: "simple", render: () => <UserBlock block={userBlock("Fix the authentication bug in the login flow")} /> },
      { label: "with images", render: () => <UserBlock block={userBlock("What does this error mean?", { images: [{ data: "", mediaType: "image/png" }, { data: "", mediaType: "image/png" }] })} /> },
    ],
  },

  // ── Assistant responses ──
  {
    id: "assistant-block",
    title: "AssistantBlock",
    description: "Assistant response with markdown and fade-in",
    category: "Conversation",
    render: () => (
      <AssistantBlock
        block={assistantBlock("I'll fix the authentication bug. The issue is in `src/auth/login.ts` where the token validation skips the expiry check.\n\n```typescript\nif (token.exp < Date.now() / 1000) {\n  throw new AuthError('Token expired')\n}\n```\n\nThis should resolve the issue.")}
      />
    ),
    variants: [
      { label: "short", render: () => <AssistantBlock block={assistantBlock("I'll fix the authentication bug. The issue is in `src/auth/login.ts` where the token validation skips the expiry check.\n\n```typescript\nif (token.exp < Date.now() / 1000) {\n  throw new AuthError('Token expired')\n}\n```\n\nThis should resolve the issue.")} /> },
      { label: "long", render: () => <AssistantBlock block={assistantBlock("## Analysis\n\nI found three issues in the codebase:\n\n1. **Token expiry** is not validated in `login.ts`\n2. **Session storage** uses deprecated `localStorage` API\n3. **CORS headers** are missing from the auth endpoint\n\n### Recommended Fix\n\nLet me update each file:\n\n- `src/auth/login.ts` — add expiry validation\n- `src/middleware/cors.ts` — add auth endpoint to allowlist\n- `src/session/store.ts` — migrate to `SessionStorage`")} /> },
    ],
  },

  // ── Thinking ──
  {
    id: "thinking-block",
    title: "ThinkingBlock",
    description: "Claude's reasoning process (collapsed/expanded)",
    category: "Conversation",
    render: () => <ThinkingBlock text={"The user wants to fix an auth bug. Let me check:\n- `login.ts` handles token creation\n- `middleware.ts` validates on each request\n- The expiry field is `exp` in JWT spec\n\nI think the issue is that `Date.now()` returns milliseconds but JWT `exp` is in seconds."} />,
    variants: [
      { label: "expanded", render: () => <ThinkingBlock text={"The user wants to fix an auth bug. Let me check:\n- `login.ts` handles token creation\n- `middleware.ts` validates on each request\n\nI think the issue is that `Date.now()` returns milliseconds but JWT `exp` is in seconds."} /> },
      { label: "collapsed", render: () => <ThinkingBlock text="Let me analyze the code structure..." collapsed /> },
      { label: "long text", render: () => <ThinkingBlock text={"Let me trace through the authentication flow step by step.\n\n1. User submits credentials to POST /api/login\n2. Server calls findUser(email) to look up the account\n3. bcrypt.compare() verifies the password hash\n4. jwt.sign() creates a token with { sub, exp, iat }\n5. Token is returned in the response body\n6. Client stores it in localStorage\n7. On each request, middleware reads Authorization header\n8. jwt.verify() validates signature and expiry\n9. If valid, req.user is set for downstream handlers\n10. If expired, 401 is returned with 'Token expired'\n11. The refresh endpoint accepts the old token\n12. It issues a new token with a fresh exp claim\n\nI see the bug now — line 4 uses Date.now() directly, which gives milliseconds, but JWT exp is supposed to be in seconds (Unix timestamp)."} /> },
    ],
  },

  // ── Tool views ──
  {
    id: "tool-block-view",
    title: "ToolBlockView",
    description: "Single tool invocation with status, output, error",
    category: "Conversation",
    render: () => <ToolBlockView block={toolBlock("Read", { file_path: "/src/auth/login.ts" }, { output: "import { jwt } from './jwt'\n\nexport async function login(email: string, password: string) {\n  const user = await findUser(email)\n  if (!user || !verify(password, user.hash)) {\n    throw new AuthError('Invalid credentials')\n  }\n  return jwt.sign({ sub: user.id, exp: Date.now() / 1000 + 3600 })\n}", duration: 45 })} viewLevel="expanded" />,
    variants: [
      { label: "Read expanded", render: () => <ToolBlockView block={toolBlock("Read", { file_path: "/src/auth/login.ts" }, { output: "import { jwt } from './jwt'\n\nexport async function login() { ... }", duration: 45 })} viewLevel="expanded" /> },
      { label: "Read collapsed", render: () => <ToolBlockView block={toolBlock("Read", { file_path: "/src/auth/login.ts" }, { output: "export function login() {...}", duration: 45 })} viewLevel="collapsed" /> },
      { label: "Edit collapsed", render: () => <ToolBlockView block={toolBlock("Edit", { file_path: "/src/auth/login.ts", old_string: "Date.now()", new_string: "Math.floor(Date.now() / 1000)" }, { output: "--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -5 @@\n-  Date.now()\n+  Math.floor(Date.now() / 1000)", duration: 120 })} viewLevel="collapsed" /> },
      // Edit expanded / show_all: covers the <diff> renderable path and the
      // synthesized-from-input path (Claude SDK returns a prose success
      // message, not a diff — resolveDiffText() builds one from the input).
      { label: "Edit expanded (synthesized diff from input)", render: () => <ToolBlockView block={toolBlock("Edit", { file_path: "/src/auth/login.ts", old_string: "Date.now() / 1000 + 3600", new_string: "Math.floor(Date.now() / 1000) + 3600" }, { output: "The file /src/auth/login.ts has been updated. Here's the result of running `cat -n` on a snippet.", duration: 85 })} viewLevel="expanded" /> },
      { label: "Edit show_all (synthesized diff)", render: () => <ToolBlockView block={toolBlock("Edit", { file_path: "/src/auth/login.ts", old_string: "Date.now() / 1000 + 3600", new_string: "Math.floor(Date.now() / 1000) + 3600" }, { output: "The file /src/auth/login.ts has been updated.", duration: 85 })} viewLevel="show_all" /> },
      { label: "Edit show_all (ACP pre-formatted diff)", render: () => <ToolBlockView block={toolBlock("Edit", { file_path: "/src/auth/login.ts" }, { output: "--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -1,3 +1,3 @@\n-const x = 1\n-const y = 2\n-const z = 3\n+const x = 10\n+const y = 20\n+const z = 30", duration: 85 })} viewLevel="show_all" /> },
      { label: "Write show_all (file creation)", render: () => <ToolBlockView block={toolBlock("Write", { file_path: "/src/new-module.ts", content: "export function hello() {\n  return 'world'\n}\n" }, { output: "File created successfully.", duration: 30 })} viewLevel="show_all" /> },
      { label: "Bash running", render: () => <ToolBlockView block={toolBlock("Bash", { command: "npm test -- --watch" }, { status: "running" })} viewLevel="expanded" /> },
      { label: "Bash error", render: () => <ToolBlockView block={toolBlock("Bash", { command: "rm -rf /protected" }, { status: "error", error: "Permission denied", duration: 50 })} viewLevel="expanded" /> },
      { label: "Grep expanded", render: () => <ToolBlockView block={toolBlock("Grep", { pattern: "AuthError", path: "/src" }, { output: "src/auth/login.ts:12:    throw new AuthError('Invalid')\nsrc/auth/refresh.ts:8:    throw new AuthError('Expired')\nsrc/middleware/auth.ts:25:    throw new AuthError('Missing')", duration: 200 })} viewLevel="expanded" /> },
    ],
  },

  // ── Collapsed tool groups ──
  {
    id: "collapsed-tool-group",
    title: "CollapsedToolGroup",
    description: "Grouped consecutive tool uses in a single line",
    category: "Conversation",
    render: () => (
      <CollapsedToolGroup
        group={makeToolGroup([
          toolBlock("Read", { file_path: "/src/auth/login.ts" }, { duration: 45 }),
          toolBlock("Read", { file_path: "/src/auth/refresh.ts" }, { duration: 30 }),
          toolBlock("Grep", { pattern: "AuthError" }, { duration: 200 }),
          toolBlock("Glob", { pattern: "src/**/*.test.ts" }, { duration: 15 }),
        ])}
      />
    ),
    variants: [
      { label: "done", render: () => <CollapsedToolGroup group={makeToolGroup([toolBlock("Read", { file_path: "/src/auth/login.ts" }, { duration: 45 }), toolBlock("Read", { file_path: "/src/auth/refresh.ts" }, { duration: 30 }), toolBlock("Grep", { pattern: "AuthError" }, { duration: 200 }), toolBlock("Glob", { pattern: "src/**/*.test.ts" }, { duration: 15 })])} /> },
      { label: "running", render: () => <CollapsedToolGroup group={makeToolGroup([toolBlock("Read", { file_path: "/src/auth/login.ts" }, { duration: 45 }), toolBlock("Bash", { command: "npm test" }, { status: "running" })])} /> },
    ],
  },

  // ── Skill tool views ──
  {
    id: "skill-tool-view",
    title: "SkillToolView",
    description: "Skill invocation with name, progress, and result",
    category: "Conversation",
    render: () => (
      <SkillToolView
        block={toolBlock("Skill", { skill: "commit", args: "-m 'Fix auth bug'" }, { output: "Analyzing staged changes and recent commits...\nCreated commit: Fix auth bug in login flow", duration: 2500 })}
        viewLevel="expanded"
      />
    ),
    variants: [
      {
        label: "completed",
        render: () => (
          <SkillToolView
            block={toolBlock("Skill", { skill: "commit", args: "-m 'Fix auth bug'" }, { output: "Analyzing staged changes and recent commits...\nCreated commit: Fix auth bug in login flow", duration: 2500 })}
            viewLevel="expanded"
          />
        ),
      },
      {
        label: "running",
        render: () => (
          <SkillToolView
            block={toolBlock("Skill", { skill: "ship" }, { status: "running", output: "Running tests...\nChecking diff against main..." })}
            viewLevel="expanded"
          />
        ),
      },
      {
        label: "error",
        render: () => (
          <SkillToolView
            block={toolBlock("Skill", { skill: "review" }, { status: "error", error: "No staged changes found", duration: 200 })}
            viewLevel="expanded"
          />
        ),
      },
      {
        label: "show_all",
        render: () => (
          <SkillToolView
            block={toolBlock("Skill", { skill: "ship" }, { output: "Running tests...\nbun test v1.2.3\n\n 12 pass\n 0 fail\n\nAll tests passed. Creating PR...\nPR #42 created: https://github.com/org/repo/pull/42", duration: 8500 })}
            viewLevel="show_all"
          />
        ),
      },
      {
        label: "collapsed",
        render: () => (
          <CollapsedSkillLine
            block={toolBlock("Skill", { skill: "commit", args: "-m 'Fix auth'" }, { output: "Created commit abc1234", duration: 1200 })}
          />
        ),
      },
      {
        label: "collapsed running",
        render: () => (
          <CollapsedSkillLine
            block={toolBlock("Skill", { skill: "ship" }, { status: "running" })}
          />
        ),
      },
      {
        label: "collapsed error",
        render: () => (
          <CollapsedSkillLine
            block={toolBlock("Skill", { skill: "review" }, { status: "error", error: "No changes found" })}
          />
        ),
      },
    ],
  },

  // ── System messages ──
  {
    id: "system-block",
    title: "SystemBlock",
    description: "Categorized system messages with icons",
    category: "Conversation",
    render: () => <SystemBlock block={systemBlock("Model switched to claude-opus-4-6")} />,
    variants: [
      { label: "info", render: () => <SystemBlock block={systemBlock("Model switched to claude-opus-4-6")} /> },
      { label: "success", render: () => <SystemBlock block={systemBlock("Copied to clipboard (42 chars): hello world")} /> },
      { label: "interrupt", render: () => <SystemBlock block={systemBlock("Turn interrupted by user")} /> },
      { label: "denial", render: () => <SystemBlock block={systemBlock("Permission denied for Bash command")} /> },
      { label: "error", render: () => <SystemBlock block={systemBlock("Failed to read file: ENOENT")} /> },
      {
        label: "all types",
        render: () => (
          <box flexDirection="column">
            <SystemBlock block={systemBlock("Model switched to claude-opus-4-6")} />
            <SystemBlock block={systemBlock("Turn interrupted by user")} />
            <SystemBlock block={systemBlock("Permission denied for Bash command")} />
            <SystemBlock block={systemBlock("Failed to read file: ENOENT")} />
            <SystemBlock block={systemBlock("Copied to clipboard (42 chars): hello world")} />
          </box>
        ),
      },
    ],
  },

  // ── Shell blocks ──
  {
    id: "shell-block",
    title: "ShellBlock",
    description: "User-initiated shell command output",
    category: "Conversation",
    render: () => <ShellBlock block={shellBlock("git status", { output: "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n", status: "done" })} viewLevel="expanded" />,
    variants: [
      { label: "done", render: () => <ShellBlock block={shellBlock("git status", { output: "On branch main\nYour branch is up to date.\n\nnothing to commit, working tree clean\n", status: "done" })} viewLevel="expanded" /> },
      { label: "running", render: () => <ShellBlock block={shellBlock("npm test", { status: "running" })} viewLevel="collapsed" /> },
      { label: "error", render: () => <ShellBlock block={shellBlock("cat /nonexistent", { output: "", error: "cat: /nonexistent: No such file or directory", exitCode: 1, status: "error" })} viewLevel="expanded" /> },
    ],
  },

  // ── Compact block ──
  {
    id: "compact-block",
    title: "CompactBlock",
    description: "Compacted conversation summary with lifecycle states",
    category: "Conversation",
    render: () => <CompactBlock block={compactBlock("Discussed authentication architecture. Decided on JWT with refresh tokens. Updated login.ts, middleware.ts, and session store.", { trigger: "user", preTokens: 85000, postTokens: 12000 })} />,
    variants: [
      { label: "in-progress", render: () => <CompactBlock block={compactBlock("Compacting conversation...", { inProgress: true, trigger: "user" })} /> },
      { label: "with-savings", render: () => <CompactBlock block={compactBlock("Reviewed code architecture, discussed testing strategy, and planned deployment pipeline.", { trigger: "user", preTokens: 120000, postTokens: 25000 })} /> },
      { label: "auto-compact", render: () => <CompactBlock block={compactBlock("Conversation auto-compacted by backend.", { trigger: "auto", preTokens: 95000, postTokens: 18000 })} /> },
      { label: "no-metadata", render: () => <CompactBlock block={compactBlock("Conversation compacted.")} /> },
    ],
  },

  // ── Error block ──
  {
    id: "error-block",
    title: "ErrorBlock",
    description: "Bordered error display with code",
    category: "Conversation",
    render: () => <ErrorBlock block={errorBlock("stream_error", "Connection to API lost. Check your network connection and API key.")} />,
  },

  // ── Queued messages ──
  {
    id: "queued-message",
    title: "QueuedMessage",
    description: "Queued user message (sent while agent is running)",
    category: "Conversation",
    render: () => <QueuedMessage block={userBlock("Can you also add rate limiting?")} />,
    variants: [
      { label: "single", render: () => <QueuedMessage block={userBlock("Can you also add rate limiting?")} /> },
      {
        label: "multiple",
        render: () => (
          <box flexDirection="column">
            <QueuedMessage block={userBlock("Can you also add rate limiting?")} />
            <QueuedMessage block={userBlock("And update the tests")} />
            <QueuedMessage block={userBlock("Actually, skip the tests for now")} />
          </box>
        ),
      },
    ],
  },

  // ── Streaming spinner ──
  {
    id: "streaming-spinner",
    title: "StreamingSpinner",
    description: "Braille dot spinner with stall detection",
    category: "Conversation",
    context: { session: runningSession() },
    render: () => <StreamingSpinner label="Thinking" elapsedSeconds={5} />,
    variants: [
      { label: "thinking", render: () => <StreamingSpinner label="Thinking" elapsedSeconds={5} /> },
      { label: "long running", render: () => <StreamingSpinner label="Thinking" elapsedSeconds={349} outputTokens={8500} /> },
      { label: "tool active", render: () => <StreamingSpinner label="Running Bash" elapsedSeconds={12} /> },
    ],
  },

  // ── Task view ──
  {
    id: "task-view",
    title: "TaskView",
    description: "Subagent/background task display",
    category: "Conversation",
    render: () => (
      <TaskView
        tasks={makeTasks([
          { id: "t1", desc: "Searching for authentication files", status: "running" },
          { id: "t2", desc: "Analyzing test coverage", status: "completed", output: "Found 12 test files, 85% coverage" },
          { id: "t3", desc: "Reviewing middleware chain", status: "running" },
        ])}
      />
    ),
    variants: [
      { label: "running", render: () => <TaskView tasks={makeTasks([{ id: "t1", desc: "Searching for authentication files", status: "running" }, { id: "t2", desc: "Analyzing test coverage", status: "completed", output: "Found 12 test files, 85% coverage" }, { id: "t3", desc: "Reviewing middleware chain", status: "running" }])} /> },
      { label: "all done", render: () => <TaskView tasks={makeTasks([{ id: "t1", desc: "Searching for authentication files", status: "completed", output: "Found 3 auth files" }, { id: "t2", desc: "Analyzing test coverage", status: "completed", output: "85% coverage" }])} /> },
      { label: "overflow", render: () => <TaskView tasks={makeTasks([{ id: "t1", desc: "Reading source files", status: "completed", output: "Done" }, { id: "t2", desc: "Analyzing dependencies", status: "completed", output: "Done" }, { id: "t3", desc: "Running linter", status: "completed", output: "0 errors" }, { id: "t4", desc: "Running type checker", status: "completed", output: "0 errors" }, { id: "t5", desc: "Running unit tests", status: "running" }, { id: "t6", desc: "Running integration tests", status: "running" }, { id: "t7", desc: "Building documentation", status: "running" }, { id: "t8", desc: "Checking code coverage", status: "running" }, { id: "t9", desc: "Security audit", status: "running" }, { id: "t10", desc: "Performance benchmarks", status: "running" }, { id: "t11", desc: "E2E test suite", status: "running" }, { id: "t12", desc: "Deploy verification", status: "running" }])} /> },
    ],
  },

  // ── Turn summary ──
  {
    id: "turn-summary",
    title: "TurnSummary",
    description: "File changes from the last turn",
    category: "Conversation",
    render: () => {
      const files: TurnFileChange[] = [
        { path: "src/auth/login.ts", action: "edit", tool: "Edit" },
        { path: "src/auth/refresh.ts", action: "create", tool: "Write" },
        { path: "src/middleware/auth.ts", action: "edit", tool: "Edit" },
        { path: "tests/auth.test.ts", action: "read", tool: "Read" },
      ]
      return <TurnSummary files={files} />
    },
  },

  // ── Toast display ──
  {
    id: "toast-display",
    title: "ToastDisplay",
    description: "Toast notification area",
    category: "Conversation",
    render: () => (
      <box flexDirection="column">
        <text fg="#a8a8a8">Toast area (toasts are triggered programmatically via toast.info/success/warn/error)</text>
        <box height={1} />
        <ToastDisplay />
      </box>
    ),
  },

  // ── Full conversation views ──
  {
    id: "conversation-full",
    title: "Full conversation",
    description: "Multi-turn conversation with blocks, tools, and system messages",
    category: "Conversation",
    context: {
      session: idleSession(),
      messages: conversationMessages([
        userBlock("Fix the authentication bug in the login flow"),
        assistantBlock("I'll investigate the authentication issue. Let me start by reading the relevant files."),
        toolBlock("Read", { file_path: "/src/auth/login.ts" }, { output: "export function login() {\n  // token validation\n}", duration: 45 }),
        toolBlock("Read", { file_path: "/src/auth/middleware.ts" }, { output: "export function authMiddleware() {\n  // check token\n}", duration: 32 }),
        toolBlock("Grep", { pattern: "AuthError", path: "/src" }, { output: "src/auth/login.ts:12:throw new AuthError('expired')", duration: 120 }),
        assistantBlock("Found the issue. The token expiry check uses `Date.now()` which returns milliseconds, but JWT `exp` is in seconds.\n\n```typescript\n// Before:\nif (token.exp < Date.now()) { ... }\n// After:\nif (token.exp < Math.floor(Date.now() / 1000)) { ... }\n```"),
        toolBlock("Edit", { file_path: "/src/auth/login.ts", old_string: "Date.now()", new_string: "Math.floor(Date.now() / 1000)" }, { output: "--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -5,7 +5,7 @@\n-  Date.now()\n+  Math.floor(Date.now() / 1000)", duration: 85 }),
        systemBlock("Model switched to claude-opus-4-6"),
        userBlock("Now run the tests"),
        assistantBlock("Running the test suite to verify the fix."),
        shellBlock("bun test tests/auth/", { output: "PASS tests/auth/login.test.ts\nPASS tests/auth/middleware.test.ts\n\n2 tests passed", duration: 3400 }),
        assistantBlock("All auth tests pass."),
      ]),
    },
    render: () => <ConversationBlocks viewLevel="expanded" />,
    variants: [
      { label: "expanded" },
      { label: "collapsed", render: () => <ConversationBlocks viewLevel="collapsed" /> },
    ],
  },
]
