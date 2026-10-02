/**
 * What each language CLAIMS to cover, and the keys it is excused from.
 *
 * The completeness test (`coverage.test.ts`) is driven entirely from here, and
 * the shape is two lists rather than one because they answer two different
 * questions:
 *
 *  - `TRANSLATED_TREES` is the claim. A tree listed here must be complete, and
 *    a new English key under it fails the build until somebody translates it.
 *    That is the whole point: English is the source, translations drift, and a
 *    round that adds copy should find out in CI rather than from a reader.
 *  - `UNTRANSLATED_KEYS` is the escape hatch, one key at a time. It exists so a
 *    round CAN add an English string today and translate it next week without
 *    either dropping the tree's claim or blocking the commit — the price is
 *    that the key has to be named, so the list is a to-do somebody can read.
 *
 * The test also fails on a STALE entry: a key that has since been translated
 * has to leave this list. An allow-list nobody prunes stops being an allow-list
 * and becomes a hole.
 */
import type { TreeName } from './catalogue'
import { TREE_NAMES } from './trees'
import type { Locale } from './locales'

export type TranslatedLocale = Exclude<Locale, 'en'>

/**
 * Which trees each language claims.
 *
 * A claim is a promise the completeness test enforces, so a language appears
 * here in the commit that translates it and not before — which is also what
 * makes that commit's test fail without its change. `TREE_NAMES` rather than a
 * list written out: a twelfth string table added to the app is claimed the
 * moment `trees.ts` learns about it, rather than quietly going uncovered.
 */
export const TRANSLATED_TREES: Record<TranslatedLocale, readonly TreeName[]> = {
  nl: TREE_NAMES,
  de: TREE_NAMES
}

/**
 * Keys a language deliberately does not answer, as `tree.path.to.key`.
 *
 * Two kinds live here and both are legitimate:
 *
 *  - A string that is the SAME in that language. A translation that repeats the
 *    English word buys nothing and costs a line somebody has to keep in step;
 *    `mcp.title` is "MCP servers" in Dutch too.
 *  - A shell command, a config key or a URL. `hermes plugins install kanban` is
 *    typed into a terminal, and a terminal does not speak Dutch.
 *
 * Anything else in this list is a to-do.
 */
