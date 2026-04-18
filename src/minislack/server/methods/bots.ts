/**
 * bots.info — resolve a Bot record by id.
 *
 * https://api.slack.com/methods/bots.info
 *
 * bolt-js calls this whenever a `bot_message` event arrives so it can
 * populate `bot_profile` on the synthetic message.
 */

import { MinislackError } from "../../core/channels"
import type { Workspace } from "../../types/slack"

export interface BotsInfoArgs {
  bot?: string
}

export interface BotsInfoResponse {
  ok: true
  bot: {
    id: string
    app_id: string
    name: string
    deleted: boolean
    updated: number
    user_id: string
    icons: { image_36: string; image_48: string; image_72: string }
  }
}

export function botsInfo(ws: Workspace, args: BotsInfoArgs): BotsInfoResponse {
  if (!args.bot) throw new MinislackError("bot_not_found", "missing bot id")
  for (const app of ws.apps.values()) {
    if (app.bot_id !== args.bot) continue
    return {
      ok: true,
      bot: {
        id: app.bot_id,
        app_id: app.id,
        name: app.name,
        deleted: false,
        updated: Math.floor(Date.now() / 1000),
        user_id: app.bot_user_id,
        icons: { image_36: "", image_48: "", image_72: "" },
      },
    }
  }
  throw new MinislackError("bot_not_found", args.bot)
}
