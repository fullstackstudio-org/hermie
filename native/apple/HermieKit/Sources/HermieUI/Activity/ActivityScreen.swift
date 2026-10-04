import HermieCore
import HermieTranscript
import SwiftUI

/**
 The Activity section, in the sidebar (`ActivityScreen.tsx` in the Expo app): one timeline of everything
 the bots said to each other, and the reason the app exists at all. Bot-to-bot traffic is invisible in
 any per-chat view, because it is by definition spread across two chats; here the rows read as sentences
 (`researcher → writer: draft the announcement`), grouped by day, newest first, and each one is a door
 into the chat where it happened.

 A tap opens that chat and asks it to show the row (`AppRouter.openChat(_:finding:)`), the same way a
 message search hit does.

 Everything on it is derived from the chats (`ActivityModel`); the three counters at the top are the
 only thing that is not, so they are read while the screen is on top (every ten seconds) and forgotten
 when it is not. The timeline is derived again on that beat too, which is what lets a live chat's new
 traffic show up without a gateway read.

 It reads the session from `LiveGateway` in the environment.
 */
struct ActivityScreen: View {
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    Group {
      if let live, let router, live.gatewayID == router.selectedGatewayId, live.phase == .live,
        let session = live.session
      {
        ActivityList(session: session)
          .id(ObjectIdentifier(session))
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text(Strings.App.Activity.loading)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
      }
    }
    .accessibilityIdentifier("hermie.activity")
  }
}

/// The timeline over a running session.
struct ActivityList: View {
  let session: GatewaySession

  @State private var model: ActivityModel
  @Environment(AppRouter.self) private var router: AppRouter?

  init(session: GatewaySession) {
    self.session = session
    _model = State(initialValue: session.activity())
  }

  var body: some View {
    let connected = session.status.phase == .ready

    content(connected: connected)
      .safeAreaInset(edge: .top, spacing: 0) {
        ConnectionBanner(
          status: session.status,
          retry: { Task { await session.retryNow() } },
          signIn: {}
        )
      }
      // Read once the socket is up. A screen that read before that got a roster that failed with "not
      // connected" and settled on "your bots have not talked to each other yet", for good.
      .task(id: connected) {
        if connected {
          await model.refresh()
        } else if model.phase == .loading {
          await model.reload()
        }
      }
      // The beat: the counters, and the timeline derived again from the chats the store holds.
      .task(id: connected) {
        guard connected else {
          return
        }

        while !Task.isCancelled {
          try? await Task.sleep(for: ActivityModel.counterInterval)

          if !Task.isCancelled {
            await model.refreshCounters()
            await model.reload()
          }
        }
      }
      .onChange(of: session.sessionsChangedCount) {
        if connected {
          Task { await model.reload() }
        }
      }
      .refreshable { await model.refresh() }
  }

  @ViewBuilder private func content(connected: Bool) -> some View {
    List {
      Section {
        header
      }
      .listRowSeparator(.hidden)

      ForEach(model.days) { day in
        Section {
          ForEach(day.entries, id: \.id) { entry in
            ActivityRow(entry: entry, label: { model.displayName(forHandle: $0) }) {
              open(entry)
            }
          }
        } header: {
          Text(verbatim: ActivityText.dayTitle(day.start))
        }
      }
    }
    .overlay {
      if model.days.isEmpty {
        placeholder(connected: connected)
      }
    }
    .accessibilityIdentifier("hermie.activity.list")
  }

  /// Three chips, not three big numerals: a page whose point is the timeline does not lead with a
  /// dashboard.
  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(Strings.App.Activity.subtitle)
        .font(.subheadline)
        .foregroundStyle(.secondary)

      HStack(spacing: 8) {
        counter(model.counters.botsWorking, Strings.App.Activity.Counters.working, id: "working")
        counter(model.counters.activeSubagents, Strings.App.Activity.Counters.subagents, id: "subagents")
        counter(model.counters.inFlightDeliveries, Strings.App.Activity.Counters.deliveries, id: "deliveries")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func counter(_ value: Int, _ label: String, id: String) -> some View {
    HStack(spacing: 5) {
      Text(verbatim: String(value))
        .fontWeight(.bold)
        .foregroundStyle(value > 0 ? Color.accentColor : Color.secondary)
        .monospacedDigit()

      Text(verbatim: label)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
    .font(.footnote)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(.quaternary, in: .capsule)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.activity.count.\(id)")
  }

  /// Loading, why there is nothing, or that nothing has happened yet: over the (empty) list.
  @ViewBuilder private func placeholder(connected: Bool) -> some View {
    if model.phase == .loading, connected {
      VStack(spacing: 12) {
        ProgressView()
        Text(Strings.App.Activity.loading)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    } else {
      Text(connected ? Strings.App.Activity.empty : Strings.App.Activity.emptyOffline)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .padding(32)
        .frame(maxWidth: 420)
        .accessibilityIdentifier("hermie.activity.empty")
    }
  }

  /// Open the chat the row came from, at the words of the row.
  private func open(_ entry: ActivityEntry) {
    guard let router, model.knows(bot: entry.botName) else {
      return
    }

    router.openChat(
      ChatRef(gatewayId: session.gatewayID, bot: entry.botName), finding: ActivityRow.findWords(entry.text))
  }
}

/**
 One line of traffic, in the transcript's ledger language: a small glyph well on the left, the sentence
 (`researcher → writer`) in semibold, a clock at the right edge, and the body indented under it so the
 column of glyphs stays a column. A delegation has no recipient, so it reads `researcher spawned 3
 agents`.

 The lines are fixed (the sentence on one line, the body on at most two) so a refresh that changes the
 words never changes the row's shape.
 */
struct ActivityRow: View {
  let entry: ActivityEntry
  let label: (String) -> String
  let open: () -> Void

  /// The longest run of the row's text asked of the chat's find: the rest is the same message.
  static let findLimit = 48

  /// The words a tap asks the chat to find: the opening of the row's text, which is the opening of the
  /// message (a row's text is the message's first line with its whitespace collapsed).
  static func findWords(_ text: String) -> String {
    String(text.prefix(findLimit)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    let heading = ActivityText.heading(entry, label: label)
    let status = ActivityText.status(entry)

    Button(action: open) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(entry.kind == .delegation ? "⑃" : "→")
            .font(.caption2)
            .foregroundStyle(entry.failed == true ? Color.red : Color.secondary)
            .frame(width: 20, height: 20)
            .background(.quaternary, in: .rect(cornerRadius: 6))
            .accessibilityHidden(true)

          Text(verbatim: heading)
            .font(.footnote.weight(.semibold))
            .lineLimit(1)

          Spacer(minLength: 8)

          if entry.at > 0 {
            Text(verbatim: ActivityText.clock(entry.at))
              .font(.footnote)
              .foregroundStyle(.tertiary)
              .monospacedDigit()
          }
        }

        // Indented past the glyph well, so the column of glyphs stays a column.
        if !entry.text.isEmpty {
          Text(verbatim: entry.text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .padding(.leading, 28)
        }

        if let status {
          Text(verbatim: status.uppercased())
            .font(.caption2)
            .foregroundStyle(entry.failed == true ? Color.red : entry.pending == true ? Color.accentColor : Color.secondary)
            .padding(.leading, 28)
            .accessibilityIdentifier("hermie.activity.status.\(entry.id)")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityHint(Strings.App.Activity.openChat(bot: label(entry.botName)))
    .accessibilityIdentifier("hermie.activity.row.\(entry.id)")
  }
}
