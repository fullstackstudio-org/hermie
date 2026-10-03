import HermieTranscript

/// Turns a chat's visible items into list rows, off the main actor.
///
/// One per open chat screen. It keeps the `TranscriptRowBuilder` (and with it each row's parsed
/// Markdown, updated incrementally) between snapshots, so a streamed delta re-parses the tail of
/// one reply and nothing else. The main actor hands it the snapshot's items (a copy of an array
/// is a retain) and receives the finished rows behind one reference.
actor ChatRowPipeline {
  struct Output: Sendable {
    var rows: TranscriptListItems<TranscriptRow>
    /// User and assistant rows that were not in the previous output: what the jump pill counts
    /// while the reader is scrolled up.
    var arrived: Int
  }

  private var builder = TranscriptRowBuilder()
  private var known: Set<String> = []
  private var first = true

  /// - Parameter typing: the bot's typing row goes last. It is the list's row and not the
  ///   transcript's: it counts as no arrival, and it is not among the rows a later arrival is
  ///   measured from.
  func rows(for items: [VisibleItem], historyComplete: Bool = true, typing: Bool = false) -> Output {
    let rows = builder.rows(for: items, historyComplete: historyComplete)
    var arrived = 0

    // Only rows after the newest one already shown are arrivals: history prepended above is not.
    if !first, let last = rows.lastIndex(where: { known.contains($0.id) }) {
      for row in rows[(last + 1)...] {
        switch row.visibleItem?.item {
        case .user?, .assistant?: arrived += 1
        default: break
        }
      }
    }

    known = Set(rows.map(\.id))
    first = false

    guard typing else {
      return Output(rows: TranscriptListItems(rows), arrived: arrived)
    }

    return Output(rows: TranscriptListItems(rows + [TranscriptRowBuilder.typingIndicatorRow()]), arrived: arrived)
  }
}
