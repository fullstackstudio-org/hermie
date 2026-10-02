/**
 * Every literal the MCP servers page paints.
 *
 * "MCP" is left unexpanded. It is the name of the protocol, it is what the
 * gateway's config calls the section, and a reader who has configured one
 * knows the initials; spelling out Model Context Protocol in a row title would
 * help nobody and would not fit.
 */
import { localised } from '../../i18n/catalogue'

const mcpStringsEn = {
  settings: {
    row: 'MCP servers',
    hint: 'Tools your bots reach over the Model Context Protocol'
  },

  title: 'MCP servers',
  subtitle: 'Tools your bots can reach.',
  back: 'Settings',

  loading: 'Reading the server list…',
  failed: (reason: string) => `Could not read the servers: ${reason}`,
  empty: 'No MCP servers are configured on this gateway.',
  emptyHint: 'Add one with `hermes mcp add`, or from the Hermes desktop app.',

  /**
   * The cheap `status` view's vocabulary, said in words.
   *
   * `unknown` is its own line rather than being folded into "not connected":
   * a configured server that has never been started has no runtime row at all,
   * and calling that a failure puts a red dot on every lazily-started server on
   * a gateway that has just booted.
   */
  runtime: {
    connected: 'Connected',
    connecting: 'Connecting…',
    failed: 'Not connected',
    disabled: 'Switched off',
    lazy: 'Starts when needed',
    configured: 'Configured',
    unknown: 'Not started yet'
  },

  toolCount: (count: number) => `${count} ${count === 1 ? 'tool' : 'tools'}`,

  detail: {
    /** The route's name, for a page below it; the page itself shows the server's name. */
    title: 'MCP server',
    back: 'MCP servers',
    transport: 'Transport',
    address: 'Address',
    auth: 'Authentication',
    authNone: 'None',
    env: 'ENVIRONMENT KEYS',
    envHint: 'The gateway never sends their values — only which keys this server expects.',
    tools: 'TOOLS',
    toolsUnknown: 'Test the connection to see what this server offers.',
    toolsEmpty: 'This server offered no tools.'
  },

  /**
   * The probe. Its own verb because it is the only call on this page that
   * CONNECTS: a cold `npx` server takes seconds, so nothing probes on the
   * reader's behalf and the page never probes a list.
   */
  test: 'Test connection',
  testing: 'Connecting…',
  testOk: (count: number) => `Connected. ${count} ${count === 1 ? 'tool' : 'tools'} available.`,
  testFailed: (reason: string) => `Could not connect: ${reason}`,

  needsAuth: 'Needs authorising',
  authorise: 'Authorise…',
  authorising: 'Waiting for the browser…',
  authoriseHint: 'Opens your browser. Come back here when you have finished signing in.',
  authoriseOk: 'Authorised.',
  authoriseFailed: (reason: string) => `Authorisation did not finish: ${reason}`,

  reload: 'Reload servers',
  reloadHint: 'Applies configuration changes to chats that are already running.'
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `mcpStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const mcpStrings = localised('mcp', mcpStringsEn)
