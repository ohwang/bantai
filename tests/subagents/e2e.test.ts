/**
 * E2E Integration Tests — Subagent System
 *
 * Exercises the full stack: definition loading from .claude/agents/,
 * backend factory, SubagentManager lifecycle, MCP tools, and slash commands.
 * Uses the MockAdapter for reliable event pipeline testing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { SubagentManager } from "../../src/subagents/manager"
import { loadDefinitionsFromDir } from "../../src/subagents/definitions"
import { instantiateBackend } from "../../src/protocol/registry"
import type { AgentEvent } from "../../src/protocol/types"
import type { AgentDefinition } from "../../src/subagents/types"
import { join } from "path"

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolve project root — the tests run from the repo root via `bun test` */
const PROJECT_ROOT = join(import.meta.dir, "../..")
const AGENTS_DIR = join(PROJECT_ROOT, "tests/fixtures/agents")

describe("E2E: Subagent System", () => {
  // -------------------------------------------------------------------------
  // Definition loading
  // -------------------------------------------------------------------------

  describe("Definition loading", () => {
    test("loads project definitions from .claude/agents/", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      expect(defs.length).toBeGreaterThanOrEqual(4)

      const names = defs.map((d) => d.name)
      expect(names).toContain("researcher")
      expect(names).toContain("gemini-helper")
      expect(names).toContain("codex-reviewer")
      expect(names).toContain("mock-test")
    })

    test("each definition has correct backend", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      const byName = new Map(defs.map((d) => [d.name, d]))

      expect(byName.get("researcher")!.backend).toBe("claude")
      expect(byName.get("gemini-helper")!.backend).toBe("gemini")
      expect(byName.get("codex-reviewer")!.backend).toBe("codex")
      expect(byName.get("mock-test")!.backend).toBe("mock")
    })

    test("definitions have system prompts", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      for (const def of defs) {
        expect(def.systemPrompt.length).toBeGreaterThan(0)
      }
    })

    test("researcher has model and effort", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      const researcher = defs.find((d) => d.name === "researcher")!
      expect(researcher.model).toBe("claude-sonnet-4-20250514")
      expect(researcher.effort).toBe("low")
    })

    test("mock-test has color", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      const mockDef = defs.find((d) => d.name === "mock-test")!
      expect(mockDef.color).toBe("cyan")
    })

    test("all definitions have maxTurns", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      for (const def of defs) {
        expect(def.maxTurns).toBeGreaterThan(0)
      }
    })

    test("all definitions have bypassPermissions", () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      for (const def of defs) {
        expect(def.permissionMode).toBe("bypassPermissions")
      }
    })
  })

  // -------------------------------------------------------------------------
  // Backend factory
  // -------------------------------------------------------------------------

  describe("Backend factory", () => {
    test("creates mock backend", () => {
      const backend = instantiateBackend("mock")
      expect(backend).toBeDefined()
      expect(backend.capabilities().name).toBe("mock")
      backend.close()
    })

    test("creates claude backend", () => {
      const backend = instantiateBackend("claude")
      expect(backend).toBeDefined()
      expect(backend.capabilities().name).toBe("claude")
      backend.close()
    })

    test("creates codex backend", () => {
      const backend = instantiateBackend("codex")
      expect(backend).toBeDefined()
      expect(backend.capabilities().name).toBe("codex")
      backend.close()
    })

    test("creates gemini backend", () => {
      const backend = instantiateBackend("gemini")
      expect(backend).toBeDefined()
      expect(backend.capabilities().name).toBe("gemini")
      backend.close()
    })

    test("throws on unknown backend", () => {
      expect(() => instantiateBackend("nonexistent")).toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Mock subagent lifecycle (full integration through SubagentManager)
  // -------------------------------------------------------------------------

  describe("Mock subagent lifecycle", () => {
    let manager: SubagentManager
    let events: AgentEvent[]

    beforeEach(() => {
      manager = new SubagentManager()
      events = []
      manager.setPushEvent((e) => events.push(e))
    })

    afterEach(() => {
      manager.closeAll()
    })

    test("full spawn -> progress -> complete cycle with mock", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        description: "Test agent",
        systemPrompt: "You are a test agent",
        backend: "mock",
        permissionMode: "bypassPermissions",
        filePath: ".claude/agents/mock-test.md",
      }

      const id = manager.spawn({
        definition: mockDef,
        prompt: "Say hello",
        backendOverride: "mock",
      })

      expect(id).toMatch(/^subagent-/)

      // Wait for async event loop: session_init -> sendMessage -> generateResponse
      // Mock has ~30-70ms per word delays, "hello" response is ~30 words
      await wait(3000)

      // Should have received task_start (emitted synchronously)
      const taskStart = events.find((e) => e.type === "task_start")
      expect(taskStart).toBeDefined()
      expect((taskStart as any).taskId).toBe(id)
      expect((taskStart as any).source).toBe("native")
      expect((taskStart as any).backendName).toBe("mock")

      // Should have received task_progress events (from text_complete and turn_complete)
      const progressEvents = events.filter((e) => e.type === "task_progress")
      expect(progressEvents.length).toBeGreaterThan(0)

      // Check status reflects processed turn
      const status = manager.getStatus(id)
      expect(status).toBeDefined()
      expect(status!.backendName).toBe("mock")
      expect(status!.turnCount).toBeGreaterThanOrEqual(1)
      expect(status!.output.length).toBeGreaterThan(0)
    })

    test("load definition from file and spawn", async () => {
      const defs = loadDefinitionsFromDir(AGENTS_DIR)
      const mockDef = defs.find((d) => d.name === "mock-test")
      expect(mockDef).toBeDefined()

      const id = manager.spawn({
        definition: mockDef!,
        prompt: "Hello from E2E test",
      })

      await wait(3000)

      const status = manager.getStatus(id)
      expect(status).toBeDefined()
      expect(status!.definitionName).toBe("mock-test")
      expect(status!.backendName).toBe("mock")
      expect(status!.sessionId).toMatch(/^mock-/)
    })

    test("multiple concurrent subagents", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        systemPrompt: "Test",
        backend: "mock",
        filePath: "test.md",
      }

      // Use simple prompts that don't trigger mock special behaviors
      // (avoid: "task", "agent", "read", "file", "bash", "permission", "ask", "question")
      const id1 = manager.spawn({
        definition: mockDef,
        prompt: "hello one",
        backendOverride: "mock",
      })
      const id2 = manager.spawn({
        definition: mockDef,
        prompt: "hello two",
        backendOverride: "mock",
      })
      const id3 = manager.spawn({
        definition: mockDef,
        prompt: "hello three",
        backendOverride: "mock",
      })

      expect(id1).not.toBe(id2)
      expect(id2).not.toBe(id3)

      await wait(4000)

      // All should have started (task_start is synchronous from manager)
      const starts = events.filter((e) => e.type === "task_start")
      expect(starts.length).toBe(3)

      // Each has its own taskId
      const taskIds = starts.map((e) => (e as any).taskId)
      expect(new Set(taskIds).size).toBe(3)

      // All should have produced progress events
      const progressByTask = new Map<string, number>()
      for (const e of events.filter((e) => e.type === "task_progress")) {
        const tid = (e as any).taskId
        progressByTask.set(tid, (progressByTask.get(tid) ?? 0) + 1)
      }
      expect(progressByTask.size).toBe(3)
    })

    test("stop a running subagent", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        systemPrompt: "Test",
        backend: "mock",
        filePath: "test.md",
      }

      const id = manager.spawn({
        definition: mockDef,
        prompt: "hello long",
        backendOverride: "mock",
      })

      // Wait for it to start
      await wait(500)

      manager.stop(id)

      const status = manager.getStatus(id)
      expect(status!.state).toBe("completed")
      expect(status!.endTime).toBeDefined()

      // Should have emitted task_complete
      const completes = events.filter((e) => e.type === "task_complete")
      expect(completes.length).toBeGreaterThanOrEqual(1)
      const stopComplete = completes.find(
        (e) => (e as any).taskId === id && (e as any).state === "completed",
      )
      expect(stopComplete).toBeDefined()
    })

    test("sessionId captured from session_init", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        systemPrompt: "Test",
        backend: "mock",
        filePath: "test.md",
      }

      const id = manager.spawn({
        definition: mockDef,
        prompt: "hello",
        backendOverride: "mock",
      })

      // session_init is emitted immediately by MockAdapter's runSession
      await wait(500)

      const status = manager.getStatus(id)
      expect(status!.sessionId).toBeDefined()
      expect(status!.sessionId).toMatch(/^mock-/)
    })

    test(
      "sendMessage queues and delivers on next turn",
      async () => {
        const mockDef: AgentDefinition = {
          name: "mock-test",
          systemPrompt: "Test",
          backend: "mock",
          filePath: "test.md",
        }

        const id = manager.spawn({
          definition: mockDef,
          prompt: "hello",
          backendOverride: "mock",
        })

        // Queue the follow-up MID-TURN so the manager stores it in
        // messageQueue (midTurn=true). On turn_complete, the queued
        // message is dequeued and delivered, triggering a second turn.
        // If we waited until after turn_complete, the subagent would
        // auto-terminate (see SubagentManager.handleTurnComplete) and
        // sendMessage would be a no-op.
        await wait(300)
        manager.sendMessage(id, "hi again")

        // Wait for both turns to complete. Mock responses are ~33 words
        // at 30-70ms each = ~1.6-2.3s per turn; two turns plus overhead
        // comfortably fit in 6s.
        await wait(6000)

        const statusAfter = manager.getStatus(id)
        expect(statusAfter!.turnCount).toBeGreaterThanOrEqual(2)
      },
      { timeout: 15000 },
    )

    test("closeAll terminates all running subagents", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        systemPrompt: "Test",
        backend: "mock",
        filePath: "test.md",
      }

      const id1 = manager.spawn({
        definition: mockDef,
        prompt: "Task A",
        backendOverride: "mock",
      })
      const id2 = manager.spawn({
        definition: mockDef,
        prompt: "Task B",
        backendOverride: "mock",
      })

      await wait(500)

      manager.closeAll()

      expect(manager.getStatus(id1)!.state).toBe("error")
      expect(manager.getStatus(id1)!.errorMessage).toBe("Session ended")
      expect(manager.getStatus(id2)!.state).toBe("error")
      expect(manager.getStatus(id2)!.errorMessage).toBe("Session ended")

      // Both should have task_complete events
      const completes = events.filter(
        (e) => e.type === "task_complete" && (e as any).state === "error",
      )
      expect(completes.length).toBe(2)
    })

    test("output accumulates from text_delta and text_complete", async () => {
      const mockDef: AgentDefinition = {
        name: "mock-test",
        systemPrompt: "Test",
        backend: "mock",
        filePath: "test.md",
      }

      const id = manager.spawn({
        definition: mockDef,
        prompt: "hello",
        backendOverride: "mock",
      })

      await wait(3000)

      const status = manager.getStatus(id)
      // Output should contain text from the mock's response to "hello"
      expect(status!.output.length).toBeGreaterThan(0)
      expect(status!.output).toContain("mock")
    })
  })

  // -------------------------------------------------------------------------
  // MCP tools configuration
  // -------------------------------------------------------------------------

  describe("MCP tools", () => {
    test("getCrossagentSdkMcpConfig returns a config", async () => {
      const { getCrossagentSdkMcpConfig } = await import(
        "../../src/subagents/mcp-tools"
      )
      const config = getCrossagentSdkMcpConfig()
      expect(config).toBeDefined()
      expect(config!.name).toBe("bantai-crossagent")
    })
  })

  // -------------------------------------------------------------------------
  // Slash commands
  // -------------------------------------------------------------------------

  describe("Slash commands", () => {
    test("crossagentCommand is registered", async () => {
      const { crossagentCommand } = await import(
        "../../src/subagents/commands"
      )
      expect(crossagentCommand.name).toBe("crossagent")
      expect(crossagentCommand.argumentHint).toContain("spawn")
      expect(crossagentCommand.argumentHint).toContain("list")
      expect(crossagentCommand.argumentHint).toContain("status")
      expect(crossagentCommand.argumentHint).toContain("stop")
      expect(crossagentCommand.argumentHint).toContain("definitions")
    })
  })
})
