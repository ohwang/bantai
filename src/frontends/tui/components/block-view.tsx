/**
 * BlockView — thin dispatcher that routes each block to its renderer.
 *
 * Per-type renderers live in ./blocks/. This file handles the dispatch,
 * turn separators, and the CollapsedToolLine (which has complex state).
 */

import { Show, createSignal, createEffect, onCleanup, type Accessor } from "solid-js"
import { useAgent } from "../context/agent"
import { PlanBlock } from "./plan-block"
import { ThinkingBlock } from "./thinking-block"
import { ToolBlockView, isUserDecline } from "./tool-view"
import { AgentToolView, CollapsedAgentLine } from "./agent-tool-view"
import { SkillToolView, CollapsedSkillLine } from "./skill-tool-view"
import { McpToolView, CollapsedMcpLine, isMcpTool } from "./mcp-tool-view"
import { colors } from "../theme/tokens"
import type { Block } from "../../../protocol/types"
import type { ViewLevel } from "./tool-view"
import { BlinkingDot } from "./primitives"
import { truncatePathMiddle, truncateToWidth } from "../../../utils/truncate"
import { UserBlock } from "./blocks/user-block"
import { AssistantBlock } from "./blocks/assistant-block"
import { SystemBlock, type SystemCategory, categorizeSystemMessage } from "./blocks/system-block"
import { ErrorBlock } from "./blocks/error-block"
import { CompactBlock } from "./blocks/compact-block"
import { ShellBlock } from "./blocks/shell-block"
import { SessionResumeSummaryView } from "./blocks/session-resume-summary-view"

// Re-export for consumers that import from block-view
export type { SystemCategory }
export { categorizeSystemMessage }

export function BlockView(props: { block: Block; viewLevel: ViewLevel; prevType?: string; showThinking?: boolean }) {
  const b = () => props.block

  // Typed narrowing helpers
  const userBlock = () => b().type === "user" ? b() as Extract<Block, { type: "user" }> : null
  const assistantBlock = () => b().type === "assistant" ? b() as Extract<Block, { type: "assistant" }> : null
  const thinkingBlock = () => b().type === "thinking" ? b() as Extract<Block, { type: "thinking" }> : null
  const toolBlock = () => b().type === "tool" ? b() as Extract<Block, { type: "tool" }> : null
  const systemBlock = () => b().type === "system" ? b() as Extract<Block, { type: "system" }> : null
  const compactBlock = () => b().type === "compact" ? b() as Extract<Block, { type: "compact" }> : null
  const shellBlock = () => b().type === "shell" ? b() as Extract<Block, { type: "shell" }> : null
  const errorBlock = () => b().type === "error" ? b() as Extract<Block, { type: "error" }> : null
  const planBlock = () => b().type === "plan" ? b() as Extract<Block, { type: "plan" }> : null
  const resumeSummaryBlock = () => b().type === "session_resume_summary" ? b() as Extract<Block, { type: "session_resume_summary" }> : null

  return (
    <box flexDirection="column">
      <Show when={userBlock()}>{(ub: Accessor<Extract<Block, { type: "user" }>>) =>
        <box marginTop={1}>
          <UserBlock block={ub()} />
        </box>
      }</Show>
      <Show when={assistantBlock()}>{(ab: Accessor<Extract<Block, { type: "assistant" }>>) =>
        <box marginTop={1}><AssistantBlock block={ab()} /></box>
      }</Show>

      {/* Thinking block — hidden in collapsed view or when thinking toggle is off */}
      <Show when={props.showThinking !== false && props.viewLevel !== "collapsed" && thinkingBlock()}>{(tb: Accessor<Extract<Block, { type: "thinking" }>>) =>
        <box marginTop={1}>
          <ThinkingBlock text={tb().text} collapsed={false} />
        </box>
      }</Show>

      {/* Tool block — tight grouping for consecutive tools.
          Agent, Skill, and MCP tools get specialized rendering. */}
      <Show when={toolBlock()}>{(tb: Accessor<Extract<Block, { type: "tool" }>>) =>
        <box marginTop={props.prevType !== "tool" ? 1 : 0}>
          <Show
            when={tb().tool !== "Agent"}
            fallback={
              <Show
                when={props.viewLevel !== "collapsed"}
                fallback={<CollapsedAgentLine block={tb()} />}
              >
                <AgentToolView block={tb()} viewLevel={props.viewLevel} />
              </Show>
            }
          >
            <Show
              when={tb().tool !== "Skill"}
              fallback={
                <Show
                  when={props.viewLevel !== "collapsed"}
                  fallback={<CollapsedSkillLine block={tb()} />}
                >
                  <SkillToolView block={tb()} viewLevel={props.viewLevel} />
                </Show>
              }
            >
              <Show
                when={!isMcpTool(tb().tool)}
                fallback={
                  <Show
                    when={props.viewLevel !== "collapsed"}
                    fallback={<CollapsedMcpLine block={tb()} />}
                  >
                    <McpToolView block={tb()} viewLevel={props.viewLevel} />
                  </Show>
                }
              >
                <Show
                  when={props.viewLevel !== "collapsed"}
                  fallback={<CollapsedToolLine block={tb()} />}
                >
                  <ToolBlockView block={tb()} viewLevel={props.viewLevel} />
                </Show>
              </Show>
            </Show>
          </Show>
        </box>
      }</Show>

      <Show when={systemBlock()}>{(sb: Accessor<Extract<Block, { type: "system" }>>) => <box marginTop={1}><SystemBlock block={sb()} /></box>}</Show>
      <Show when={shellBlock()}>{(sb: Accessor<Extract<Block, { type: "shell" }>>) => <box marginTop={1}><ShellBlock block={sb()} viewLevel={props.viewLevel} /></box>}</Show>
      <Show when={compactBlock()}>{(cb: Accessor<Extract<Block, { type: "compact" }>>) => <box marginTop={1}><CompactBlock block={cb()} /></box>}</Show>
      <Show when={errorBlock()}>{(eb: Accessor<Extract<Block, { type: "error" }>>) => <box marginTop={1}><ErrorBlock block={eb()} /></box>}</Show>
      <Show when={planBlock()}>{(pb: Accessor<Extract<Block, { type: "plan" }>>) =>
        <box marginTop={1}>
          <PlanBlock entries={pb().entries} />
        </box>
      }</Show>
      <Show when={resumeSummaryBlock()}>{(rb: Accessor<Extract<Block, { type: "session_resume_summary" }>>) =>
        <SessionResumeSummaryView block={rb()} />
      }</Show>
    </box>
  )
}

