/**
 * Every literal the Connectors page paints.
 *
 * Two of them carry an argument the rest of the app does not have to make, and
 * both are here rather than in a comment in the component because they are what
 * the reader is actually told:
 *
 *  - `scope.*` explains why this page is about ONE chat. `connectors.list`
 *    takes a `session_id` and the gateway authorises it by transport
 *    attachment, so there is no gateway-wide connector list to draw.
 *  - `disconnect` explains why there is no button. Upstream refuses to expose
 *    one on purpose; it is not a gap this app can paper over.
 */
import { localised } from '../../i18n/catalogue'

const connectorStringsEn = {
  settings: {
    row: 'Connectors',
    hint: 'Apps a bot can reach on your behalf'
  },

  title: 'Connectors',
  subtitle: 'Apps your bots sign in to.',
  back: 'Settings',

  loading: 'Reading the connectors…',
  failed: (reason: string) => `Could not read the connectors: ${reason}`,
  empty: 'This gateway offers no connectors.',

  /**
   * `available: false` is not a failure. It is what the gateway answers when
   * the `manage_connections` toolset is switched off for the bot, which is a
   * capability the reader can turn on — so it names the switch rather than
   * saying something went wrong.
   */
  unavailable: 'Connectors are switched off for this bot.',
  unavailableHint: 'Turn on the Connections toolset in the bot’s Capabilities, then come back.',

  /**
   * Why a page in Settings talks about one chat.
   *
   * The gateway scopes `connectors.list` to a session and authorises it by
   * which sessions this socket is attached to — so a connector list exists
   * only for a chat that is open. Saying "no connectors" instead would be a
   * lie about the gateway rather than a fact about the reader's account.
   */
  scope: {
    header: 'CHAT',
    hint: 'Connectors belong to a chat. This page reads the one you pick.',
    none: 'No chat is open.',
    noneHint: 'Open a chat first — a connector list only exists for a running conversation.'
  },

  state: {
    connected: 'Connected',
    notConnected: 'Not connected',
    disabled: 'Switched off',
    unknown: 'Unknown'
  },

  /** The vendor's own word for the connection, when it sent one. */
  reason: (text: string) => `Reason: ${text}`,

  connect: 'Connect…',
  reconnect: 'Reconnect…',
  connecting: 'Waiting for the browser…',
  connectHint: 'Opens your browser. Come back here when you have finished signing in.',
  connectOk: (name: string) => `${name} is connected.`,
  connectFailed: (reason: string) => `Could not connect: ${reason}`,
  connectNoUrl: 'The gateway opened an authorisation but did not say where to send you.',
  connectExpired: 'The authorisation expired before it finished.',
  connectSkipped: 'The authorisation was not completed.',

  refresh: 'Refresh',

  /**
   * The honest note about the button that is not there.
   *
   * `tools/connectors/tool.py` says it in as many words — disconnecting "is
   * deliberately user-only" — and there is no gateway method and no CLI
   * command behind it either. A control that always failed would teach the
   * reader that the app is broken; a sentence says whose decision it is.
   */
  disconnect: 'Signing out of a connector is done where you manage the account, not from Hermes.',

  detail: {
    /** The route's name, for a page below it; the page itself shows the connector's label. */
    title: 'Connector',
    back: 'Connectors',
    slug: 'Identifier',
    status: 'Status',
    enabled: 'Enabled',
    yes: 'Yes',
    no: 'No'
  }
}

/*
 * The English table above is the SOURCE, and `localised` is what makes it one
 * language among three: a read resolves against the active locale's catalogue
 * first and falls back to the sentence written here. See `i18n/catalogue.ts`.
 *
 * `connectorStringsEn` stays un-exported so there is exactly one way into these strings, and
 * so nothing can read past the layer by accident.
 */
export const connectorStrings = localised('connectors', connectorStringsEn)
