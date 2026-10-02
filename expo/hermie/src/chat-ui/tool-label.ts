/**
 * The name of a tool, short enough to stand in a header.
 *
 * A gateway spells a tool the way the server that owns it does, and an MCP server
 * spells it with everything it needs to be unique across servers:
 * `mcp__terminal__run_in_terminal`. In a transcript that is fine — a tool card has
 * a whole line for it. In the header's pill it is the longest thing on screen, and
 * the pill used to be as wide as whatever the bot happened to be doing.
 *
 * Two rules, and the first one is not a truncation:
 *
 *  - **`mcp__server__verb` is named by its SERVER.** The prefix is a namespace and
 *    the verb after it is one call out of a set; what a reader wants from a status
 *    line is which thing is being used, not which of its functions. So the first
 *    group after `mcp__` is the whole answer, and `mcp__terminal__run_in_terminal`
 *    is `terminal`.
 *  - **Anything else is the tool's own name**, capped. A plain `Bash` or
 *    `str_replace_editor` is already what its author called it, and shortening it
 *    on a rule of our own would invent a name nothing else in the app uses.
 *
 * The cap is a last resort rather than the mechanism: at `meta` size, eighteen
 * characters is about what fits beside `Running` and `…` without the status line
 * needing to be elided by the layout, and a name that long is a name no rule here
 * can shorten honestly.
 */

/** Past this, the name is cut and given an ellipsis of its own. */
export const TOOL_NAME_MAX = 18

/** The namespace an MCP tool carries, and the separator inside it. */
const MCP_PREFIX = 'mcp__'
const MCP_SEPARATOR = '__'

export function shortToolName(raw: string): string {
  const name = raw.trim()

  if (name === '') {
    return ''
  }

  const namespaced = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : null
  // Only the MCP form drops anything: the separator is the namespace's own, and a
  // tool that merely HAS a double underscore in it has not told us it is one.
  const server = namespaced === null ? name : (namespaced.split(MCP_SEPARATOR)[0] ?? namespaced)
  const chosen = server === '' ? name : server

  return chosen.length > TOOL_NAME_MAX ? `${chosen.slice(0, TOOL_NAME_MAX - 1)}…` : chosen
}
