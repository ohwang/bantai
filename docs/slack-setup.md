# Setting up bantai's Slack frontend

This walks you from `git clone` → working bot in a real Slack workspace in under ten minutes. The flow assumes Socket Mode (easiest; no public HTTPS endpoint needed). Skip to the bottom for HTTP / Events API instead.

## Prerequisites

- Bun ≥ 1.3.11 (`curl -fsSL https://bun.sh/install | bash`)
- A Slack workspace where you can install apps. Free / developer workspaces work fine.
- An Anthropic API key (or another supported backend's credential — bantai works with Codex, Gemini, or any ACP backend too).

## 1. Clone + install

```bash
git clone https://github.com/anthropics/bantai.git
cd bantai
bun install
```

Verify the build works:

```bash
bun run typecheck
bun test tests/frontends/slack
```

## 2. Generate the Slack app manifest

Slack wants a manifest (YAML or JSON) that declares your app's scopes, event subscriptions, and interactivity settings. bantai ships the right manifest so you don't have to click through 20 scope checkboxes:

```bash
bun run ./src/index.ts slack init-manifest > slack-manifest.yaml
```

Default is Socket Mode. If you need HTTP / Events API instead:

```bash
bun run ./src/index.ts slack init-manifest --http --request-url https://yourdomain.com/slack/events > slack-manifest.yaml
```

## 3. Create the Slack app

1. Go to <https://api.slack.com/apps>.
2. Click **Create New App** → **From an app manifest**.
3. Pick your workspace.
4. Paste the contents of `slack-manifest.yaml`.
5. Click **Create**.

Slack will show you the scopes + event subscriptions from the manifest. Confirm and continue.

## 4. Install the app + copy tokens

On the app's configuration page:

1. **OAuth & Permissions** → **Install to Workspace** → **Allow**.
   - Copy the **Bot User OAuth Token** (`xoxb-…`). This goes into `BANTAI_SLACK_BOT_TOKEN`.
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**.
   - Name it `socket`, grant the `connections:write` scope, click **Generate**.
   - Copy the token (`xapp-…`). This goes into `BANTAI_SLACK_APP_TOKEN`.
3. Enable **Socket Mode** on the **Socket Mode** tab.
4. Enable **Event Subscriptions** on that tab.
5. Enable **Interactivity** on the **Interactivity & Shortcuts** tab (no URL needed in Socket Mode).

## 5. Write `slack.json`

bantai looks for `./.bantai/slack.json` first, then `~/.bantai/slack.json`. Either works — create one of them. The file is JSONC (JSON + `//` and `/* */` comments + trailing commas), so you can annotate it inline:

```jsonc
{
  "workspace": {
    "mode": "socket",
    "bot_token": { "env": "BANTAI_SLACK_BOT_TOKEN" },
    "app_token": { "env": "BANTAI_SLACK_APP_TOKEN" }
  },

  "defaults": {
    "backend": "claude",
    "model": "claude-opus-4-7",
    "verbosity": "normal",
    "require_mention": true,
    "session_banner": true,
    // Any user can approve tool use in the default config.
    // Recommended for production: pin to a specific allow-list, e.g.
    //   "approvers": ["U0123456", "U0123457"]
    "approvers": [],
    // Seconds of inactivity before a thread's session is evicted from
    // memory. The on-disk store is untouched, so the next message in
    // the thread rehydrates it. Default 3600 (60 min). 0 disables.
    "idle_timeout_s": 3600
  },

  // Persist per-session state so a process restart (crash, deploy) picks
  // live threads back up where they left off. Leave unset or "" to disable.
  "store_path": "~/.bantai/slack.db"

  // Optional: per-channel overrides.
  // "channels": [
  //   {
  //     "id": "C0123456789",
  //     "name": "eng-backend",
  //     "project_dir": "/home/me/dev/backend",
  //     "backend": "claude",
  //     "model": "claude-opus-4-7",
  //     "approvers": ["U0ALICE"],
  //     "verbosity": "verbose"
  //   }
  // ]
}
```

Export your tokens + your backend's API key:

```bash
export BANTAI_SLACK_BOT_TOKEN=xoxb-...
export BANTAI_SLACK_APP_TOKEN=xapp-...
export ANTHROPIC_API_KEY=sk-...
```

## 6. Run the bot

```bash
bun run ./src/index.ts slack
```

You should see (roughly):

```
slack: loaded config from /you/.bantai/slack.json (mode=socket)
slack auth ok: user=U0YOURBOT bot=B0… team=T0…
slack: server ready — bot user U0YOURBOT, team T0…
```

## 7. Verify it works

In your Slack workspace:

1. Invite the bot to a channel: `/invite @bantai`.
2. Mention it: `@bantai please list the files in /tmp`.
3. The bot should react with `:speech_balloon:` while it works, post a reply, then swap the reaction to `:round_pushpin:` when it's done (ball back in your court). Other terminal states: `:watermelon:` if you run `!bantai stop`, `:octagonal_sign:` for internal errors. `:white_check_mark:` is never used by the bot — it's reserved for humans marking work as reviewed.

## Per-channel configuration

Each entry in `channels[]` scopes its fields to one channel ID:

```jsonc
{
  "channels": [
    {
      "id": "C_YOUR_CHANNEL",
      "name": "eng-backend",
      "project_dir": "/home/me/dev/backend",
      "backend": "codex",                  // this channel runs Codex instead of Claude
      "model": "gpt-5-codex",
      "approvers": ["U0ALICE", "U0BOB"],
      "verbosity": "verbose",
      "allowed_tools": ["Read", "Grep", "Bash"],
      "claude_config_dir": "/home/me/.claude/eng-backend",
      // system_prompt_replace swaps out defaults.system_prompt for this channel.
      // system_prompt_append is always concatenated LAST (with a blank-line
      // separator), whether on top of defaults.system_prompt or on top of
      // system_prompt_replace. Both are optional; omit either or both.
      // `system_prompt_append` accepts a single string or an array of strings
      // (array entries are joined with blank-line separators).
      "system_prompt_append": [
        "Focus on the backend service; ignore the frontend subtree.",
        "The current channel is #eng-backend (channel ID C_YOUR_CHANNEL)."
      ],
      "turn_timeout_s": 300,               // auto-interrupt a turn after 5 min
      "max_budget_usd": 10                 // stop turn streaming if session cost exceeds $10
    },
    {
      "id": "C_OTHER_CHANNEL",
      "name": "mobile",
      "project_dir": "/home/me/dev/mobile",
      "backend": "claude",
      "model": "claude-haiku-4-5",
      "approvers": ["U0CAROL"],
      "verbosity": "concise"
    }
  ]
}
```

Two different repos, two different backends, two different approver lists — one bot process, no cross-talk.

## Control commands (per-channel)

Any user in the channel can run these in-thread by typing `!bantai <cmd>`:

- `!bantai help` — list all commands
- `!bantai status` — show backend, model, cwd, verbosity, channel binding
- `!bantai settings` — dump the fully resolved channel config (no secrets)
- `!bantai cost` — session token + USD totals
- `!bantai stop` — interrupt the current turn
- `!bantai model <id>` — swap the active model live
- `!bantai verbosity <silent|concise|normal|verbose|debug>` — adjust output detail
- `!bantai new` — reset this thread's session

Change the prefix by setting `"control_prefix": "!jarvis"` (or whatever) under `defaults`.

## HTTP / Events API mode (optional)

If you can't use Socket Mode (e.g. a hosted deploy), switch the manifest generation:

```bash
bun run ./src/index.ts slack init-manifest --http --request-url https://yourdomain.com/slack/events > slack-manifest.yaml
```

And in `slack.json`:

```jsonc
{
  "workspace": {
    "mode": "http",
    "bot_token": { "env": "BANTAI_SLACK_BOT_TOKEN" },
    "signing_secret": { "env": "BANTAI_SLACK_SIGNING_SECRET" },
    "port": 3000,
    "webhook_path": "/slack/events"
  }
}
```

You're responsible for getting HTTPS in front of the bot — Slack refuses plain HTTP request URLs. ngrok / Cloudflare Tunnels / your load balancer are all fine.

## Troubleshooting

### `not_authed`, `invalid_auth`, `missing_scope`

- Check `echo $BANTAI_SLACK_BOT_TOKEN` / `$BANTAI_SLACK_APP_TOKEN` — token rotation or a typo is the usual cause.
- Re-install the app to the workspace after editing scopes. OAuth tokens are pinned to the scope set at install time.
- The launcher runs a scope probe on boot; missing scopes show up as `slack diagnostic:` warn lines in the log.

### Bot doesn't reply to @mentions

- Is the bot a member of the channel? `/invite @bantai`.
- Is the channel ID in a `channels[]` entry (if you have per-channel overrides)? `conversations.info` in Slack's API surface will show the ID.
- Run `!bantai status` in-thread — if the bot responds to that, the routing layer is working; the silence is upstream (backend / model / auth).

### `approvers.defaults_empty` warning

The boot audit flags channels where any user can approve tool use. Set `"approvers": ["U0YOUR_ID"]` under `defaults` or per-channel. Slack user IDs start with `U`; you can grab yours from the **Profile & account** → **Copy member ID** menu.

### Bot posts but nothing shows up

Slack's `chat:write.public` scope lets the bot post in channels it's not a member of. Without it, posts fail silently in public channels the bot hasn't been invited to. The manifest ships `chat:write.public` — re-install if you deleted it.

### Turn never completes

A missing Anthropic / OpenAI / etc. API key. Check your backend's CLI works standalone:

```bash
bun run ./src/index.ts   # launches the TUI — if the backend errors here, it'll error in Slack too
```

## End-to-end smoke test against your workspace

The repo ships an optional live-Slack smoke test at `tests/e2e/slack-live.test.ts`. It skips by default (CI keeps working without credentials). Opt in by exporting three env vars and running the test:

```bash
export BANTAI_SLACK_LIVE_BOT_TOKEN=xoxb-…
export BANTAI_SLACK_LIVE_APP_TOKEN=xapp-…
export BANTAI_SLACK_LIVE_CHANNEL=C0...         # a channel the bot is in
bun test tests/e2e/slack-live.test.ts
```

The test boots the launcher against real Slack, posts an `@bantai` probe, and polls for the bot's reply in the same thread. Costs are capped at `$0.50` and `60s` so a misbehaving backend can't run up the bill.

## Metrics

When `workspace.mode = "http"`, the launcher exposes a Prometheus-compatible `/metrics` endpoint on the same HTTP receiver as the Events API. Point your scraper at `http://<host>:<port>/metrics` — the surface includes `bantai_slack_turn_started_total`, `_completed_total`, `_errored_total`, `_approval_{requested,approved,denied}_total`, `_cost_usd_sum`, and a `_sessions_active` gauge. Socket Mode has no HTTP surface so the endpoint isn't exposed there, but the same counters can be read via `SlackLaunchHandle.metrics.snapshot()` in tests.

## Session persistence

bantai writes a small SQLite row per live (channel, thread) pair tracking the backend session id + cumulative turn count + USD cost. A process restart (deploy, crash, `kill -9`) rehydrates each thread's session on the next inbound message — the backend resumes instead of starting fresh, and `!bantai cost` continues to report totals across restarts. `!bantai new` explicitly forgets the row for its thread.

Three `store_path` modes:

- **Omit the key** (recommended) → defaults to `~/.bantai/slack.db`. Persistence on, no config required.
- **Explicit absolute path** → bantai writes there. The parent directory is auto-created.
- **Explicit `""`** → persistence disabled. Threads start fresh after every restart. Use this only when you genuinely want that (e.g. integration tests that don't want on-disk side effects).

The example at the top of this doc sets `store_path: "~/.bantai/slack.db"` explicitly — that's equivalent to omitting the key today, but kept in the sample so operators who want to move the file know which knob to change.

## What's next

- `!bantai status` and `!bantai settings` are your debugging primitives — run them in a channel when something looks wrong.
- Per-channel `claude_config_dir` lets you install different skills / MCP tokens / slash commands per channel without conflicts. See the Claude SDK docs for the `CLAUDE_CONFIG_DIR` layout.
- See `plan-slack-integration.md` in the repo for the full architecture + phase roadmap.