/** Collapsed single-line tool summary — avoids destroying/recreating ToolBlockView on view toggle.
 *
 * Each line gets a status icon prefix for instant scannability:
 *   ✓ = success (green), ✗ = error (red), ⋯ = running (accent), ↳ = declined (dim)
 *
 * This matches the visual density of polished terminal UIs where every tool
 * invocation is instantly identifiable by its outcome without expanding.
 */
function CollapsedToolLine(props: { block: Extract<Block, { type: "tool" }> }) {
  const b = () => props.block

  // Path display roots at the active session's cwd, NOT process.cwd(). The
  // bantai launcher captures launch dir into flags.config.cwd but never
  // process.chdir()s, so the two diverge whenever --cwd points elsewhere.
  // See permission-audit.md §F-2.
  const agent = useAgent()
  const sessionCwd = () => agent.config.cwd ?? process.cwd()

  // --- Minimum display time: keep showing "running" for at least 700ms after completion ---
  const MIN_DISPLAY_MS = 700
  const [displayRunning, setDisplayRunning] = createSignal(b().status === "running")
  let minDisplayTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (b().status === "running") {
      setDisplayRunning(true)
      clearTimeout(minDisplayTimer)
    } else {
      // Tool completed — delay the visual transition
      minDisplayTimer = setTimeout(() => setDisplayRunning(false), MIN_DISPLAY_MS)
    }
  })
  onCleanup(() => clearTimeout(minDisplayTimer))

  // --- Elapsed time for running tools — updates every second ---
  const [elapsed, setElapsed] = createSignal(0)
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    if (displayRunning() && b().status === "running") {
      setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      elapsedTimer = setInterval(() => {
        setElapsed(Math.floor((Date.now() - b().startTime) / 1000))
      }, 1000)
    } else {
      if (elapsedTimer) {
        clearInterval(elapsedTimer)
        elapsedTimer = undefined
      }
    }
  })
  onCleanup(() => { if (elapsedTimer) clearInterval(elapsedTimer) })

  const primaryArg = () => {
    const inp = b().input as Record<string, unknown> | null
    if (!inp) return ""
    if (inp.file_path) {
      const raw = String(inp.file_path)
      const cwd = sessionCwd()
      const rel = raw.startsWith(cwd + "/") ? raw.slice(cwd.length + 1) : raw
      return ` ${truncatePathMiddle(rel, 60)}`
    }
    if (inp.command) {
      return ` ${truncateToWidth(String(inp.command), 60)}`
    }
    if (inp.pattern) return ` ${String(inp.pattern)}`
    if (inp.query) return `(${truncateToWidth(String(inp.query), 50)})`
    return ""
  }

  const hint = () => {
    if (displayRunning()) {
      const out = b().output ?? ""
      if (out) {
        const lines = out.split('\n').filter((l: string) => l.trim())
        const lastLine = lines[lines.length - 1] ?? ""
        const truncated = lastLine.length > 50 ? lastLine.slice(0, 47) + "..." : lastLine
        const lineCount = lines.length
        const secs = elapsed()
        const timeStr = secs > 0 ? ` (${secs}s)` : ""
        return `... ${truncated} [${lineCount} line${lineCount === 1 ? "" : "s"}${timeStr}]`
      }
      const secs = elapsed()
      return secs > 0 ? `... ${secs}s` : "..."
    }
    if (b().error) {
      return isUserDecline(b().error!) ? " — declined" : " — failed"
    }
    const out = b().output ?? ""
    if (!out) return ""
    if (b().tool === "Read" || b().tool === "Glob" || b().tool === "Grep") {
      const lines = out.trim().split("\n").filter((l: string) => l.trim()).length
      return ` — ${lines} result${lines === 1 ? "" : "s"}`
    }
    return ""
  }

  /** BlinkingDot status for the prefix gutter */
  const dotStatus = (): "active" | "success" | "error" | "declined" => {
    if (displayRunning()) return "active"
    if (b().error) {
      if (isUserDecline(b().error!)) return "declined"
      return "error"
    }
    return "success"
  }

  const isError = () => !!(b().error && !isUserDecline(b().error!))

  return (
    <box flexDirection="row">
      <box width={2} flexShrink={0}>
        <BlinkingDot status={dotStatus()} />
      </box>
      <text
        fg={isError() ? colors.status.error : colors.text.muted}
      >
        {b().tool + primaryArg() + hint()}
      </text>
    </box>
  )
}
