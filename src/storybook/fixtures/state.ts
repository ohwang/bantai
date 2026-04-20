/**
 * State builders for storybook stories.
 */

import type { SessionContextState } from "../../frontends/tui/context/session"
import type { MessagesState } from "../../frontends/tui/context/messages"
import type { PermissionsState } from "../../frontends/tui/context/permissions"
import type { Block, PermissionRequestEvent, ElicitationRequestEvent } from "../../protocol/types"

export function idleSession(overrides?: Partial<SessionContextState>): Partial<SessionContextState> {
  return {
    sessionState: "IDLE",
    session: {
      tools: [
        { name: "Read" },
        { name: "Write" },
        { name: "Edit" },
        { name: "Bash" },
        { name: "Glob" },
        { name: "Grep" },
      ],
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
        { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000 },
        { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000 },
      ],
      account: { email: "dev@example.com", plan: "Team" },
    },
    cost: {
      inputTokens: 45_000,
      outputTokens: 12_000,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 5_000,
      totalCostUsd: 0.042,
    },
    turnNumber: 3,
    lastTurnInputTokens: 45_000,
    currentModel: "claude-sonnet-4-6",
    lastError: null,
    ...overrides,
  }
}

export function runningSession(overrides?: Partial<SessionContextState>): Partial<SessionContextState> {
  return {
    ...idleSession(),
    sessionState: "RUNNING",
    ...overrides,
  }
}

export function conversationMessages(blocks: Block[], overrides?: Partial<MessagesState>): Partial<MessagesState> {
  return {
    blocks,
    streamingText: "",
    streamingThinking: "",
    activeTasks: [],
    backgrounded: false,
    ...overrides,
  }
}

export function withPermission(permission: PermissionRequestEvent): Partial<PermissionsState> {
  return {
    pendingPermission: permission,
    pendingElicitation: null,
  }
}

export function withElicitation(elicitation: ElicitationRequestEvent): Partial<PermissionsState> {
  return {
    pendingPermission: null,
    pendingElicitation: elicitation,
  }
}
