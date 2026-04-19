# Forward-looking Slack scopes, events, and settings

This doc tracks the Slack app surfaces we've declared in
`src/frontends/slack/manifest.ts` that **no production code path uses yet**.
They're in the manifest so the first time we ship each feature we don't
need operators to re-approve a scope upgrade — Slack only prompts for
consent on install / reinstall, and a mid-release scope bump is the most
annoying kind of deploy.

Anything in this document is a commitment that when we *do* implement it,
the scope / subscription is already present. Nothing here should be
relied on by code today. Grep for the scope name before removing
anything — if you see references in `src/frontends/slack/`, update those
first, then prune here.

---

## New bot scopes

### `assistant:write`

**Slack surface:** the [Agents & AI Apps](https://api.slack.com/docs/apps/ai) sidebar.
Grants access to:

- `assistant.threads.setStatus` — show "bantai is thinking…" with custom text
- `assistant.threads.setTitle` — set the thread's display title
- `assistant.threads.setSuggestedPrompts` — render clickable quick-prompts
  in the composer

**How bantai can leverage it.** Today every interaction lives inside a
normal channel or DM thread and the user has to `@bantai` or message the
bot. With this scope we can light up the native Assistants panel so bantai
appears in the left rail like Slack's first-party AI. Concrete wins:

- **Thread status:** replace our text-only "typing…" placeholder in
  `view/thread-status.ts` with Slack's native animated status. Removes a
  whole category of `chat.update` races when the turn completes within
  the throttle window.
- **Dynamic titles:** auto-title threads from the first turn's summary —
  same feature Claude Desktop has. `inbox/turn-builder.ts` already has
  the summarised text ready.
- **Suggested prompts:** after a tool result, surface the 2–3 most likely
  next actions as pre-filled chips. Cheap UX upgrade — the agent already
  emits suggested follow-ups in its planning output.

**Implementation pointers:**
- Subscribe to the `assistant_thread_started` and
  `assistant_thread_context_changed` events (Slack gates these on
  `assistant:write`).
- Add a new dispatch arm in `transport/events.ts` to bridge the
  Assistant-panel thread ID into `SessionRouter`.

---

### `emoji:read`

**Slack surface:** the `emoji.list` Web API. Returns every custom emoji
the workspace has installed, with canonical names and image URLs.

**How bantai can leverage it.** Our reaction-based status indicators in
`view/reactions.ts` use hardcoded unicode (⏳, ✅, ❌). That works, but:

- **Custom-emoji status per workspace.** Teams love their `:ship-it:`,
  `:shrug-dog:`, `:looking:` — let operators override the default status
  set via `slack.json` and validate at startup that the chosen names
  actually exist (today a typo fails silently at `reactions.add` time).
- **Emoji-as-command validation.** Reaction-based approvals (👍 to
  approve, 👎 to deny) could extend to team-specific emoji (`:lgtm:`,
  `:nope:`) once we can read the workspace's actual list.
- **Inbound emoji normalisation.** When rendering a user's message that
  contains `:custom-emoji:`, we can resolve the name to a unicode
  fallback or include the image URL so the agent sees something more
  useful than a raw `:name:` token.

**Implementation pointers:**
- Add an `EmojiCache` alongside `view/user-cache.ts` — same TTL pattern,
  seeded at launcher boot.
- Wire into `inbox/turn-builder.ts` so the agent gets the resolved
  reaction name + image URL, not just the colon-code.

---

## New event subscriptions

### `reaction_removed`

**What it is.** Slack fires this when a user un-reacts to a message.

**How bantai can leverage it.** Today `transport/events.ts` only routes
`reaction_added` (emoji-as-command pattern). Without the removal event
there are reaction-toggle flows we can't express:

- **Un-approve a pending tool call.** User reacts 👍 to approve a
  dangerous command; realises mid-execution it's wrong; removes the
  reaction → we trigger a soft interrupt. Mirrors the existing
  `INTERRUPTING` state transition in the state machine.
- **Un-subscribe from a thread.** React with `:eyes:` to make bantai
  route this thread's events to you; remove it to opt out — without
  needing a slash command.
- **State debug.** Pair with `reaction_added` to detect double-click
  mistakes (added-then-removed within N seconds) and suppress the
  spurious action.

**Implementation pointers:**
- Add a `reaction_removed` branch to the `InboundSlackEvent` union next
  to the existing `reaction_added`.
- Extend `view/reactions.ts` to diff added/removed pairs per
  (channel, ts) before treating either as an intent.

---

### `channel_rename`

**What it is.** Fires when a channel is renamed.

**How bantai can leverage it.** `view/user-cache.ts` memoises channel
display names from `conversations.info` calls — today that cache has no
invalidation signal other than TTL expiry. Consequences:

- Rendered messages that inline the channel name (e.g. "posted to
  `#old-name`") leak the stale name until the cache turns over.
- Agent context windows referencing `#old-name` stay wrong for the
  session's lifetime, which the user won't notice until the agent
  suggests a stale path.

**Implementation pointers:**
- Add a `channel_rename` branch in `transport/events.ts` and call
  `userCache.invalidateChannel(event.channel.id)`.
- Optional: emit an `AgentEvent` so the current turn can note the rename
  for the model — small context correction but avoids "why is the agent
  still calling it the old name?" confusion.

---

## New settings

### `is_mcp_enabled: true`

**What it is.** A newer Slack manifest flag that opts the app into
Slack's own MCP server surface. When enabled, the installed app exposes
its capabilities (scoped to its OAuth grants) as MCP tools that *any*
MCP client — including bantai's agent — can invoke over the standard
MCP wire.

**How bantai can leverage it.** We already have an MCP scaffold at
`src/frontends/slack/mcp/`. Today it's our custom tooling layered over
Bolt calls. With `is_mcp_enabled: true`:

- **First-party MCP server.** Slack hosts an MCP endpoint for our app.
  The agent can connect and call `chat.postMessage`, `conversations.*`,
  etc. through the same protocol as every other MCP server — no bespoke
  Slack adapter shim in the agent's tool list.
- **Scope-gated discovery.** Tools the agent sees are automatically
  restricted to scopes we've granted in `oauth_config.scopes.bot`. Means
  accidental privilege creep is a lot harder — if a scope isn't in this
  manifest, the MCP tool simply isn't advertised.
- **Cross-surface reuse.** The same MCP server is consumable by
  non-bantai clients on the same Slack install (scripts, other agents
  the user runs). We get interop for free.

**Implementation pointers:**
- Wait for Slack to publish the endpoint URL/auth contract for the MCP
  surface (still rolling out as of this writing).
- Point our MCP client at that URL instead of our custom wrapper in
  `mcp/`. Keep the custom wrapper as a fallback for workspaces on older
  Slack SKUs that haven't enabled MCP.

---

## Other manifest changes (not new-scope-but-adjacent)

### `features.bot_user.always_online: false`

Flipped from `true`. bantai is a per-session CLI, not a hosted service —
the green "online" dot lies about availability when no one's running the
binary. `false` lets Slack track actual presence via the Socket Mode
connection.

### `features.slash_commands: [ "/bantai" ]`

Declares a global slash command. **No handler is wired yet** — the
registration in `transport/events.ts` (`app.command("/bantai", ...)`)
comes when we ship the feature. Until then, invoking `/bantai` will
error on Slack's side; this is intentional (manifest forward-seeding
above code).

### `settings.interactivity.request_url`

Always emitted now (previously only present in HTTP mode). Defaults to
`https://example.com/slack/interactive` — safe to ignore under Socket
Mode, and prevents the "flip Socket Mode off → manifest invalid" foot-
gun. Operators override via `bantai slack init-manifest --request-url
<url>`.