export const UNTRANSLATED_KEYS: Record<TranslatedLocale, readonly string[]> = {
  nl: [
    'app.app.name',
    'app.onboarding.address.placeholder',
    'app.onboarding.address.frontDoor.cloudflare',
    'app.onboarding.address.frontDoor.clientId',
    'app.onboarding.address.frontDoor.clientIdPlaceholder',
    'app.onboarding.address.frontDoor.clientSecret',
    'app.onboarding.address.headerName',
    'app.onboarding.signIn.chooseProvider',
    'app.onboarding.signIn.tokenLabel',
    'app.onboarding.signIn.tokenPlaceholder',
    'app.onboarding.signIn.webview.fallbackPlaceholder',
    'app.onboarding.test.checklist.rest',
    'app.onboarding.test.checklist.socket',
    'app.onboarding.done.gateway',
    'app.bots.title',
    // `Gateway: <name>` — the word is the same in this language.
    'app.bots.switchGateway',
    'app.bots.sidebarHeader',
    'app.presence.online',
    'app.presence.offline',
    'app.layout.accents.indigo',
    'app.layout.accents.violet',
    'app.layout.accents.magenta',
    'app.layout.accents.teal',
    'app.menuBar.chats',
    'app.signedOut.stopped.onGateway',
    'app.signedOut.stopped.gateway',
    'app.gateway.latency',
    'app.activity.counters.subagents',
    'app.activity.to',
    'app.activity.reply',
    'app.tabs.chats',
    'app.tabs.routines',
    'app.sidebar.hermieWeb',
    'app.chat.stop',
    'app.chat.connection.offline',
    'app.chat.subtitle.idle',
    'app.chat.subtitle.offline',
    'app.settings.gateway',
    'app.settings.viaHermieWeb',
    'app.settings.provider',
    'app.settings.authModeToken',
    'app.settings.webUpdate.header',
    'app.settings.webUpdate.state',
    'app.settings.status',
    'app.settings.plugin',
    'app.settings.notifications.typeCron',
    'app.settings.gateways.header',
    'app.settings.gateways.row',
    'app.settings.gateways.title',
    'app.settings.gateways.authModeToken',
    'app.settings.gateways.detailTitle',
    'app.settings.gateways.back',
    'app.settings.account',
    'app.settings.chat',
    'app.settings.themes.accentFill',
    'app.settings.themes.colourPlaceholder',
    'app.settings.host',
    'app.settings.lock.options.1m',
    'app.settings.lock.options.5m',
    'app.settings.lock.options.15m',
    'app.connection.status.offline',
    'app.botProfile.model',
    'app.botProfile.provider',
    'app.botProfile.gatewayVersion',
    'app.botProfile.unknown',

    'chat.assistant.footer',
    'chat.botDm.to',
    'chat.subagents.title',
    'chat.subagents.stop',
    'chat.subagents.transcriptTitle',
    'chat.cron.eyebrow',
    'chat.header.idle',
    'chat.header.offline',
    'chat.clarify.later',
    'chat.context.percent',
    'chat.context.counts',
    'chat.options.model',

    'connectors.settings.row',
    'connectors.title',
    'connectors.scope.header',
    'connectors.detail.back',
    'connectors.detail.slug',
    'connectors.detail.status',

    'cron.title',
    'cron.detail.back',
    'cron.detail.modelLabel',
    'cron.detail.skillsLabel',
    'cron.detail.details',
    'cron.detail.unknown',
    'cron.run.back',
    'cron.schedule.modes.interval',
    'cron.schedule.modes.cron',
    'cron.schedule.timePlaceholder',
    'cron.schedule.cronPlaceholder',
    'cron.schedule.oncePlaceholder',

    'kanban.settings.row',
    'kanban.menu',
    'kanban.title',
    'kanban.absentCommand',
    'kanban.board.back',
    'kanban.columns.triage',
    'kanban.columns.review',
    'kanban.moveRefused',
    'kanban.card.back',

    'memory.raw.missingCommand',

    'mcp.settings.row',
    'mcp.title',
    'mcp.toolCount',
    'mcp.detail.back',
    'mcp.detail.transport',
    'mcp.detail.tools',

    'memory.graph.reset',
    'memory.providers.header',

    'profiles.settings.group',
    'profiles.new.handle',
    'profiles.new.handlePlaceholder',
    'profiles.new.displayNamePlaceholder',
    'profiles.new.model',
    'profiles.capabilities.toolsets',
    'profiles.capabilities.toolCount',
    'profiles.capabilities.skills',
    'profiles.capabilities.mcp',

    'skills.settings.row',
    'skills.title',
    'skills.botPicker',
    'skills.searchPlaceholder'
  ],
  de: [
    'app.app.name',
    'app.onboarding.address.placeholder',
    'app.onboarding.address.frontDoor.cloudflare',
    'app.onboarding.address.frontDoor.clientId',
    'app.onboarding.address.frontDoor.clientIdPlaceholder',
    'app.onboarding.address.frontDoor.clientSecret',
    'app.onboarding.address.headerName',
    'app.onboarding.signIn.chooseProvider',
    'app.onboarding.signIn.webview.fallbackPlaceholder',
    'app.onboarding.test.checklist.rest',
    'app.onboarding.test.checklist.socket',
    'app.onboarding.done.gateway',
    'app.bots.title',
    // `Gateway: <name>` — the word is the same in this language.
    'app.bots.switchGateway',
    'app.bots.sidebarHeader',
    'app.presence.online',
    'app.presence.offline',
    'app.layout.accents.indigo',
    'app.layout.accents.magenta',
    'app.layout.accents.orange',
    'app.menuBar.chats',
    'app.signedOut.stopped.onGateway',
    'app.signedOut.stopped.gateway',
    'app.gateway.latency',
    'app.activity.to',
    'app.activity.reply',
    'app.tabs.chats',
    'app.tabs.routines',
    'app.sidebar.hermieWeb',
    'app.chat.connection.offline',
    'app.chat.subtitle.idle',
    'app.chat.subtitle.offline',
    'app.settings.gateway',
    'app.settings.provider',
    'app.settings.version',
    'app.settings.webUpdate.header',
    'app.settings.webUpdate.state',
    'app.settings.webUpdate.apply',
    'app.settings.status',
    'app.settings.plugin',
    'app.settings.gateways.header',
    'app.settings.gateways.row',
    'app.settings.gateways.title',
    'app.settings.gateways.detailTitle',
    'app.settings.gateways.name',
    'app.settings.gateways.back',
    'app.settings.chat',
    'app.settings.themeOptions.system',
    'app.settings.themes.name',
    'app.settings.themes.colourPlaceholder',
    'app.settings.host',
    'app.settings.port',
    'app.connection.status.offline',
    'app.botProfile.provider',
    'app.botProfile.session',
    'app.botProfile.gatewayVersion',
    'app.botProfile.unknown',

    'chat.assistant.footer',
    'chat.botDm.to',
    'chat.cron.eyebrow',
    'chat.header.idle',
    'chat.header.offline',
    'chat.context.percent',
    'chat.context.counts',
    'chat.options.verbosityOptions.normal',
    'chat.voice.rateOptions.normal',

    'connectors.settings.row',
    'connectors.title',
    'connectors.scope.header',
    'connectors.detail.back',
    'connectors.detail.status',

    'cron.title',
    'cron.detail.back',
    'cron.detail.skillsLabel',
    'cron.detail.details',
    'cron.detail.pause',
    'cron.detail.unknown',
    'cron.run.back',
    'cron.editor.name',
    'cron.schedule.modes.cron',
    'cron.schedule.timePlaceholder',
    'cron.schedule.cronPlaceholder',
    'cron.schedule.oncePlaceholder',
    'cron.relative.inSeconds',
    'cron.relative.inMinutes',
    'cron.relative.inHours',
    'cron.relative.inDays',

    'kanban.settings.row',
    'kanban.menu',
    'kanban.title',
    'kanban.absentCommand',
    'kanban.board.back',
    'kanban.columns.triage',
    'kanban.moveRefused',
    'kanban.card.back',

    'memory.raw.missingCommand',

    'mcp.settings.row',
    'mcp.title',
    'mcp.detail.back',
    'mcp.detail.transport',
    'mcp.detail.tools',

    'memory.tabs.graph',
    'memory.sections.memory',
    'memory.sections.user',

    'profiles.settings.group',
    'profiles.new.handle',
    'profiles.new.handlePlaceholder',
    'profiles.new.displayNamePlaceholder',
    'profiles.capabilities.toolsets',
    'profiles.capabilities.skills',
    'profiles.capabilities.mcp',

    'skills.settings.row',
    'skills.title',
    'skills.botPicker',
    'skills.searchPlaceholder'
  ]
}

/** The allow-list for one tree, with the tree prefix stripped, as a set. */
export function excusedKeys(locale: TranslatedLocale, tree: TreeName): Set<string> {
  const prefix = `${tree}.`

  return new Set(
    UNTRANSLATED_KEYS[locale].filter(entry => entry.startsWith(prefix)).map(entry => entry.slice(prefix.length))
  )
}
