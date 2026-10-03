import SwiftUI

extension EnvironmentValues {
  /// Debug builds launched by a UI test only: the chat screen shows `ChatTestProbe`.
  @Entry public var chatTestProbe = false
}

#if DEBUG
  /// What the chat screen's UI test reads and drives, in debug builds launched with
  /// `-HermieUITest YES` only (`chatTestProbe`): the chat's state as a value; the rows' render
  /// counts and appearances (`RenderCounter`), with what each row draws, as another, refreshed four
  /// times a second.
  ///
  /// Tiny, invisible and outside the list, so reading it re-renders no row. It exists only in a
  /// debug build (this whole type is `#if DEBUG`).
  struct ChatTestProbe: View {
    let feed: ChatFeed

    @Environment(\.chatTestProbe) private var enabled
    @State private var counts = ""

    var body: some View {
      if enabled {
        VStack(alignment: .leading, spacing: 0) {
          Text("state")
            .accessibilityIdentifier("hermie.chat.probe.state")
            .accessibilityValue(
              "rows=\(feed.rows.count) hydration=\(feed.hydration.rawValue) "
                + "activity=\(feed.activity == .idle && !feed.model.turnActive ? "idle" : "busy") ready=\(feed.model.canSend ? 1 : 0) "
                + "error=\((feed.model.lastError ?? "-").replacingOccurrences(of: " ", with: "_"))"
            )

          Text("renders")
            .accessibilityIdentifier("hermie.chat.probe.renders")
            .accessibilityValue(counts)

        }
        .font(.system(size: 6))
        // Read through the accessibility tree, never seen: clear text is still in the tree (a view
        // at alpha 0 may be left out of it) and draws nothing over any background.
        .foregroundStyle(.clear)
        .allowsHitTesting(false)
        .task {
          while !Task.isCancelled {
            let rendered = RenderCounter.counts
            let appeared = RenderCounter.appearances
            counts = feed.rows
              .map { row in
                let stamp = "\(row.stamp.version)/\(row.stamp.presentation.rawValue)/\(row.stamp.thought)/"
                  + "\(row.stamp.members.map(String.init).joined(separator: ","))/\(row.opensAuthorRun)"
                return "\(row.id)=\(rendered[row.id] ?? 0)|\(appeared[row.id] ?? 0)|\(stamp)"
              }
              .joined(separator: ";")
            try? await Task.sleep(for: .milliseconds(250))
          }
        }
      }
    }
  }
#endif
