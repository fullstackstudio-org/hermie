/**
 * The microphone and the reader as one chunk.
 *
 * Both are fetched on demand, each from a different place (the composer's dictation button, the first read-aloud),
 * and share the speech code. One module is the entry of the chunk so that the bundle holds one file for them, not a
 * file each (the plugin importer accepts 80). Nothing the first load needs may import it (`entry-graph.test.ts`).
 */
export { DictationButton } from './DictationButton'
export { createReadAloud } from './read-aloud'
