import HermieCore
import SwiftUI

/**
 Search Everywhere: one field over every conversation of every bot on every gateway this device is
 signed in to, opened with ⇧⌘F on the Mac and iPad, from the "search every conversation" row under the
 chat list's own search, and from the Chat menu.

 It is the second search the app has. The chat list's field narrows the list by name and shows the best
 hit per bot (`MessageSearchModel`); this shows every conversation that holds the words, whichever of a
 bot's chats it is in, with the bot, the chat's title, the words around the match and the date, and a tap
 opens that conversation at the message (`AppRouter.openSearchResult`): the bot's own chat scrolls to the
 row, any other conversation opens in the read-only viewer, and a result on another gateway makes that
 gateway the live one first.

 The results are the gateway's index and this device's own copy of the chats, merged
 (`EverywhereSearchModel`); a result only the copy holds says so, and a gateway that could not be asked
 is named under the list, so an empty list is never a lie. Everything shown came from a gateway or a
 bot, and is drawn as characters, never as Markdown.
 */
struct SearchEverywhereSheet: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router
  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(GatewayAccounts.self) private var accounts: GatewayAccounts?
  @Environment(\.dismiss) private var dismiss

  @State private var query = ""
  @State private var model: EverywhereSearchModel?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        field

        if let model {
          SearchEverywhereResults(model: model, query: query, open: { open($0, model: model) })
        } else {
          Spacer()
        }
      }
      .navigationTitle(NativeStrings.Search.title)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(Strings.App.Common.done) { dismiss() }
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("hermie.search.done")
        }
      }
    }
    .task {
      if model == nil {
        model = makeModel()
      }

      if query.isEmpty {
        query = router.searchSeed
        router.searchSeed = ""
      }

      focused = true
    }
    // Searched once the field has been still, and again when what is searched changes; a task that
    // is replaced is a query that is superseded.
    .task(id: SearchKey(query: query, ready: model != nil)) {
      await model?.run(query: query)
    }
    .onDisappear { model?.clear() }
    #if os(macOS)
      .frame(minWidth: 460, idealWidth: 560, minHeight: 420, idealHeight: 560)
    #endif
    .accessibilityIdentifier("hermie.search")
  }

  private struct SearchKey: Hashable {
    var query: String
    var ready: Bool
  }

  private var field: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)

      TextField(NativeStrings.Search.prompt, text: $query)
        .textFieldStyle(.plain)
        .focused($focused)
        .autocorrectionDisabled()
        #if os(iOS)
          .textInputAutocapitalization(.never)
          .submitLabel(.search)
        #endif
        .accessibilityIdentifier("hermie.search.field")

      if !query.isEmpty {
        Button {
          query = ""
          focused = true
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Strings.Memory.Search.clear)
        .accessibilityIdentifier("hermie.search.clear")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }

  /// The gateways to search, as `SearchSources` reads them; with no accounts (a window with no launch
  /// wiring) only the live session.
  private func makeModel() -> EverywhereSearchModel {
    let launch = self.launch
    let live = self.live
    let accounts = self.accounts

    return EverywhereSearchModel(gateways: {
      if let live, let accounts {
        return await SearchSources(launch: launch, accounts: accounts, live: live).gateways()
      }

      guard let session = live?.session,
        let entry = launch.gateways.entry(id: session.gatewayID)
      else {
        return []
      }

      return [session.searchGateway(key: entry.key, name: entry.displayLabel)]
    })
  }

  /// Follow a result: the router opens the conversation at the words, and the live gateway changes
  /// first when the result is on another one.
  private func open(_ result: SearchResult, model: EverywhereSearchModel) {
    let effects = router.openSearchResult(result.destination, finding: model.query)

    perform(effects, on: launch)
    dismiss()
  }
}

/// The list under the field: the results, and the line that says what the search is doing or could not do.
struct SearchEverywhereResults: View {
  let model: EverywhereSearchModel
  let query: String
  let open: (SearchResult) -> Void

  var body: some View {
    let words = EverywhereSearchModel.normalized(query)
    let status = SearchStatus.of(
      query: words, answered: model.query == words, searching: model.searching, count: model.results.count,
      failed: model.failed)

    List {
      switch status {
      case .idle:
        Section {
          Text(NativeStrings.Search.hint)
            .font(.callout)
            .foregroundStyle(.secondary)
            .listRowBackground(Color.clear)
            .accessibilityIdentifier("hermie.search.hint")
        }
      default:
        if !model.results.isEmpty {
          Section {
            ForEach(model.results) { result in
              SearchResultRow(result: result, showGateway: showsGateway) { open(result) }
            }
          } header: {
            Text(NativeStrings.Search.resultsHeader)
          }
        }

        Section {
          SearchStatusRow(status: status, query: words, unreachable: model.unreachable)
            .listRowBackground(Color.clear)
        }
      }
    }
    .listStyle(.plain)
    .onChange(of: status) { _, status in
      // Said aloud for what a reader cannot see change: nothing found, or nothing searched.
      if status == .none || status == .failed {
        AccessibilityNotification.Announcement(status.text(query: words)).post()
      }
    }
    .accessibilityIdentifier("hermie.search.results")
  }

