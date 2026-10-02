export {
  isSafeShareFileName,
  isSafeShareId,
  parseShareClaim,
  parseShareEntry,
  parseShareManifest,
  shareFiles,
  shareMessageText,
  shareSummary,
  sortShares,
  SHARE_CLAIM_FILE,
  SHARE_CLAIM_VERSION,
  SHARE_ITEM_LIMIT,
  SHARE_MANIFEST_FILE,
  SHARE_MANIFEST_VERSION,
  SHARE_NOTE_LIMIT,
  SHARE_OUTBOX_DIRECTORY,
  type PendingShare,
  type ResolvedShareItem,
  type ShareClaim,
  type ShareItem,
  type ShareItemKind,
  type ShareManifest,
  type ShareOutboxEntry
} from './outbox'
export {
  buildShareDeliveryRecord,
  dropShareDeliveryRecordFor,
  parseShareDeliveryRecord,
  publishedShareDeliveryGateway,
  writeShareDeliveryRecord,
  SHARE_DELIVERY_KEY,
  SHARE_DELIVERY_RECORD_VERSION,
  type ShareDeliveryAuthHeader,
  type ShareDeliveryRecord,
  type ShareDeliveryRecordInput
} from './delivery-credential'
export {
  buildShareTargets,
  parseShareTargets,
  serialiseShareTargets,
  SHARE_TARGET_BOT_PLACEHOLDER,
  SHARE_TARGETS_FILE,
  SHARE_TARGETS_LIMIT,
  SHARE_TARGETS_VERSION,
  type ShareTarget,
  type ShareTargets,
  type ShareTargetsCopy,
  type ShareTargetsInput
} from './targets'
/*
  `useShareTargetSync` is deliberately NOT re-exported here.

  It is a hook, so it pulls React, the gateway context and the native seam in
  behind it — and the two shells import this barrel for one function. Its only
  caller is `ShareTargetHost`, which sits beside it and imports it by path.
*/
export { onShareRequest, requestShareDelivery } from './share-bus'
export { ShareDelivery, type ShareDeliveryPorts } from './share-delivery'
export { ShareTargetHost } from './ShareTargetHost'
export { ShareTargetSheet, type ShareTargetBot, type ShareTargetSheetProps } from './ShareTargetSheet'
