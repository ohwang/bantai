/**
 * ACP Protocol Type Definitions
 *
 * Types for the Agent Client Protocol (ACP) wire format.
 * Based on protocol version 1.
 *
 * Reference: https://agentclientprotocol.com/protocol/schema
 */

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface AcpInitializeParams {
  protocolVersion: number
  clientInfo: AcpClientInfo
  clientCapabilities: AcpClientCapabilities
}

export interface AcpClientInfo {
  name: string
  version: string
  title?: string
}

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean
    writeTextFile?: boolean
  }
  terminal?: boolean
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo: AcpAgentInfo
  agentCapabilities: AcpAgentCapabilities
  authMethods?: AcpAuthMethod[]
}

export interface AcpAgentInfo {
  name: string
  title: string
  version: string
}

export interface AcpAgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: {
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
  mcpCapabilities?: {
    http?: boolean
    sse?: boolean
  }
}

export interface AcpAuthMethod {
  id: string
  name: string
  description: string
  _meta?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface AcpSessionNewParams {
  cwd: string
  mcpServers: unknown[]
}

export interface AcpSessionNewResult {
  sessionId: string
  modes?: AcpModeState
  models?: AcpModelState
  configOptions?: AcpConfigOption[]
}

export interface AcpModeState {
  availableModes: AcpMode[]
  currentModeId: string
}

export interface AcpMode {
  id: string
  name: string
  description?: string
}

export interface AcpModelState {
  availableModels: AcpModel[]
  currentModelId: string
}

export interface AcpModel {
  modelId?: string    // Gemini-style ID
  value?: string      // ACP spec ID
  name?: string       // Display name (may be absent)
  description?: string
  _meta?: Record<string, unknown>  // Copilot adds _meta with copilotUsage etc.
}

// ---------------------------------------------------------------------------
// Config Options
// ---------------------------------------------------------------------------

export interface AcpConfigOption {
  id: string
  name: string
  description?: string
  category?: string  // ACP spec: "mode" | "model" | "thought_level"
  type: "string" | "boolean" | "enum" | "select"  // "select" is Copilot's alias for "enum"
  value?: unknown
  currentValue?: unknown  // Copilot uses currentValue instead of value
  options?: AcpConfigOptionChoice[]  // for enum/select type
}

export interface AcpConfigOptionChoice {
  id?: string
  value?: string    // Copilot uses value instead of id
  name: string
  description?: string
}

export interface AcpConfigOptionUpdateNotification {
  configOption: AcpConfigOption
}

export interface AcpSetConfigOptionParams {
  sessionId: string
  configOptionId: string
  value: unknown
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface AcpPromptParams {
  sessionId: string
  prompt: AcpContentBlock[]
}

export interface AcpPromptResult {
  stopReason: string
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type AcpContentBlock =
  | AcpTextContent
  | AcpImageContent
  | AcpResourceLink

export interface AcpTextContent {
  type: "text"
  text: string
}

export interface AcpImageContent {
  type: "image"
  mimeType: string
  data: string // base64
  uri?: string
}

export interface AcpResourceLink {
  type: "resource_link"
  uri: string
  name: string
  mimeType?: string
}

// ---------------------------------------------------------------------------
// Session Update (streaming notifications)
// ---------------------------------------------------------------------------

export interface AcpSessionUpdateParams {
  sessionId: string
  update: AcpUpdate
}

export type AcpUpdate =
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpPlanUpdate
  | AcpAvailableCommandsUpdate
  | AcpGenericUpdate

export interface AcpAgentMessageChunk {
  sessionUpdate: "agent_message_chunk"
  content: AcpContentBlock
}

export interface AcpAgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk"
  content: AcpContentBlock
}

export interface AcpToolCall {
  sessionUpdate: "tool_call"
  toolCallId: string
  title?: string
  kind?: string
  status: string
  content: AcpToolContent[]
  locations?: AcpLocation[]
  rawInput?: unknown
  rawOutput?: unknown
}

export interface AcpToolCallUpdate {
  sessionUpdate: "tool_call_update"
  toolCallId: string
  title?: string
  kind?: string
  status?: string
  content?: AcpToolContent[]
  locations?: AcpLocation[]
  rawInput?: unknown
  rawOutput?: unknown
}

export interface AcpPlanEntry {
  content?: string
  priority?: "high" | "medium" | "low"
  status?: "pending" | "in_progress" | "completed"
  title?: string
  text?: string // alias for content in some agents
}

export interface AcpPlanUpdate {
  sessionUpdate: "plan"
  entries: AcpPlanEntry[]
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: "available_commands_update"
  availableCommands: AcpSlashCommand[]
}

export interface AcpGenericUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Tool content
// ---------------------------------------------------------------------------

export type AcpToolContent =
  | { type: "content"; content: AcpContentBlock }
  | { type: "diff"; path: string; oldText: string; newText: string }
  | { type: "terminal"; terminalId: string }

export interface AcpLocation {
  path: string
  line?: number
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface AcpSlashCommand {
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// Permission request (server-initiated request)
// ---------------------------------------------------------------------------

export interface AcpPermissionRequestParams {
  sessionId: string
  toolCall: {
    toolCallId: string
  }
  options: AcpPermissionOption[]
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export interface AcpPermissionResponse {
  outcome: {
    outcome: "selected" | "cancelled"
    optionId?: string
  }
}

// ---------------------------------------------------------------------------
// Elicitation (agent-initiated request to client)
// ---------------------------------------------------------------------------

export interface AcpElicitationParams {
  sessionId: string
  message: string
  schema?: AcpElicitationSchema
}

export interface AcpElicitationSchema {
  type: "object"
  properties?: Record<string, AcpElicitationProperty>
  required?: string[]
}

export interface AcpElicitationProperty {
  type: "string" | "boolean" | "number" | "enum"
  description?: string
  enum?: string[]
  default?: unknown
}

export interface AcpElicitationResponse {
  action: "submit" | "cancel"
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Cancel (notification, not request)
// ---------------------------------------------------------------------------

export interface AcpCancelParams {
  sessionId: string
}

// ---------------------------------------------------------------------------
// Set mode
// ---------------------------------------------------------------------------

export interface AcpSetModeParams {
  sessionId: string
  modeId: string
}

// ---------------------------------------------------------------------------
// Filesystem (agent-initiated requests to client)
// ---------------------------------------------------------------------------

export interface AcpFsReadParams {
  sessionId: string
  path: string
  line?: number
  limit?: number
}

export interface AcpFsWriteParams {
  sessionId: string
  path: string
  content: string
}

// ---------------------------------------------------------------------------
// Terminal (agent-initiated requests to client)
// ---------------------------------------------------------------------------

export interface AcpTerminalCreateParams {
  sessionId: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeout?: number  // ms
}

export interface AcpTerminalCreateResult {
  terminalId: string
}

export interface AcpTerminalOutputParams {
  sessionId: string
  terminalId: string
}

export interface AcpTerminalOutputResult {
  output: string
  isComplete: boolean
}

export interface AcpTerminalWaitParams {
  sessionId: string
  terminalId: string
}

export interface AcpTerminalWaitResult {
  exitCode: number
}

export interface AcpTerminalKillParams {
  sessionId: string
  terminalId: string
  signal?: string  // e.g., "SIGTERM", "SIGKILL"
}

export interface AcpTerminalReleaseParams {
  sessionId: string
  terminalId: string
}

// ---------------------------------------------------------------------------
// Session Load (resume previous session)
// ---------------------------------------------------------------------------

export interface AcpSessionLoadParams {
  sessionId: string
}
// Result is AcpSessionNewResult (same shape)

// ---------------------------------------------------------------------------
// ACP preset shape — used by the registry's BackendDescriptor.acpPreset to
// describe how to spawn an ACP-speaking subprocess. The actual catalogue of
// known presets (gemini / copilot / qwen / …) lives in
// `src/protocol/registry.ts` so adding a new ACP backend is a single registry
// entry rather than a parallel map here.
// ---------------------------------------------------------------------------

export interface AcpPreset {
  command: string
  args: string[]
  displayName: string
}
