/**
 * What `profiles.describe` says about one bot, as the profile page works with it
 * (the native app's `BotProfileDetails`, which this follows).
 *
 * The three capability lists are stored three different ways on the gateway and every write replaces a
 * WHOLE list (`params.ts`), so all of each is kept. Every text field is the gateway's and untrusted: the page
 * draws it as characters, never as Markdown.
 */
import type { ProfilesDescribeResult } from '@hermes/shared/gateway-contract'

/** One toolset the bot can use (`toolsets`). */
export interface BotToolset {
  name: string
  label: string
  /** What the toolset is for. Untrusted text. */
  details: string
  toolCount: number
  enabled: boolean
}

/** One skill or one MCP server with a switch. */
export interface BotSwitch {
  name: string
  enabled: boolean
  /** MCP servers only: `stdio`, `http` and so on. */
  transport: string
}

/** The model a bot pins; both empty while it follows the gateway's own. */
export interface BotModelPin {
  provider: string
  model: string
}

export interface BotProfileDetails {
  /** The profile's handle. */
  name: string
  description: string
  /** The profile's `SOUL.md`. Read for completeness only; this page does not edit it. */
  soul: string
  model: BotModelPin
  toolsets: BotToolset[]
  /**
   * Whether the bot has a toolset list of its own. `false` does not mean nothing is on: the switches
   * are the gateway's defaults, and the first one moved pins the whole list.
   */
  toolsetsPinned: boolean
  skills: BotSwitch[]
  mcpServers: BotSwitch[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** `profiles.describe`, as details. `fallback` names the profile asked about, for an answer that leaves its own name out. */
export function detailsOf(described: ProfilesDescribeResult, fallback: string): BotProfileDetails {
  const named = <T extends { name?: unknown }>(entries: readonly T[] | undefined): T[] =>
    (Array.isArray(entries) ? entries : []).filter(entry => typeof entry?.name === 'string' && entry.name !== '')

  return {
    name: text(described.name) || fallback,
    description: text(described.description),
    soul: text(described.soul),
    model: { provider: text(described.model?.provider), model: text(described.model?.default) },
    toolsets: named(described.toolsets).map(entry => ({
      name: entry.name,
      label: text(entry.label) || entry.name,
      details: text(entry.description),
      toolCount: typeof entry.tool_count === 'number' ? entry.tool_count : 0,
      enabled: entry.enabled !== false
    })),
    toolsetsPinned: described.toolsets_pinned === true,
    skills: named(described.skills).map(entry => ({
      name: entry.name,
      enabled: entry.enabled !== false,
      transport: ''
    })),
    mcpServers: named(described.mcp_servers).map(entry => ({
      name: entry.name,
      enabled: entry.enabled !== false,
      transport: text(entry.transport) || 'stdio'
    }))
  }
}

/** The Skills toolset is listed and off: the bot then gets no skill tools whatever the per-skill switches say. */
export const skillsToolsetOff = (details: BotProfileDetails): boolean =>
  details.toolsets.some(toolset => toolset.name === 'skills' && !toolset.enabled)
