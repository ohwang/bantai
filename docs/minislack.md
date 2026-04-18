# minislack — fake Slack server for bantai

`minislack` is a Slack-shape HTTP + Socket Mode server that runs inside the bantai repo. It exists so that the bantai Slack frontend — or any bolt-js / @slack/web-api / @slack/socket-mode app — can be developed and tested without a real Slack workspace. Point the SDK at `minislack`'s base URL instead of `https://slack.com/api/` and the request/response shapes match.

## Quickstart

```bash
# Ephemeral port, in-memory, serves both web UI and API:
bantai minislack --port 0 --fixture basic

# Disk-backed, default directory ~/.bantai/minislack/default:
bantai minislack --persist

# Disk-backed, explicit directory:
bantai minislack --persist /tmp/ms-state

# Headless (no web UI, no bundle build), for tests only:
bantai minislack --port 3200 --no-web
```

On startup the process prints the base URL:

```
minislack — fake Slack workspace
URL:        http://localhost:51732
WS base:    ws://localhost:51732/link
fixture:    basic
team:       Minislack (T00000001)
users:      3
channels:   2
```

Open the URL in a browser to use the multi-tab web UI. Open multiple tabs and pick different users to test two-user flows.

## CLI flags

| Flag | Default | Notes |
|------|---------|-------|
| `--port <n>` | `3102` | `0` = ephemeral (tests). |
| `--fixture <name>` | `basic` | `empty`, `basic`, `threaded`, `multi-user`. |
| `--persist [dir]` | off | Bare flag → `~/.bantai/minislack/default`. With value → that path. |
| `--no-web` | off | Skip building + serving the SPA. |

## API surface (Web API)

All methods live under `POST /api/<method>`, accept `application/json` or `application/x-www-form-urlencoded` (including `blocks` / `attachments` as JSON strings — bolt-js's default wire), and return `{ ok: boolean, error?, ...payload }`.

Auth: `Authorization: Bearer <token>`. Tokens:
- `xoxp-<userId>` — user token
- `xoxb-<appId>` — bot token (from `registerApp()`)
- `xapp-<appId>` — app-level token (for `apps.connections.open`)

Implemented methods:

| Namespace | Methods |
|-----------|---------|
| `auth` | `auth.test` |
| `team` | `team.info` |
| `bots` | `bots.info` |
| `chat` | `postMessage`, `update`, `delete`, `postEphemeral`, `meMessage` |
| `conversations` | `list`, `info`, `history`, `replies`, `open`, `close`, `members`, `join`, `leave`, `create` |
| `reactions` | `add`, `remove`, `get` (incl. `full: true`) |
| `users` | `list`, `info`, `conversations`, `profile.get`, `lookupByEmail` |
| `files` | `upload` (v1 multipart), `getUploadURLExternal` + `completeUploadExternal` (v2), `info` |
| `apps` | `apps.connections.open` |

Pagination: `conversations.list`, `conversations.members`, `users.list`, `users.conversations` accept `cursor` + `limit` and return `response_metadata.next_cursor`. Cursors are opaque base64. Invalid cursors → `invalid_cursor`; invalid `limit` → `invalid_limit`; `limit` clamped to 999.

Error codes mirror Slack's documented lexicon: `channel_not_found`, `user_not_found`, `message_not_found`, `not_in_channel`, `name_taken`, `method_not_supported_for_channel_type`, `users_list_not_supplied`, `bot_not_found`, `users_not_found`, `invalid_cursor`, `invalid_limit`, `not_authed`, etc.

## Socket Mode

`POST /api/apps.connections.open` with an app-level token returns a short-lived `ws://.../link/<socketId>` URL. The WS handler sends `hello` on connect and then pushes one envelope per bus event for types in the app's `subscribed_events`.

Envelope types sent:

| type | payload |
|------|---------|
| `hello` | `{ num_connections, connection_info.app_id, debug_info.{host, started, build_number, approximate_connection_time} }` |
| `events_api` | `EventsApiPayload<SlackEvent>` — `token`, `team_id`, `api_app_id`, `event`, `event_id`, `event_time`, `type: "event_callback"`, `authorizations[]`, `is_ext_shared_channel`, `context_team_id`, `context_enterprise_id` |
| `slash_commands` | `SlashCommandPayload` — `accepts_response_payload: true` |
| `interactive` | `BlockActionsPayload` \| `ViewSubmissionPayload` \| `ViewClosedPayload` \| `MessageActionPayload` \| `GlobalShortcutPayload` |

Client acks: `{ envelope_id, payload? }`. When `accepts_response_payload: true`, the ack `payload` is captured and surfaced via `MinislackHandle.fireSlashCommand`'s `awaitAckMs` option.

Event types published on the bus:

`message` (incl. subtypes: `bot_message`, `me_message`, `file_share`, `channel_join`, `channel_leave`, `thread_broadcast`, `message_changed`, `message_deleted`), `reaction_added`, `reaction_removed`, `app_mention`, `channel_created`, `channel_rename`, `member_joined_channel`, `member_left_channel`, `im_open`, `im_close`, `file_shared`.

## Testing from bolt-js or @slack/web-api

```ts
import { WebClient } from "@slack/web-api"
const client = new WebClient(botToken, { slackApiUrl: `${minislackUrl}/api/` })
await client.chat.postMessage({ channel, text: "hello" })
```

For Socket Mode, the SDK already calls `apps.connections.open` + opens the returned URL. Drop-in replacement.

## Testing from test code

```ts
import { startMinislack } from "src/minislack/testing/harness"

const handle = await startMinislack({ port: 0, serveWeb: false })
createUser(handle.workspace, { name: "alice" })
createUser(handle.workspace, { name: "bob" })
const alice = handle.asUser("alice")
await alice.sendMessage("C00000001", "hello")

// Register a bot app and drive slash commands:
const { app, appToken } = handle.registerApp({ name: "deploybot" })
// Open a WS client at `${handle.url.replace("http","ws")}/link/<id>` via apps.connections.open.
await handle.fireSlashCommand(app.id, {
  userId: alice.user.id,
  channelId: "C00000001",
  command: "/deploy",
  text: "prod",
  awaitAckMs: 1000,
})

await handle.stop()
```

## Persistence model

With `--persist <dir>`:

- `<dir>/workspace.json` — atomic JSON snapshot. Maps serialized as arrays of entries with a top-level `schema_version`.
- `<dir>/files/<fileId>.bin` — one blob per attached file.

Writes are debounced 25 ms; bursts collapse into a single write. Load rebases `File.url_private` onto the current host:port so a persisted state works across restarts regardless of port assignment.

## Architecture

```
src/minislack/
  core/              — pure state (workspace, channels, messages, reactions, files, users, ids, ts, events)
  server/            — Bun.serve HTTP + WS + internal SSE
    methods/*.ts     — one file per Web API method family
    envelope.ts      — Socket Mode envelope builders (hello, events_api, slash_commands, interactive)
    ws-registry.ts   — live connection tracking per appId + ack payload resolvers
    pagination.ts    — opaque cursor helpers
  storage/           — memory (no-op) + disk (atomic write + blobs) + pure snapshot codec
  testing/           — harness (startMinislack) + fixtures
  types/             — Workspace / Channel / Message / User / File / SlackEvent / EventEnvelope / interactive payloads
  web/               — Solid SPA served by server/http.ts
```

The bus is the only cross-cutting concern: every mutating core function publishes a typed `SlackEvent` on `createEventBus()`. The WS server subscribes per app filter; the SPA subscribes via `/_minislack/events` SSE; the disk backend subscribes for debounced saves.
