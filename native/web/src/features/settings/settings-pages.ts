/**
 * The small Settings pages (Account, Gateway, Passkeys, MCP, Chats, Notifications, Appearance, Voice, About) as one
 * chunk.
 *
 * Each is one to eight kilobytes, and as chunks of their own they were nine files and two style sheets for some thirty
 * kilobytes, in a bundle the plugin importer takes no more than 80 files of. A person in Settings moves between them,
 * so they are fetched together: a section's loader in `sections.ts` asks for this module and picks its page, the way
 * `manage-pages.ts` does for the gateway-management pages. Nothing outside those loaders imports it, and nothing the
 * first load needs may (`entry-graph.test.ts`).
 */
export { About } from './About'
export { Account } from './Account'
export { Appearance } from './Appearance'
export { Chats } from './Chats'
export { Gateway } from './Gateway'
export { Mcp } from './MCP'
export { Notifications } from './Notifications'
export { Passkeys } from './Passkeys'
export { Voice } from './Voice'
