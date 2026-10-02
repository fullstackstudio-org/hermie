/**
 * The chat UI kit: every surface a Hermes bot chat draws.
 *
 * Components take transcript items and callbacks — no store, no gateway, no
 * navigation. That is what lets the developer gallery render all of them from
 * literals, and what keeps the data layer free to change shape underneath.
 */
export { AgentsBar, type AgentsBarProps } from './AgentsBar'
export { AttachMenu, type AttachMenuProps } from './AttachMenu'
export { AgentsSheet, type AgentsSheetProps, type SubagentTranscript } from './AgentsSheet'
export { AssistantBubble, type AssistantBubbleProps } from './AssistantBubble'
export {
  AttachmentGallery,
  GALLERY_GRID_HEIGHT,
  GALLERY_SOLO_MAX_HEIGHT,
  gridColumns,
  type AttachmentGalleryProps,
  type GalleryAttachment
} from './AttachmentGallery'
export { BotDmAside, dmHandleOf, markerFor, type BotDmAsideProps, type BotDmItem } from './BotDmAside'
export { BotDmRollup, useRollupExpanded, type BotDmRollupProps } from './BotDmRollup'
export { ChatHeader, SidebarToggleButton, type ChatHeaderProps } from './ChatHeader'
export { Composer, type ComposerProps } from './Composer'
export { ContextMeter, contextSummary, formatContextCounts, formatTokens, type ContextMeterProps } from './ContextMeter'
export { CronDeliveryCard, type CronDeliveryCardProps } from './CronDeliveryCard'
export { DateSeparator, type DateSeparatorProps } from './DateSeparator'
export { DiffView, type DiffViewProps } from './DiffView'
export { FileChip, fileGlyph, type FileChipProps } from './FileChip'
export { ImageCard, type ImageCardProps } from './ImageCard'
export {
  clampScale,
  DISMISS_FRACTION,
  ImageViewer,
  MAX_SCALE,
  MIN_SCALE,
  pinchDistance,
  shouldDismiss,
  type ImageViewerProps
} from './ImageViewer'
export { ErrorCard, type ErrorCardProps } from './ErrorCard'
export { JumpToLatestPill, type JumpToLatestPillProps } from './JumpToLatestPill'
export { NoticePill, type NoticePillProps } from './NoticePill'
export { QueuedChip, type QueuedChipProps } from './QueuedChip'
export { QueuedStrip, type QueuedRowEntry, type QueuedStripProps, QUEUE_STRIP_LIMIT } from './QueuedStrip'
export { ReasoningDisclosure, type ReasoningDisclosureProps } from './ReasoningDisclosure'
export { StatusRow, type StatusRowProps } from './StatusRow'
export { SubagentGroupCard, type SubagentGroupCardProps } from './SubagentGroupCard'
export { isSystemLineNotice, SystemLine, systemLineText, type SystemLineProps } from './SystemLine'
export { ToolCard, type ToolCardProps } from './ToolCard'
export { shortToolName, TOOL_NAME_MAX } from './tool-label'
export {
  TranscriptList,
  type TranscriptContext,
  type TranscriptListHandle,
  type TranscriptListProps
} from './TranscriptList'
export { TypingDots, TypingIndicator, type TypingIndicatorProps } from './TypingIndicator'
export { attachmentName, UserBubble, type UserBubbleProps, type UserSender } from './UserBubble'

export { Avatar, type AvatarProps } from './primitives/Avatar'
export {
  Bubble,
  bubbleCorners,
  bubblePaddingX,
  resolveBubbleWidth,
  TAIL_REACH,
  useBubbleWidth,
  useLedgerWidth,
  type BubbleProps
} from './primitives/Bubble'
export { BubbleColumn, useBubbleColumnWidth } from './primitives/BubbleColumn'
export { Chip, type ChipProps } from './primitives/Chip'
export { Fold, useFoldHeight, type FoldProps } from './primitives/Fold'
export { LedgerRow, type LedgerRowProps } from './primitives/LedgerRow'
export { MetaLine, type MetaLineProps } from './primitives/MetaLine'
export { SenderLabel, type SenderLabelProps } from './primitives/SenderLabel'
export { Ticks, type TicksProps } from './primitives/Ticks'

export { ExpandedProvider, useExpanded, useExpandedApi, type ExpandedApi } from './expanded'
export { hasReply, isDmOut, rollupDmRuns, ROLLUP_THRESHOLD, type DmRowRole, type DmRun } from './dm-rollup'
export { dateStampFor, GROUP_WINDOW_SECONDS, layoutRows, speakerKey, type RowLayout } from './grouping'

export { parseUnifiedDiff, summarizeDiff, type DiffLine, type DiffLineKind } from './diff'
export {
  clipInline,
  fallbackSenderName,
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatListTime,
  formatChatPreview,
  formatPreview,
  initialFor,
  middleTruncate,
  needsReadingTreatment,
  previewLine,
  senderInk,
  senderLabel,
  tintIndex
} from './format'
export { chatStrings } from './strings'
export { argumentRows, extractToolErrorMessage, formatToolResultSummary } from './tool-result-summary'
export { isCardTool, isFileEditTool, isSilentTool, toolFamily, toolGlyph, type ToolFamily } from './tool-render-class'
export type * from './types'
