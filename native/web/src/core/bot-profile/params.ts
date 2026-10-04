/**
 * The params of every write the bot profile makes, and how each answer is read, as pure functions so the
 * rules that are invisible at the call site can be asserted without a socket.
 *
 * Every section of `profiles.configure` is independent: a request carries only the sections it means, and
 * `applied` reports each. The three capability sections are stored with three different polarities, and
 * every one of them replaces a WHOLE list (the native app's `BotSettingsParams`, and the gateway's
 * `methods_profiles.py`):
 *
 *  - **skills** are stored as the DISABLED set. Sending only the skill that changed would switch every
 *    other disabled skill back on.
 *  - **toolsets** are stored as an optional PIN of enabled names, and an EMPTY list removes the pin rather
 *    than emptying it. So a switch always writes the names that are on, which is what is on screen; and
 *    "follow the gateway's defaults" is its own explicit request, an empty list (`toolsetDefaultsParams`).
 *    A pin of nothing cannot be written at all.
 *  - **MCP servers** are stored per server as off, so the wire carries the ENABLED list, the opposite of
 *    skills in the same call.
 *
 * `tools.configure` is deliberately not used: it edits the profile of the live session it is handed, which
 * is whichever bot happens to be talking.
 */
import type { ProfilesConfigureParams, ProfilesSetAssetParams, ReloadMcpParams } from '@hermes/shared/gateway-contract'

import type { BotSwitch, BotToolset } from './details'
import { BotProfileFailure } from './failure'

/** The one asset a profile has. */
export const AVATAR_ASSET = 'avatar'

/** `description`, trimmed as the gateway stores it. */
export const descriptionParams = (profile: string, text: string): ProfilesConfigureParams => ({
  name: profile,
  description: text.trim()
})

/** The toolsets that are on, whole: a pin of exactly what is on screen. */
export const toolsetsParams = (profile: string, toolsets: readonly BotToolset[]): ProfilesConfigureParams => ({
  name: profile,
  enabled_toolsets: toolsets.filter(toolset => toolset.enabled).map(toolset => toolset.name)
})

/** Take the pin away: the bot follows the gateway's own toolset defaults again. An empty list is how it is asked. */
export const toolsetDefaultsParams = (profile: string): ProfilesConfigureParams => ({
  name: profile,
  enabled_toolsets: []
})

/** The skills that are OFF, whole. */
export const skillsParams = (profile: string, skills: readonly BotSwitch[]): ProfilesConfigureParams => ({
  name: profile,
  disabled_skills: skills.filter(skill => !skill.enabled).map(skill => skill.name)
})

/** The MCP servers that are ON, whole. */
export const mcpParams = (profile: string, servers: readonly BotSwitch[]): ProfilesConfigureParams => ({
  name: profile,
  enabled_mcp_servers: servers.filter(server => server.enabled).map(server => server.name)
})

/** `profiles.set_asset` with a picture: bare base64 (PNG, JPEG or WebP, up to 2 MB). */
export const avatarParams = (profile: string, base64: string): ProfilesSetAssetParams => ({
  name: profile,
  asset: AVATAR_ASSET,
  data: base64
})

/** `profiles.set_asset` taking the picture away. */
export const clearAvatarParams = (profile: string): ProfilesSetAssetParams => ({
  name: profile,
  asset: AVATAR_ASSET,
  clear: true
})

/**
 * `reload.mcp`: applies a changed MCP list to chats that are already running. Without `confirm` the gateway
 * may answer `confirm_required`; `always` proceeds and clears that approval in the gateway's own config,
 * which the CLI and the desktop app share.
 */
export function reloadMcpParams(
  options: { confirm?: boolean; always?: boolean; sessionId?: string } = {}
): ReloadMcpParams {
  return {
    ...(options.confirm ? { confirm: true } : {}),
    ...(options.always ? { always: true } : {}),
    ...(options.sessionId ? { session_id: options.sessionId } : {})
  }
}

/** The section's name in `applied`: the gateway's word, which is not always the parameter's. */
export type AppliedSection = 'description' | 'skills' | 'toolsets' | 'mcp_servers'

/**
 * A `profiles.configure` answer for one section. A request the gateway accepted but did not apply is a
 * failure the page must say, not a success: `applied` names every section the request carried, so a section
 * that is not `true` there was not written. An answer with no `applied` at all reports nothing, and is taken
 * at its word.
 */
export function checkApplied(reply: unknown, section: AppliedSection): void {
  const applied = (reply as { applied?: unknown } | null | undefined)?.applied

  if (typeof applied !== 'object' || applied === null || Array.isArray(applied)) {
    return
  }

  if ((applied as Record<string, unknown>)[section] !== true) {
    throw new BotProfileFailure('not_applied')
  }
}

/** What a `reload.mcp` said: it reloaded, or it wants the person's answer first (with the gateway's own warning). */
export type ReloadAnswer = { kind: 'reloaded' } | { kind: 'confirm'; message: string }

export function reloadAnswer(reply: unknown): ReloadAnswer {
  const answer = reply as { status?: unknown; message?: unknown } | null | undefined

  return answer?.status === 'confirm_required'
    ? { kind: 'confirm', message: typeof answer.message === 'string' ? answer.message : '' }
    : { kind: 'reloaded' }
}
