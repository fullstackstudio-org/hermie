/**
 * One bot's toolsets, skills and MCP servers.
 *
 * All three come from `profiles.describe` and all three go back through
 * `profiles.configure`, and that is the only thing about them that is uniform.
 * The three sections are stored with three different polarities, and every one
 * of them is a replace over a WHOLE list:
 *
 *  - **skills** are stored as the DISABLED set. Sending only the one that
 *    changed switches every other disabled skill back on.
 *  - **toolsets** are stored as an optional PIN of enabled names, and an empty
 *    list REMOVES the pin rather than emptying it — `_save_toolset_pin` pops
 *    the key. So "turn the last switch off" and "go back to the gateway's
 *    defaults" are the same request, which is a genuine hazard and is why the
 *    sheet says out loud what an unpinned bot is doing.
 *  - **MCP servers** are stored per server as `disabled: true`, so the wire
 *    carries the ENABLED list — the opposite of skills, in the same call.
 *
 * `tools.configure` is deliberately not used. It exists, and it is the wrong
 * tool: the handler reads `session_id` and takes the live session's profile as
 * authoritative ("The client sends session_id, not profile"), so it edits
 * whichever bot happens to be talking rather than the one whose sheet is open.
 * The desktop app does not call it either.
 */
import type { ProfilesConfigureParams, ProfilesDescribeResult } from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'

export interface ToolsetRow {
  name: string
  label: string
  description: string
  toolCount: number
  enabled: boolean
}

export interface CapabilityRow {
  name: string
  enabled: boolean
}

export interface McpRow extends CapabilityRow {
  transport: string
}

export interface Capabilities {
  toolsets: ToolsetRow[]
  /**
   * Whether this bot has a toolset pin of its own.
   *
   * `false` does NOT mean nothing is enabled — the switches above are the
   * gateway's platform defaults, and the first one anybody touches writes a pin
   * of everything currently on. The sheet says so rather than letting the
   * reader discover it.
   */
  toolsetsPinned: boolean
  skills: CapabilityRow[]
  mcpServers: McpRow[]
}

export const capabilitiesFrom = (described: ProfilesDescribeResult): Capabilities => ({
  toolsets: (described.toolsets ?? []).map(entry => ({
    name: entry.name,
    label: entry.label || entry.name,
    description: entry.description ?? '',
    toolCount: entry.tool_count ?? 0,
    enabled: entry.enabled !== false
  })),
  toolsetsPinned: described.toolsets_pinned === true,
  skills: (described.skills ?? []).map(entry => ({ name: entry.name, enabled: entry.enabled !== false })),
  mcpServers: (described.mcp_servers ?? []).map(entry => ({
    name: entry.name,
    enabled: entry.enabled !== false,
    transport: entry.transport ?? 'stdio'
  }))
})

/**
 * The three sections as `profiles.configure` params, from a whole desired state.
 *
 * Taking the state rather than a delta is the point: every section replaces,
 * so the caller must always know all of it. Exported separately from the round
 * trip so the polarities can be asserted without a socket.
 */
export const configureParamsFor = (
  name: string,
  next: Capabilities,
  sections: { toolsets?: boolean; skills?: boolean; mcp?: boolean }
): ProfilesConfigureParams => ({
  name,
  ...(sections.skills ? { disabled_skills: next.skills.filter(row => !row.enabled).map(row => row.name) } : {}),
  /*
    The desktop's own rule, and it is not an optimisation: `enabled_toolsets: []`
    unpins. Sending the full list when everything is on would pin a snapshot of
    the gateway's defaults that then stops following them.
  */
  ...(sections.toolsets
    ? {
        enabled_toolsets: next.toolsets.every(row => row.enabled)
          ? []
          : next.toolsets.filter(row => row.enabled).map(row => row.name)
      }
    : {}),
  ...(sections.mcp ? { enabled_mcp_servers: next.mcpServers.filter(row => row.enabled).map(row => row.name) } : {})
})

export type CapabilitySection = 'toolsets' | 'skills' | 'mcp'

export class CapabilitiesController {
  constructor(private readonly gateway: ChatGateway) {}

  async load(profile: string): Promise<Capabilities> {
    return capabilitiesFrom(await this.gateway.request('profiles.describe', { name: profile }))
  }

  /**
   * Write one section, from the whole state it should end in.
   *
   * Only the section that changed is sent. `_configure_cfg_sections` applies
   * the sections a request carries and leaves the rest alone, so naming all
   * three on every toggle would rewrite two settings nobody touched — and
   * would pin the toolsets the first time anybody moved a skill.
   */
  async save(profile: string, next: Capabilities, section: CapabilitySection): Promise<void> {
    const result = await this.gateway.request(
      'profiles.configure',
      configureParamsFor(profile, next, {
        toolsets: section === 'toolsets',
        skills: section === 'skills',
        mcp: section === 'mcp'
      })
    )
    // `applied` names the section with upstream's word, which is not the
    // parameter's: `skills`, `toolsets`, `mcp_servers`.
    const key = section === 'mcp' ? 'mcp_servers' : section
    const applied = result.applied as Record<string, unknown> | undefined

    if (applied?.[key] === false) {
      throw new Error('The gateway accepted the request but did not apply the change.')
    }
  }
}
