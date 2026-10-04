import HermieCore
import SwiftUI

extension NativeStrings {
  enum OwnChats {
    /// Start chat (the button of the new chat sheet)
    static var start: String { String(localized: "native.ownChats.start", table: "Native", bundle: .module) }
    /// Optional. Without a name the chat is called after the time it was started.
    static var nameHint: String { String(localized: "native.ownChats.nameHint", table: "Native", bundle: .module) }
  }
}

extension NativeStrings.Conversations {
  /// You are in that chat now.
  static var usingHere: String {
    String(localized: "native.conversations.usingHere", table: "Native", bundle: .module)
  }
  /// Continue in this chat (the row action for one of the reader's own chats)
  static var useHere: String {
    String(localized: "native.conversations.useHere", table: "Native", bundle: .module)
  }
}

/// What the own chat controls say about a refusal.
enum OwnChatText {
  /// The words of a refusal: the reply-in-flight one has its own sentence, everything else carries the
  /// gateway's reason (plain text, bounded).
  static func failure(_ error: any Error) -> String {
    if error is ConversationBusyError {
      return Strings.Chat.Sessions.busy
    }

    return SecurePrompt.displayText(ChatResolver.describe(error), limit: SecurePrompt.textLimit)
      .replacingOccurrences(of: "\n", with: " ")
  }
}

extension ChatFeed {
  /// The switch between the shared Bot Chat and the reader's own: the chat reopens on the other. A
  /// refusal (a reply streaming, a gateway that would not) is said over the chat, and nothing moved.
  func chooseChat(mine: Bool) {
    let session = self.session
    let bot = name

    Task {
      do {
        try await session.chooseChat(bot, mine: mine)
        optionNotice = nil
      } catch {
        optionNotice = .failed(OwnChatText.failure(error))
      }
    }
  }
}

/// The chat's options menu items for the two kinds of chat a bot has: the switch ("This conversation:
/// Shared Bot Chat or My chat"), and a new chat of the reader's own. Drawn only where the gateway has
/// said who the reader is: with no name to write a title from there is no private chat, and a control
/// that could never work is not offered.
struct OwnChatMenuItems: View {
  let feed: ChatFeed

  @Environment(AppRouter.self) private var router: AppRouter?

  var body: some View {
    let session = feed.session

    if session.ownChatsAvailable {
      Picker(
        Strings.Chat.Sessions.whose,
        selection: Binding(
          get: { session.chatTarget(feed.name) != .shared },
          set: { feed.chooseChat(mine: $0) }
        )
      ) {
        Text(Strings.Chat.Sessions.shared).tag(false)
        Text(Strings.Chat.Sessions.mine).tag(true)
      }
      .accessibilityIdentifier("hermie.chat.whose")

      if let router {
        Button {
          router.present(.newOwnChat(feed.chat))
        } label: {
          Label(Strings.Chat.Conversations.newChat, systemImage: "square.and.pencil")
        }
        .accessibilityIdentifier("hermie.chat.newOwnChat")
      }

      Divider()
    }
  }
}

/// Keeps the chat on screen the one the reader's memory names: another device chose, or the identity
/// arrived after the chat opened. A refusal (a reply streaming) leaves the chat where it is.
struct OwnChatFollow: ViewModifier {
  let session: GatewaySession
  let bot: String

  func body(content: Content) -> some View {
    content
      .onChange(of: session.chatTarget(bot)) { _, _ in
        Task { await session.followChoice(bot) }
      }
  }
}

/// The sheet that starts another chat of the reader's own: an optional name, and Start. The chat opens
/// as soon as the gateway has made it.
struct NewOwnChatSheet: View {
  let chat: ChatRef

  @Environment(LiveGateway.self) private var live: LiveGateway?
  @Environment(AppRouter.self) private var router: AppRouter?
  @Environment(\.dismiss) private var dismiss

  @State private var label = ""
  @State private var starting = false
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField(
            Strings.Chat.Conversations.renameLabel, text: $label, prompt: Text(Strings.Chat.Conversations.firstChat)
          )
          .onSubmit { start() }
          .accessibilityIdentifier("hermie.ownChat.name")
        } footer: {
          VStack(alignment: .leading, spacing: 4) {
            Text(NativeStrings.OwnChats.nameHint)
            Text(Strings.Chat.Sessions.mineNote)
          }
        }

        if let failure {
          Section {
            Label {
              Text(verbatim: "\(Strings.Chat.Conversations.newChatFailed) \(failure)")
            } icon: {
              Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            }
            .font(.callout)
            .accessibilityIdentifier("hermie.ownChat.error")
          }
        }
      }
      .formStyle(.grouped)
      .disabled(starting)
      .navigationTitle(Strings.Chat.Conversations.newChat)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.Chat.Sessions.cancel) { dismiss() }
            .disabled(starting)
        }

        ToolbarItem(placement: .confirmationAction) {
          if starting {
            ProgressView().controlSize(.small)
          } else {
            Button(NativeStrings.OwnChats.start) { start() }
              .accessibilityIdentifier("hermie.ownChat.start")
          }
        }
      }
      .interactiveDismissDisabled(starting)
    }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 280)
    #endif
    .accessibilityIdentifier("hermie.ownChat")
  }

  private func start() {
    guard !starting, let live, live.gatewayID == chat.gatewayId, let session = live.session else {
      return
    }

    starting = true
    failure = nil

    Task {
      do {
        try await session.startOwnChat(chat.bot, label: label)
        router?.openChat(chat)
        router?.showChat()
        dismiss()
      } catch {
        failure = OwnChatText.failure(error)
        starting = false
      }
    }
  }
}
