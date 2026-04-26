/**
 * Mock Backend — For development and testing
 *
 * Simulates a Claude-like backend without needing the SDK.
 * Streams fake responses with delays to test TUI rendering.
 *
 * Usage: bun run dev -- --backend mock
 */

/** Word-boundary match so "task" doesn't trigger "ask". */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`).test(text)
}

import type {
  BackendCapabilities,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  SessionConfig,
  SessionInfo,
  UserMessage,
} from "../../protocol/types"
import { DEFAULT_CAPABILITIES } from "../../protocol/capabilities"
import { BaseAdapter } from "../shared/base-adapter"

type PendingResolve = (result: { behavior: "allow" | "deny"; message?: string }) => void

export class MockAdapter extends BaseAdapter {
  private pendingPermission: { id: string; resolve: PendingResolve } | null = null
  private pendingElicitation: { id: string; resolve: PendingResolve } | null = null
  private interrupted = false

  capabilities(): BackendCapabilities {
    // Spread DEFAULT_CAPABILITIES first so the registry's default
    // permission modes (every known mode — mock enforces nothing, so
    // every mode is selectable) flow through automatically. Cluster 3
    // / live-bug fix: mock used to declare `supportedPermissionModes:
    // ["default"]` only, silently dropping `auto`/`dontAsk` from the
    // TUI cycler even though the mock has no policy that would reject
    // them.
    return {
      ...DEFAULT_CAPABILITIES,
      name: "mock",
      supportsThinking: true,
      supportsToolApproval: true,
      supportsSubagents: true,
    } satisfies BackendCapabilities
  }

  protected async runSession(config: SessionConfig): Promise<void> {
    if (config.resume) {
      this.eventChannel?.push({
        type: "error",
        code: "unsupported_resume",
        message: "The mock backend does not support --resume.",
        severity: "fatal",
      })
      return
    }
    if (config.continue) {
      this.eventChannel?.push({
        type: "error",
        code: "unsupported_continue",
        message: "The mock backend does not support --continue.",
        severity: "fatal",
      })
      return
    }

    // Emit session_init immediately
    this.eventChannel?.push({
      type: "session_init",
      sessionId: "mock-" + crypto.randomUUID(),
      tools: [
        { name: "Read" },
        { name: "Write" },
        { name: "Edit" },
        { name: "Bash" },
        { name: "Grep" },
        { name: "Glob" },
      ],
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
        { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      ],
    })

    // If an initialPrompt was provided (e.g. from A/B session runner),
    // pre-queue it so the message loop picks it up immediately without
    // needing an external sendMessage call.
    if (config.initialPrompt) {
      this.messageQueue.push({ text: config.initialPrompt })
    }

    // Signal readiness — mock has no async setup, ready immediately after
    // the synthetic session_init. /switch awaits this before returning.
    this.markReady()

    // Process messages via the base adapter's message loop
    await this.runMessageLoop(async (message) => {
      await this.generateResponse(message)
    })
  }

  interrupt(): void {
    this.interrupted = true
    if (this.pendingPermission) {
      this.pendingPermission.resolve({ behavior: "deny", message: "Interrupted" })
      this.pendingPermission = null
    }
    if (this.pendingElicitation) {
      this.pendingElicitation.resolve({ behavior: "deny", message: "Interrupted" })
      this.pendingElicitation = null
    }
  }

  approveToolUse(id: string): void {
    if (this.pendingPermission?.id === id) {
      this.pendingPermission.resolve({ behavior: "allow" })
      this.pendingPermission = null
    }
  }

  denyToolUse(id: string, reason?: string, _options?: { denyForSession?: boolean }): void {
    if (this.pendingPermission?.id === id) {
      this.pendingPermission.resolve({ behavior: "deny", message: reason })
      this.pendingPermission = null
    }
  }

  respondToElicitation(id: string, _answers: Record<string, string>): void {
    if (this.pendingElicitation?.id === id) {
      this.pendingElicitation.resolve({ behavior: "allow" })
      this.pendingElicitation = null
    }
  }

  cancelElicitation(id: string): void {
    if (this.pendingElicitation?.id === id) {
      this.pendingElicitation.resolve({ behavior: "deny", message: "User declined to answer" })
      this.pendingElicitation = null
    }
  }

  async setModel(_model: string): Promise<void> {}
  async setPermissionMode(_mode: PermissionMode): Promise<void> {}
  async setEffort(_level: EffortLevel): Promise<void> {}

  async availableModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    ]
  }

  async listSessions(): Promise<SessionInfo[]> {
    return []
  }

  async forkSession(): Promise<string> {
    throw new Error("Mock adapter does not support forking")
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async generateResponse(message: UserMessage): Promise<void> {
    this.interrupted = false

    this.eventChannel?.push({ type: "turn_start" })

    const text = message.text.toLowerCase()

    // Simulate thinking for certain prompts
    if (text.includes("think") || text.length > 50) {
      this.eventChannel?.push({ type: "thinking_delta", text: "Let me think about this..." })
      await this.delay(300)
      this.eventChannel?.push({ type: "thinking_delta", text: " I'll analyze the request carefully." })
      await this.delay(200)
    }

    // Simulate tool use for certain prompts
    if (text.includes("read") || text.includes("file")) {
      await this.simulateToolUse()
    }

    // Only run interactive simulations (permission, elicitation) for short
    // user-typed prompts. Long prompts (>200 chars) are typically programmatic
    // (judge, combine) and have no UI to approve/deny, so skip blocking sims.
    if (text.length <= 200) {
      // Simulate permission request
      if (text.includes("permission") || hasWord(text, "bash")) {
        await this.simulatePermission()
      }

      // Simulate subagent/task
      if (hasWord(text, "agent") || hasWord(text, "task")) {
        await this.simulateTasks()
      }

      // Simulate elicitation (ask user question)
      // Use word-boundary matching so "task" doesn't trigger "ask".
      if (hasWord(text, "ask") || hasWord(text, "question")) {
        await this.simulateElicitation()
      }
    }

    // Stream the response text
    const response = this.getResponse(text)
    const words = response.split(" ")

    for (let i = 0; i < words.length; i++) {
      if (this.interrupted) {
        this.eventChannel?.push({ type: "text_delta", text: "\n\n*[interrupted]*" })
        break
      }
      this.eventChannel?.push({ type: "text_delta", text: (i > 0 ? " " : "") + words[i] })
      // Emit live cost updates every few words
      if (i > 0 && i % 5 === 0) {
        this.eventChannel?.push({
          type: "cost_update",
          inputTokens: 0,
          outputTokens: (words[i]?.length ?? 0) * 5,
          cost: 0.0001,
        })
      }
      await this.delay(30 + Math.random() * 40)
    }

    this.eventChannel?.push({ type: "text_complete", text: response })

    this.eventChannel?.push({
      type: "turn_complete",
      usage: {
        inputTokens: message.text.length * 2,
        outputTokens: response.length,
        totalCostUsd: 0.001 + Math.random() * 0.005,
      },
    })
  }

  private async simulateToolUse(): Promise<void> {
    const toolId = `tool_${Date.now()}`

    this.eventChannel?.push({
      type: "tool_use_start",
      id: toolId,
      tool: "Read",
      input: { file_path: "/src/protocol/types.ts" },
    })

    await this.delay(200)

    this.eventChannel?.push({
      type: "tool_use_progress",
      id: toolId,
      output: "Reading file...",
    })

    await this.delay(300)

    this.eventChannel?.push({
      type: "tool_use_end",
      id: toolId,
      output: "interface AgentBackend {\n  start(): AsyncGenerator<AgentEvent>\n  sendMessage(msg: UserMessage): void\n  ...\n}",
    })
  }

  private async simulatePermission(): Promise<void> {
    const permId = `perm_${Date.now()}`

    this.eventChannel?.push({
      type: "permission_request",
      id: permId,
      tool: "Bash",
      input: { command: "echo 'hello world'" },
    })

    // Wait for approve/deny
    const result = await new Promise<{ behavior: "allow" | "deny" }>((resolve) => {
      this.pendingPermission = {
        id: permId,
        resolve: (r) => resolve(r),
      }
    })

    // Emit permission_response to transition state machine back to RUNNING
    this.eventChannel?.push({ type: "permission_response", id: permId, behavior: result.behavior })
  }

  private async simulateTasks(): Promise<void> {
    const task1 = `task_${Date.now()}_1`
    const task2 = `task_${Date.now()}_2`

    this.eventChannel?.push({ type: "task_start", taskId: task1, description: "Researching codebase" })
    await this.delay(300)
    this.eventChannel?.push({ type: "task_start", taskId: task2, description: "Running tests" })
    await this.delay(500)
    this.eventChannel?.push({ type: "task_complete", taskId: task1, output: "Found 12 relevant files" })
    await this.delay(400)
    this.eventChannel?.push({ type: "task_complete", taskId: task2, output: "All 97 tests passing" })
  }

  private async simulateElicitation(): Promise<void> {
    const elicId = `elic_${Date.now()}`

    this.eventChannel?.push({
      type: "elicitation_request",
      id: elicId,
      questions: [
        {
          question: "Which framework would you like to use?",
          options: [
            { label: "React" },
            { label: "SolidJS" },
            { label: "Vue" },
            { label: "Svelte" },
          ],
          allowFreeText: true,
        },
      ],
    })

    // Wait for user response
    const result = await new Promise<{ behavior: "allow" | "deny" }>((resolve) => {
      this.pendingElicitation = {
        id: elicId,
        resolve: (r) => resolve(r),
      }
    })

    // Emit elicitation_response to transition state machine back to RUNNING
    this.eventChannel?.push({ type: "elicitation_response", id: elicId, answers: {} })

    if (result.behavior === "deny") {
      this.eventChannel?.push({ type: "text_delta", text: "\n\nOk, I'll skip that question.\n\n" })
    }
  }

  private getResponse(input: string): string {
    if (input.includes("hello") || input.includes("hi")) {
      return "Hello! I'm the mock backend for bantai. I simulate Claude's responses for TUI development. Try asking me to read a file or run a bash command to see tool use and permission flows."
    }
    if (input.includes("help")) {
      return "I can simulate:\n- **Streaming text** (every message)\n- **Thinking blocks** (include 'think' in your message)\n- **Tool use** (include 'read' or 'file')\n- **Permission prompts** (include 'permission' or 'bash')\n- **Elicitations** (include 'ask' or 'question')\n- **Subagents** (include 'agent' or 'task')\n- **Interrupts** (press Ctrl+C while I'm streaming)"
    }
    if (input.includes("error")) {
      return "This would be an error scenario in the real backend."
    }
    return `You said: "${input}"\n\nThis is a mock response from the development backend. The real Claude backend will provide actual AI-generated responses. The mock lets you test the TUI rendering, tool display, permission flow, and keyboard shortcuts without an API key.`
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
