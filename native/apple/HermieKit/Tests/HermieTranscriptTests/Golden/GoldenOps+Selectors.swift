import HermieProtocol
import HermieTranscript

// Task 13 (selectors and derived views) fills this table: `visibleItems`,
// `isBusy`, `runningSubagents`, `subagentTree`, `openRequests`, `itemsVersion`,
// `unreadCountSince`, `lastMessageAt`, `unreadBadgeLabel`, `latestStatus`,
// `previewFromChat`, `previewFromGatewayText`, `chatRowPreview`,
// `activityEntries`, `findDmCounterpart`, `exportTranscript`,
// `transcriptFileName`, `transcriptDiagnostics`, `formatTranscriptDiagnostics`.
// Until an entry is here its calls are counted as pending. `visibleItems` also
// turns on the checkpoint comparisons of the stream scenarios. See
// `GoldenOps+Reducer.swift` for the shape of an entry; `activityEntries` should
// read `args.now` should a recorded call ever carry one.

extension GoldenOps {
  static let selectors: [String: GoldenOperation] = [:]
}