  /// The gateway is named on a result only where there is more than one to tell apart.
  private var showsGateway: Bool {
    Set(model.results.map(\.gatewayID)).count > 1 || !model.unreachable.isEmpty
  }
}

/// What the search says about itself under its results.
enum SearchStatus: Equatable {
  /// Nothing typed.
  case idle
  /// The words are going out, or this device has answered and the gateways have not.
  case searching
  /// At least one result, and the search is done.
  case results
  /// Done, and nothing held the words.
  case none
  /// Not one gateway could be asked, and this device's copy had nothing either.
  case failed

  static func of(query: String, answered: Bool, searching: Bool, count: Int, failed: Bool) -> SearchStatus {
    guard !query.isEmpty else {
      return .idle
    }

    guard answered, !searching else {
      return .searching
    }

    if count > 0 {
      return .results
    }

    return failed ? .failed : .none
  }

  func text(query: String) -> String {
    switch self {
    case .idle, .results: ""
    case .searching: NativeStrings.Search.searching
    case .none: NativeStrings.Search.none(query: query)
    case .failed: NativeStrings.Search.failed
    }
  }
}

struct SearchStatusRow: View {
  let status: SearchStatus
  let query: String
  let unreachable: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if status != .idle, status != .results {
        HStack(spacing: 8) {
          if status == .searching {
            ProgressView()
              .controlSize(.small)
          }

          Text(verbatim: status.text(query: query))
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }

      if !unreachable.isEmpty, status != .searching {
        Text(verbatim: NativeStrings.Search.unreachable(names: unreachable.joined(separator: ", ")))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.search.unreachable")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.search.status")
  }
}

/// One result: the bot, the chat it is in, the words around the match with what matched marked, and
/// when. Tapping it opens the conversation at that message.
struct SearchResultRow: View {
  let result: SearchResult
  let showGateway: Bool
  let open: () -> Void

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let large = typeSize.isAccessibilitySize
    let time = Self.time(result.at)
    let plain = SessionSearch.plainSnippet(result.snippet)
    let title = SearchResultText.chatTitle(result)

    Button(action: open) {
      HStack(alignment: .top, spacing: 12) {
        BotAvatar(name: result.botName, avatar: nil, size: 36)

        VStack(alignment: .leading, spacing: 2) {
          if large {
            heading
            Text(verbatim: title).font(.subheadline).foregroundStyle(.secondary)
            if !time.isEmpty { stamp(time) }
          } else {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              heading
                .frame(maxWidth: .infinity, alignment: .leading)
              if !time.isEmpty { stamp(time) }
            }

            Text(verbatim: title)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }

          Text(MessageSnippetText.attributed(result.snippet))
            .font(.subheadline)
            .lineLimit(large ? 8 : 3)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)

          if result.cacheOnly {
            Label(NativeStrings.Search.onDevice, systemImage: "iphone")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
      .padding(.vertical, 4)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      [result.botName, title, showGateway ? result.gatewayName : ""].filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityValue([plain, time].filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityHint(NativeStrings.Search.openAt)
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.search.result.\(result.bot)")
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(verbatim: result.botName)
        .font(.headline)
        .lineLimit(1)
        .truncationMode(.tail)

      if showGateway, !result.gatewayName.isEmpty {
        Text(verbatim: result.gatewayName)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .layoutPriority(1)
  }

  private func stamp(_ text: String) -> some View {
    Text(verbatim: text)
      .font(.caption)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .fixedSize()
  }

  /// The date with its day: a search spans months, so "Mon" and a clock would not say which.
  static func time(_ unixSeconds: Double?, now: Date = .now, calendar: Calendar = .current) -> String {
    guard let unixSeconds, unixSeconds.isFinite, unixSeconds > 0 else {
      return ""
    }

    let date = Date(timeIntervalSince1970: unixSeconds)

    if calendar.isDate(date, inSameDayAs: now) {
      return date.formatted(date: .omitted, time: .shortened)
    }

    if calendar.isDate(date, equalTo: now, toGranularity: .year) {
      return date.formatted(.dateTime.day().month(.abbreviated))
    }

    return date.formatted(.dateTime.day().month(.abbreviated).year())
  }
}

/// The words of a result that are not the gateway's.
enum SearchResultText {
  /// The chat the result is in, as one line: the Bot Chat by name, an own chat by what the reader called
  /// it, a branch or a past conversation by its title (the gateway's text, cleaned for drawing).
  static func chatTitle(_ result: SearchResult) -> String {
    switch result.kind {
    case .botChat:
      return NativeStrings.Search.botChat
    case .ownChat:
      return clean(result.ownLabel, fallback: NativeStrings.Search.ownChat)
    case .branch:
      return clean(result.title, fallback: NativeStrings.Search.branch)
    case .past:
      return clean(result.title, fallback: NativeStrings.Search.past)
    }
  }

  private static func clean(_ title: String, fallback: String) -> String {
    let cleaned = SecurePrompt.displayText(title, limit: Conversation.titleLimit).replacingOccurrences(of: "\n", with: " ")

    return cleaned.isEmpty ? fallback : cleaned
  }
}
