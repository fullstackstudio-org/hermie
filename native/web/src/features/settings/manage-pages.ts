/**
 * The five gateway-management pages of Settings (Memory, Skills, MCP servers, Connectors, Boards) as one chunk.
 *
 * Each page is only a few kilobytes, and what they share (`manage-runtime`, the words in `manage-strings`, the styles
 * in `manage.css`, the transport) would otherwise be a chunk of its own beside five of theirs. The plugin importer
 * accepts 80 files, so what is fetched on demand together is one file: a section's loader in `sections.ts` asks for
 * this module and picks its page. Nothing outside those loaders imports it, and nothing the first load needs may
 * (`entry-graph.test.ts`).
 */
export { Boards } from './Boards'
export { Connectors } from './Connectors'
export { McpServers } from './McpServers'
export { Memory } from './Memory'
export { Skills } from './Skills'
