import HermieCore
import SwiftUI

/**
 The pieces the capability pages (Memory, Skills, MCP servers, Connectors, Boards) share, so each
 draws the same states in the same words and the same places: the live gateway or the one line that
 there is none, a line of status, a notice that can be dismissed, and the bot to read about.

 Every text the gateway sent is drawn with `Text(verbatim:)`: plain text, never Markdown. Footnote
 text is drawn in the primary colour, as the other Settings pages do, because the grey the system
 uses fails the contrast audit at that size.
 */

/// The live gateway's session, or the page that says there is none. A new session (a gateway switch,
/// a sign-in) replaces the content, so a model never outlives the session it reads.
struct CapabilityHost<Content: View>: View {
  let identifier: String
  @ViewBuilder let content: (GatewaySession) -> Content

  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let session = live?.session {
      content(session)
        .id(ObjectIdentifier(session))
    } else {
      Form {
        Section {
          CapabilityStatusRow(text: NativeStrings.Capability.noGateway, symbol: "nosign")
        }
      }
      .formStyle(.grouped)
      .accessibilityIdentifier(identifier)
    }
  }
}

/// One line of status: a symbol and a sentence, read as one.
struct CapabilityStatusRow: View {
  let text: String
  let symbol: String
  var identifier: String?

  var body: some View {
    Label {
      Text(verbatim: text)
        .foregroundStyle(Color.primary)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier ?? "hermie.capability.state")
  }
}

/// The loading state: a spinner and what is being read.
struct CapabilityLoadingRow: View {
  let text: String

  var body: some View {
    HStack(spacing: 12) {
      ProgressView()
      Text(verbatim: text)
        .foregroundStyle(Color.primary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("hermie.capability.loading")
  }
}

/// What a write or a refresh said that the person should see, with the way to dismiss it.
struct CapabilityNoticeSection: View {
  let text: String?
  let dismiss: () -> Void

  var body: some View {
    if let text {
      Section {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Label {
            Text(verbatim: text)
              .foregroundStyle(Color.primary)
              .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "exclamationmark.triangle")
              .foregroundStyle(Color.primary)
              .accessibilityHidden(true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)

          Button(Strings.App.Common.dismiss, systemImage: "xmark", action: dismiss)
            .labelStyle(.iconOnly)
            .buttonStyle(.borderless)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(.rect)
            .accessibilityIdentifier("hermie.capability.notice.dismiss")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hermie.capability.notice")
      }
    }
  }
}

/// A read that failed: what the gateway said, and a way to try again.
struct CapabilityFailureRow: View {
  let text: String
  let retry: () -> Void

  var body: some View {
    CapabilityStatusRow(text: text, symbol: "exclamationmark.triangle", identifier: "hermie.capability.failure")

    Button(Strings.App.Common.retry, action: retry)
      .accessibilityIdentifier("hermie.capability.retry")
  }
}

/// A bot of the live gateway as the pages list it.
struct CapabilityBot: Identifiable, Equatable {
  /// The gateway's profile name: what every call is scoped by.
  let id: String
  /// What this person calls it.
  let name: String
}

extension GatewaySession {
  /// The bots of this gateway in the roster's order, each under the name the person gave it.
  @MainActor var capabilityBots: [CapabilityBot] {
    chatList.names.map { CapabilityBot(id: $0, name: chatName($0)) }
  }
}

/// The bot a page reads about, picked from the gateway's roster. One bot is no choice, so it is
/// drawn as a line and not a picker; none is the one line that there are no bots.
struct CapabilityBotPicker: View {
  let bots: [CapabilityBot]
  @Binding var selection: String?
  var identifier = "hermie.capability.bot"

  var body: some View {
    content
      // A selection that is nil or no longer a bot (the roster arrived after the page did) is the first.
      .onAppear(perform: settle)
      .onChange(of: bots.map(\.id)) { settle() }
  }

  private func settle() {
    if let first = bots.first, selection == nil || !bots.contains(where: { $0.id == selection }) {
      selection = first.id
    }
  }

  @ViewBuilder private var content: some View {
    if bots.count > 1 {
      Picker(NativeStrings.Capability.bot, selection: $selection) {
        ForEach(bots) { bot in
          Text(verbatim: bot.name).tag(Optional(bot.id))
        }
      }
      .accessibilityIdentifier(identifier)
    } else if let bot = bots.first {
      LabeledContent(NativeStrings.Capability.bot) {
        Text(verbatim: bot.name)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(identifier)
    }
  }
}
