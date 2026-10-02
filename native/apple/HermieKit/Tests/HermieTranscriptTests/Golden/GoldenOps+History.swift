import HermieProtocol
import HermieTranscript

// Task 12 (history, reconcile, cache) fills this table: `rowsToItems`,
// `reconcile`, `reconcileTail`, `snapshotForCache`, `stateFromCache`,
// `classifyUserRow`, `stripUserText`, `attachmentRefName`, `attachmentsMatchKey`,
// `normalizedItemText`. Until an entry is here its calls are counted as pending,
// and the stream scenarios that call `reconcile` are skipped. See
// `GoldenOps+Reducer.swift` for the shape of an entry.

extension GoldenOps {
  static let history: [String: GoldenOperation] = [:]
}
