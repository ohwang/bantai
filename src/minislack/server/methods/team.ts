/**
 * team.info — returns the Team record.
 *
 * https://api.slack.com/methods/team.info
 *
 * Real Slack populates `icon`, `email_domain`, `enterprise_id`, and
 * `enterprise_name` on paid plans. minislack stubs the icon shape; the
 * rest are optional and bolt-js tolerates their absence.
 */

import type { Team, Workspace } from "../../types/slack"

export interface TeamInfoResponse {
  ok: true
  team: Team & {
    email_domain: string
    icon: {
      image_default: boolean
      image_34: string
      image_44: string
      image_68: string
      image_88: string
      image_102: string
      image_132: string
    }
    enterprise_id: string | null
    enterprise_name: string | null
  }
}

export function teamInfo(ws: Workspace): TeamInfoResponse {
  return {
    ok: true,
    team: {
      ...ws.team,
      email_domain: `${ws.team.domain}.minislack.local`,
      icon: {
        image_default: true,
        image_34: "",
        image_44: "",
        image_68: "",
        image_88: "",
        image_102: "",
        image_132: "",
      },
      enterprise_id: null,
      enterprise_name: null,
    },
  }
}
