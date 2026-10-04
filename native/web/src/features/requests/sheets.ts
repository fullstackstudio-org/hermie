/**
 * The request layer's sheets, as one chunk of their own (`request-sheets.ts`
 * loads it). Nothing on the first screen draws a sheet, so none of them is in
 * the entry bundle; the chunk is fetched as soon as the session has started and
 * is in memory long before a bot can ask anything.
 */
export { ApprovalSheet } from './ApprovalSheet'
export { ClarifySheet } from './ClarifySheet'
export { ConfirmSheet } from './ConfirmSheet'
export { ConnectionSheet } from './ConnectionSheet'
export { DiffSheet } from './DiffSheet'
export { DraftSheet } from './DraftSheet'
export { FileSheet } from './FileSheet'
export { FormSheet } from './FormSheet'
export { SecretSheet } from './SecretSheet'
export { SudoSheet } from './SudoSheet'
export { VaultCodeSheet } from './VaultCodeSheet'
export { VaultSaveLoginSheet } from './VaultSaveLoginSheet'
export { VaultUnlockSheet } from './VaultUnlockSheet'

/**
 * The sheets that reach for the device (a signature pad, the location, the contact picker, the camera, the microphone)
 * are a chunk of their own, fetched when a request that needs one is on the page (`device-sheets.ts`). It is imported
 * from here, not from the first load, so it shares the frame, the strings and the upload with these sheets.
 */
export const loadDeviceSheets = (): Promise<typeof import('./device-sheets')> => import('./device-sheets')
