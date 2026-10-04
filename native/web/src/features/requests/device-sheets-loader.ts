/**
 * Where the request layer gets the device sheets (`device-sheets.ts`, a chunk of its own behind the request sheets').
 *
 * The same holder as the request sheets' (`chunk-holder.ts`): held once loaded, so the sheet renders in the same pass from
 * then on, and asked for again every few seconds after a failed fetch. The difference is WHEN: the request sheets are
 * fetched as soon as the session starts, these only when a request that needs one is on the page, because most gateways
 * never send one. The fetch is the request sheets' own `loadDeviceSheets`, so this needs those first.
 */
import { createChunkHolder } from './chunk-holder'
import type * as Sheets from './device-sheets'

export type DeviceSheets = typeof Sheets

const holder = createChunkHolder<DeviceSheets>()

/**
 * The device sheets, or undefined while their chunk is not in memory. `load` is how to fetch it (absent while the request
 * sheets themselves are not there yet); `wanted` is whether a request that needs one is on the page.
 */
export const useDeviceSheets = (
  load: (() => Promise<DeviceSheets>) | undefined,
  wanted: boolean
): DeviceSheets | undefined => holder.use(load, wanted)
