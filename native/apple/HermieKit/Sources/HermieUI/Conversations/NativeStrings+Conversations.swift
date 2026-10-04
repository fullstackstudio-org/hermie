import Foundation

/// The Conversations page's and the viewer's own sentences, from `Resources/Native.xcstrings`. What
/// the Expo app says in the same words (the groups, Rename, Delete, Make this the Bot Chat, the
/// delete question, the counts) is read from the shared catalogue through `Strings.Chat.Sessions`.
extension NativeStrings {
  enum Conversations {
    /// The past and branched conversations of this bot. (the row in the bot settings)
    static var hint: String {
      String(localized: "native.conversations.hint", table: "Native", bundle: .module)
    }
    /// New conversation
    static var new: String {
      String(localized: "native.conversations.new", table: "Native", bundle: .module)
    }
    /// The current conversation moves to Past conversations and a new one starts. Everyone on this
    /// gateway shares it.
    static var newConfirmBody: String {
      String(localized: "native.conversations.newConfirmBody", table: "Native", bundle: .module)
    }
    /// Start a new conversation
    static var newConfirm: String {
      String(localized: "native.conversations.newConfirm", table: "Native", bundle: .module)
    }
    /// The conversation has a new name.
    static var renamed: String {
      String(localized: "native.conversations.renamed", table: "Native", bundle: .module)
    }
    /// The conversation was deleted.
    static var deleted: String {
      String(localized: "native.conversations.deleted", table: "Native", bundle: .module)
    }
    /// That conversation is the Bot Chat now.
    static var adopted: String {
      String(localized: "native.conversations.adopted", table: "Native", bundle: .module)
    }
    /// That did not work: {message}
    static func actionFailed(message: String) -> String {
      String(
        localized: "native.conversations.actionFailed", defaultValue: "That did not work: \(message)",
        table: "Native", bundle: .module)
    }
    /// You are reading an earlier conversation. It cannot be answered.
    static var readOnly: String {
      String(localized: "native.conversations.readOnly", table: "Native", bundle: .module)
    }
    /// Back to the chat
    static var backToChat: String {
      String(localized: "native.conversations.backToChat", table: "Native", bundle: .module)
    }
    /// Actions for {title}
    static func actionsFor(title: String) -> String {
      String(
        localized: "native.conversations.actionsFor", defaultValue: "Actions for \(title)", table: "Native",
        bundle: .module)
    }
    /// This conversation has no messages.
    static var noMessages: String {
      String(localized: "native.conversations.noMessages", table: "Native", bundle: .module)
    }
  }
}
