import HermieCore
import SwiftUI

/// What the chat list's messages section has to say about the search the field asked for.
enum MessageSearchStatus: Equatable {
  /// Nothing is being searched: no connection, or no bots to ask.
  case idle
  /// The words are going out, or have been asked for and not answered.
  case searching
  /// Chats whose messages hold the words.
  case hits
  case none
  /// Every bot's search failed: not the same fact as "no message matches".
  case failed

  /// - Parameters:
  ///   - answered: the model's answer is for the words in the field and no search is out.
  ///   - searchable: the connection is up and there is a bot to ask.
  static func of(searchable: Bool, answered: Bool, matches: Int, failed: Bool) -> MessageSearchStatus {
    guard searchable else {
      return .idle
    }

    guard answered else {
      return .searching
    }

    if failed {
      return .failed
    }

    return matches > 0 ? .hits : .none
  }

  /// The line under the section's rows. The hint under the hits says only the best match per chat is
  /// shown: the gateway answers one hit per conversation and a count would promise more.
  var text: String {
    switch self {
    case .idle: ""
    case .searching: Strings.App.Bots.messagesSearching
    case .hits: Strings.App.Bots.messagesHint
    case .none: Strings.App.Bots.messagesNone
    case .failed: NativeStrings.Search.failed
    }
  }
}

/// What the field and the roster ask the messages search to do right now, and the key that says when that
/// changed: a `.task(id:)` over it runs the search again, and replacing a task is how a query is
/// superseded.
@MainActor
struct MessageSearchRequest {
  /// The words, trimmed as the model trims them.
  let query: String
  let bots: [Bot]
  let ready: Bool

  init(session: GatewaySession, query: String, ready: Bool) {
    self.query = MessageSearchModel.normalized(query)
    self.ready = ready
    // The roster is only read while there is something to ask it for.
    self.bots = self.query.isEmpty ? [] : session.searchableBots
  }

  struct Key: Hashable {
    var query: String
    var ready: Bool
    /// What identifies a bot's Bot Chat for the search: when it changes, the answer may.
    var bots: [String]
  }

  var key: Key {
    Key(
      query: query, ready: ready,
      bots: bots.map { "\($0.name)|\($0.canonical?.id ?? "")|\($0.canonical?.resolvedID ?? "")" })
  }

  var searchable: Bool {
    ready && !query.isEmpty && !bots.isEmpty
  }

  func status(of model: MessageSearchModel) -> MessageSearchStatus {
    .of(
      searchable: searchable,
      answered: model.query == query && !model.searching,
      matches: model.matches.count,
      failed: model.failed)
  }
}

/// The snippet of a hit as an attributed string: runs of the gateway's text, the matched ones in bold on
/// a wash of the tint. Built run by run from plain strings, so nothing in it is parsed: no Markdown, no
/// links, whatever the message said.
enum MessageSnippetText {
  static func attributed(_ snippet: String) -> AttributedString {
    var text = AttributedString()

    for run in MessageSnippet.runs(snippet) {
      var part = AttributedString(run.text)

      if run.match {
        part.inlinePresentationIntent = .stronglyEmphasized
        part.backgroundColor = Color.accentColor.opacity(0.25)
      }

      text.append(part)
    }

    return text
  }
}

/// One message hit in the chat list: the bot, when its chat last moved, and the gateway's snippet with
/// what matched marked. Tapping it opens the chat at that message.
struct MessageHitRow: View {
  let match: MessageMatch
  let row: ChatListRow
  let name: String
  let gatewayReady: Bool
  var accent: BotAccent = .default
  let open: () -> Void

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let presence = row.presence(gatewayReady: gatewayReady)
    let large = typeSize.isAccessibilitySize
    let time = ChatListFormat.listTime(match.at ?? 0)
    let plain = SessionSearch.plainSnippet(match.snippet)

    Button(action: open) {
      HStack(alignment: large ? .top : .center, spacing: 12) {
        BotAvatar(name: name, avatar: row.avatar, presence: presence.state, accent: accent)

        VStack(alignment: .leading, spacing: 2) {
          if large {
            title
            if !time.isEmpty { stamp(time) }
          } else {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              title
                .frame(maxWidth: .infinity, alignment: .leading)
              if !time.isEmpty { stamp(time) }
            }
          }

          Text(MessageSnippetText.attributed(match.snippet))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(large ? 8 : 3)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.vertical, 4)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityValue([plain, time].filter { !$0.isEmpty }.joined(separator: ", "))
    .accessibilityHint(Strings.App.Bots.messageOpen(bot: name))
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("hermie.chatList.hit.\(match.bot)")
  }

  private var title: some View {
    Text(verbatim: name)
      .font(.headline)
      .lineLimit(1)
      .truncationMode(.tail)
      .layoutPriority(1)
  }

  private func stamp(_ text: String) -> some View {
    Text(verbatim: text)
      .font(.caption)
      .monospacedDigit()
      .foregroundStyle(.secondary)
      .fixedSize()
  }
}

/// The line that says what the messages section is doing: searching, nothing found, the search could
/// not run, or that only the best match per chat is shown.
struct MessageSearchStatusRow: View {
  let status: MessageSearchStatus

  var body: some View {
    HStack(spacing: 8) {
      if status == .searching {
        ProgressView()
          .controlSize(.small)
      }

      Text(verbatim: status.text)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.chatList.messages.status")
  }
}
