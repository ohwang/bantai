import { describe, expect, it } from "bun:test"
import { resolveFlags } from "../../src/cli/options"

/**
 * Tests for resolveFlags() — the function that transforms Commander's
 * parsed options into the CLIFlags shape consumed by downstream code.
 *
 * These tests validate the same contracts as the old parseFlags() tests,
 * but operate on Commander option objects instead of raw argv arrays.
 */

describe("resolveFlags", () => {
  // -----------------------------------------------------------------------
  // 1. Empty opts — defaults
  // -----------------------------------------------------------------------
  describe("empty opts (defaults)", () => {
    it("returns default config when no options provided", () => {
      const result = resolveFlags({})

      expect(result.config).toEqual({})
      expect(result.backend).toBe("claude")
      expect(result.help).toBe(false)
      expect(result.version).toBe(false)
      expect(result.debug).toBe(false)
      expect(result.debugBackend).toBe(false)
      expect(result.prompt).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 2. Model option
  // -----------------------------------------------------------------------
  describe("model", () => {
    it("sets config.model", () => {
      const result = resolveFlags({ model: "claude-sonnet-4-6" })
      expect(result.config.model).toBe("claude-sonnet-4-6")
    })
  })

  // -----------------------------------------------------------------------
  // 3. Prompt
  // -----------------------------------------------------------------------
  describe("prompt", () => {
    it("sets prompt from --prompt option", () => {
      const result = resolveFlags({ prompt: "hello world" })
      expect(result.prompt).toBe("hello world")
    })

    it("sets prompt from positional argument", () => {
      const result = resolveFlags({}, "fix the bug")
      expect(result.prompt).toBe("fix the bug")
    })

    it("--prompt takes precedence over positional", () => {
      const result = resolveFlags({ prompt: "from flag" }, "positional")
      expect(result.prompt).toBe("from flag")
    })
  })

  // -----------------------------------------------------------------------
  // 4. Boolean flags
  // -----------------------------------------------------------------------
  describe("boolean flags", () => {
    it("debug defaults to false", () => {
      const result = resolveFlags({})
      expect(result.debug).toBe(false)
    })

    it("--debug sets debug to true", () => {
      const result = resolveFlags({ debug: true })
      expect(result.debug).toBe(true)
    })

    it("--debug-backend sets debugBackend to true", () => {
      const result = resolveFlags({ debugBackend: true })
      expect(result.debugBackend).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 5. Session management
  // -----------------------------------------------------------------------
  describe("session management", () => {
    it("--continue sets config.continue to true", () => {
      const result = resolveFlags({ continue: true })
      expect(result.config.continue).toBe(true)
    })

    it("--resume with id sets config.resume", () => {
      const result = resolveFlags({ resume: "abc-123" })
      expect(result.config.resume).toBe("abc-123")
    })

    it("--resume without id sets config.resumeInteractive", () => {
      // Commander returns `true` for optional arg without value
      const result = resolveFlags({ resume: true })
      expect(result.config.resumeInteractive).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 6. Permission mode
  // -----------------------------------------------------------------------
  describe("permission mode", () => {
    it("--dangerously-skip-permissions sets bypassPermissions", () => {
      const result = resolveFlags({ dangerouslySkipPermissions: true })
      expect(result.config.permissionMode).toBe("bypassPermissions")
    })

    it("--permission-mode sets the given mode", () => {
      const result = resolveFlags({ permissionMode: "acceptEdits" })
      expect(result.config.permissionMode).toBe("acceptEdits")
    })

    it("--permission-mode supports plan mode", () => {
      const result = resolveFlags({ permissionMode: "plan" })
      expect(result.config.permissionMode).toBe("plan")
    })

    it("--dangerously-skip-permissions takes precedence over --permission-mode", () => {
      const result = resolveFlags({ dangerouslySkipPermissions: true, permissionMode: "acceptEdits" })
      expect(result.config.permissionMode).toBe("bypassPermissions")
    })
  })

  // -----------------------------------------------------------------------
  // 7. Working directory
  // -----------------------------------------------------------------------
  describe("cwd", () => {
    it("sets config.cwd", () => {
      const result = resolveFlags({ cwd: "/some/path" })
      expect(result.config.cwd).toBe("/some/path")
    })
  })

  // -----------------------------------------------------------------------
  // 8. System prompt
  // -----------------------------------------------------------------------
  describe("system prompt", () => {
    it("sets config.systemPrompt", () => {
      const result = resolveFlags({ systemPrompt: "You are a helpful assistant" })
      expect(result.config.systemPrompt).toBe("You are a helpful assistant")
    })
  })

  // -----------------------------------------------------------------------
  // 9. Multiple options combined
  // -----------------------------------------------------------------------
  describe("multiple options combined", () => {
    it("applies all options correctly", () => {
      const result = resolveFlags({
        model: "claude-sonnet-4-6",
        debug: true,
        cwd: "/tmp",
      })
      expect(result.config.model).toBe("claude-sonnet-4-6")
      expect(result.debug).toBe(true)
      expect(result.config.cwd).toBe("/tmp")
    })

    it("handles all session + model + prompt options together", () => {
      const result = resolveFlags({
        model: "claude-opus-4-6",
        continue: true,
        systemPrompt: "Be concise",
        prompt: "explain this code",
        debug: true,
        backend: "claude-v2",
      })
      expect(result.config.model).toBe("claude-opus-4-6")
      expect(result.config.continue).toBe(true)
      expect(result.config.systemPrompt).toBe("Be concise")
      expect(result.prompt).toBe("explain this code")
      expect(result.debug).toBe(true)
      expect(result.backend).toBe("claude-v2")
    })

    it("handles --max-turns and --max-budget together", () => {
      const result = resolveFlags({ maxTurns: 10, maxBudget: 5.5 })
      expect(result.config.maxTurns).toBe(10)
      expect(result.config.maxBudgetUsd).toBe(5.5)
    })
  })

  // -----------------------------------------------------------------------
  // 10. Backend selection
  // -----------------------------------------------------------------------
  describe("backend", () => {
    it("sets backend from --backend option", () => {
      const result = resolveFlags({ backend: "codex" })
      expect(result.backend).toBe("codex")
    })

    it("defaults to claude when not specified", () => {
      const result = resolveFlags({})
      expect(result.backend).toBe("claude")
    })

    it("backendOverride takes precedence over --backend", () => {
      const result = resolveFlags({ backend: "claude" }, undefined, "codex")
      expect(result.backend).toBe("codex")
    })
  })

  // -----------------------------------------------------------------------
  // 11. Max turns
  // -----------------------------------------------------------------------
  describe("maxTurns", () => {
    it("sets config.maxTurns", () => {
      const result = resolveFlags({ maxTurns: 5 })
      expect(result.config.maxTurns).toBe(5)
    })

    it("handles large values", () => {
      const result = resolveFlags({ maxTurns: 100 })
      expect(result.config.maxTurns).toBe(100)
    })
  })

  // -----------------------------------------------------------------------
  // 12. Max budget
  // -----------------------------------------------------------------------
  describe("maxBudget", () => {
    it("sets config.maxBudgetUsd from float", () => {
      const result = resolveFlags({ maxBudget: 10.5 })
      expect(result.config.maxBudgetUsd).toBe(10.5)
    })

    it("sets config.maxBudgetUsd from integer", () => {
      const result = resolveFlags({ maxBudget: 5 })
      expect(result.config.maxBudgetUsd).toBe(5)
    })
  })

  // -----------------------------------------------------------------------
  // 13. Session persistence
  // -----------------------------------------------------------------------
  describe("session persistence", () => {
    it("--no-session-persistence sets config.persistSession to false", () => {
      // Commander's --no-X pattern sets X to false
      const result = resolveFlags({ sessionPersistence: false })
      expect(result.config.persistSession).toBe(false)
    })

    it("session persistence is not set when option is absent", () => {
      const result = resolveFlags({})
      expect(result.config.persistSession).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 14. Thinking config
  // -----------------------------------------------------------------------
  describe("thinking", () => {
    it("sets adaptive thinking mode", () => {
      const result = resolveFlags({ thinking: "adaptive" })
      expect(result.config.thinking).toEqual({ type: "adaptive" })
    })

    it("sets enabled thinking mode", () => {
      const result = resolveFlags({ thinking: "enabled" })
      expect(result.config.thinking).toEqual({ type: "enabled" })
    })

    it("sets disabled thinking mode", () => {
      const result = resolveFlags({ thinking: "disabled" })
      expect(result.config.thinking).toEqual({ type: "disabled" })
    })

    it("--max-thinking-tokens sets thinking to enabled with budget", () => {
      const result = resolveFlags({ maxThinkingTokens: 8000 })
      expect(result.config.thinking).toEqual({ type: "enabled", budgetTokens: 8000 })
    })

    it("--max-thinking-tokens takes precedence over --thinking", () => {
      const result = resolveFlags({ thinking: "disabled", maxThinkingTokens: 8000 })
      expect(result.config.thinking).toEqual({ type: "enabled", budgetTokens: 8000 })
    })
  })

  // -----------------------------------------------------------------------
  // 15. Effort
  // -----------------------------------------------------------------------
  describe("effort", () => {
    it("sets low effort", () => {
      const result = resolveFlags({ effort: "low" })
      expect(result.config.effort).toBe("low")
    })

    it("sets max effort", () => {
      const result = resolveFlags({ effort: "max" })
      expect(result.config.effort).toBe("max")
    })

    it("accepts xhigh effort (advertised in --help)", () => {
      const result = resolveFlags({ effort: "xhigh" })
      expect(result.config.effort).toBe("xhigh")
    })
  })

  // -----------------------------------------------------------------------
  // 16. Theme
  // -----------------------------------------------------------------------
  describe("theme", () => {
    it("sets theme from option", () => {
      const result = resolveFlags({ theme: "dracula" })
      expect(result.theme).toBe("dracula")
    })
  })

  // -----------------------------------------------------------------------
  // 17. Diagnostics MCP
  // -----------------------------------------------------------------------
  describe("diagnostics mcp", () => {
    it("--no-diagnostics-mcp sets noDiagnosticsMcp to true", () => {
      // Commander's --no-X pattern: diagnosticsMcp becomes false
      const result = resolveFlags({ diagnosticsMcp: false })
      expect(result.noDiagnosticsMcp).toBe(true)
    })

    it("noDiagnosticsMcp defaults to false", () => {
      const result = resolveFlags({})
      expect(result.noDiagnosticsMcp).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // 18. ACP options
  // -----------------------------------------------------------------------
  describe("ACP options", () => {
    it("sets acpCommand", () => {
      const result = resolveFlags({ acpCommand: "my-agent" })
      expect(result.acpCommand).toBe("my-agent")
    })

    it("sets acpArgs", () => {
      const result = resolveFlags({ acpArgs: ["--foo", "--bar"] })
      expect(result.acpArgs).toEqual(["--foo", "--bar"])
    })

    it("empty acpArgs array resolves to undefined", () => {
      const result = resolveFlags({ acpArgs: [] })
      expect(result.acpArgs).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // 19. Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("config remains empty object when only boolean flags used", () => {
      const result = resolveFlags({ debug: true })
      expect(result.config).toEqual({})
    })

    it("help and version are always false (Commander handles them)", () => {
      const result = resolveFlags({})
      expect(result.help).toBe(false)
      expect(result.version).toBe(false)
    })
  })
})
