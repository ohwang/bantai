/**
 * Workspace → JSON-shaped snapshot (and back). Pure, no I/O.
 *
 * The Workspace aggregate carries Maps, which don't survive JSON.stringify.
 * We serialize Maps as arrays-of-entries and attach a `schema_version` at
 * the top level so later shape changes can migrate cleanly.
 *
 * File BYTES are not embedded in the snapshot — they live as separate blobs
 * alongside the JSON (see storage/disk.ts). The snapshot does carry each
 * File record, which includes its id; disk storage writes
 * `<root>/files/<id>.bin` for each attached blob.
 */

import type {
  App,
  Channel,
  File,
  Message,
  User,
  Workspace,
} from "../types/slack"

export const SCHEMA_VERSION = 1

export interface WorkspaceSnapshot {
  schema_version: number
  team: Workspace["team"]
  users: User[]
  apps: App[]
  channels: SnapshotChannel[]
  files: File[]
  ts_state: Array<[string, { lastUnix: number; seq: number }]>
  id_counters: Array<[string, number]>
}

export type SnapshotChannel = Omit<Channel, "messages"> & { messages: Message[] }

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

export function toSnapshot(ws: Workspace): WorkspaceSnapshot {
  const channels: SnapshotChannel[] = []
  for (const ch of ws.channels.values()) {
    const messages = Array.from(ch.messages.values())
    channels.push({ ...(ch as Channel & { messages: Map<string, Message> }), messages })
  }
  return {
    schema_version: SCHEMA_VERSION,
    team: ws.team,
    users: Array.from(ws.users.values()),
    apps: Array.from(ws.apps.values()),
    channels,
    files: Array.from(ws.files.values()),
    ts_state: Array.from(ws.tsState.entries()),
    id_counters: Array.from(ws.idCounters.entries()),
  }
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

export function fromSnapshot(snapshot: WorkspaceSnapshot): Workspace {
  const migrated = migrate(snapshot)
  const ws: Workspace = {
    team: migrated.team,
    users: new Map(migrated.users.map((u) => [u.id, u])),
    apps: new Map(migrated.apps.map((a) => [a.id, a])),
    channels: new Map(),
    files: new Map(migrated.files.map((f) => [f.id, f])),
    tsState: new Map(migrated.ts_state),
    idCounters: new Map(migrated.id_counters),
  }
  for (const snap of migrated.channels) {
    const { messages, ...rest } = snap
    const messagesMap = new Map<string, Message>()
    for (const m of messages) messagesMap.set(m.ts, m)
    const ch = { ...(rest as Channel), messages: messagesMap } as Channel
    ws.channels.set(ch.id, ch)
  }
  return ws
}

// ---------------------------------------------------------------------------
// Migrations — add entries as schema_version bumps land.
// ---------------------------------------------------------------------------

function migrate(input: WorkspaceSnapshot): WorkspaceSnapshot {
  // v1 is current; nothing to do. When bumping, write a vNtoVN+1 function and
  // chain them here so old on-disk states keep loading.
  if (input.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `snapshot schema_version ${input.schema_version} is newer than this build (${SCHEMA_VERSION})`,
    )
  }
  return input
}
