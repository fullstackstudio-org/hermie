/**
 * Where the request layer gets its sheets (`sheets.ts`, a chunk of its own).
 *
 * `React.lazy` would suspend on the first render of each sheet even when the
 * chunk is already in memory, and a question that stops a bot must be on screen
 * the moment it arrives. So the chunk is held here once it has loaded
 * (`chunk-holder.ts`), and a component that reads it through `useRequestSheets`
 * renders the sheet in the same pass from then on. The entry module calls
 * `preloadRequestSheets` right after the session starts, which is long before
 * the first request can arrive; should one arrive first anyway, the dialog is
 * drawn with nothing in it until the chunk is there.
 *
 * A fetch that fails (offline, a deploy that replaced the chunk) is forgotten,
 * and a layer that has a request to show asks again every few seconds.
 */
import { CHUNK_RETRY_MS, createChunkHolder } from './chunk-holder'
import type * as Sheets from './sheets'

export type RequestSheets = typeof Sheets

/** How long a layer waits before asking again for a chunk that did not arrive. */
export const SHEETS_RETRY_MS = CHUNK_RETRY_MS

const holder = createChunkHolder<RequestSheets>()
const load = (): Promise<RequestSheets> => import('./sheets')

/** Fetch the sheets' chunk, once; resolves at once when it is in memory. */
export const preloadRequestSheets = (): Promise<RequestSheets> => holder.preload(load)

/**
 * The sheets, or undefined while their chunk is not in memory. `wanted` is
 * whether the caller has something to draw with them: only then is a missing
 * chunk fetched, and fetched again after a failure.
 */
export const useRequestSheets = (wanted: boolean): RequestSheets | undefined => holder.use(load, wanted)
