/**
 * The sheets that reach for the device (a signature pad, the location, the contact picker, the camera for a code, the
 * microphone) as one chunk of their own, behind the request sheets' chunk: `sheets.ts` loads it on demand
 * (`loadDeviceSheets`), once a request that needs one is on the page (`device-sheets-loader.ts`).
 *
 * Most gateways never ask for any of them, and the pad, the recorder and the scanner are the largest part of the request
 * sheets, so none of it is fetched until it is wanted. Because the request sheets' chunk is what imports it, the frame,
 * the strings and the upload they share are in memory already and are not repeated here. The plugin importer accepts 80
 * files, so what is fetched together is one file: this barrel (`features/settings/manage-pages.ts` is the pattern).
 * Nothing the first load needs may reach it (`entry-graph.test.ts`).
 */
export { ContactSheet } from './ContactSheet'
export { DeviceSheet } from './DeviceSheet'
export { LocationSheet } from './LocationSheet'
export { ScanSheet } from './ScanSheet'
export { SignatureSheet } from './SignatureSheet'
export { VoiceSheet } from './VoiceSheet'
