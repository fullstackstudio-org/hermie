import Foundation
import HermieMarkdown
import HermieTranscript

/**
 What a message's menu offers, as data: the decisions without the drawing
 (`chat-ui/message-menu.ts` in the Expo app, `features/chat/message-menu.ts` on the web).

 Rules that came with it:

 - **Copy text and Copy as Markdown differ, and both are offered** on a reply when they differ: a
   reply IS Markdown, and copying it into a terminal wants the words while copying it into a document
   wants the syntax. When the two would be the same string only Copy text is shown. The reader's own
   turn is what they typed, so it has the one Copy, as typed.
 - **Regenerate only on the newest reply** (`MessageMenuContext.regenerateTarget`), the rule of
   Retry on a failed reply (`ChatModel.retryTurn`): an older reply would answer a question the chat
   has moved on from.
 - **Edit and resend** puts the reader's own words back in the composer; it replaces nothing, the turn
   in the chat stays where it is, and what is sent is a new one.
 - **Branch from here** forks the conversation at this message into a conversation of its own.
 - **Turn-starting lines are drawn disabled, not removed, while a turn runs**: "not now" and "not here"
   are different answers. While an interactive request has the composer (an approval, a secure
   prompt, a form) nothing that sends or types is offered at all (HERM-251): the line is disabled
   too, and Copy, which touches nothing, stays.
 - **The words are read off the item when a line is chosen**, not when the menu was built: a reply can
   still be growing while its menu is open.
 */
public struct MessageMenu: Sendable, Equatable {
  /// What a line does.
  public enum Action: Sendable, Equatable, Hashable {
    /// The words without markup (a reply), or exactly as typed (the reader's own turn).
    case copyText
    /// The Markdown source of a reply.
    case copyMarkdown
    /// Put the reader's own words back in the composer.
    case editResend
    /// Ask for the newest reply again.
    case regenerate
    /// Fork the conversation here.
    case branch
  }

  /// One line: what it does, and whether it can be chosen now.
  public struct Entry: Sendable, Equatable, Hashable {
    public var action: Action
    /// Shown, but not now (a turn runs, or a request has the composer).
    public var enabled: Bool

    public init(_ action: Action, enabled: Bool = true) {
      self.action = action
      self.enabled = enabled
    }
  }

  /// The lines in the order they are drawn, links excluded.
  public var entries: [Entry]
  /// The links the message holds, for the "Copy link" line or its submenu: first to last, no
  /// duplicates, at most `MarkdownPlainText.maxLinks`.
  public var links: [String]

  public var isEmpty: Bool { entries.isEmpty && links.isEmpty }

  public init(entries: [Entry] = [], links: [String] = []) {
    self.entries = entries
    self.links = links
  }

  /// No menu: what a row that is neither a person's turn nor the bot's words has.
  public static let none = MessageMenu()

  public func entry(_ action: Action) -> Entry? {
    entries.first { $0.action == action }
  }

  // MARK: What the menu offers

  /// The lines for `item`, given what the chat says now.
  public static func menu(for item: TranscriptItem, context: MessageMenuContext) -> MessageMenu {
    switch item {
    case .assistant(let reply):
      return replyMenu(reply, context)
    case .user(let turn):
      return turnMenu(turn, context)
    default:
      return .none
    }
  }

  private static func replyMenu(_ reply: AssistantItem, _ context: MessageMenuContext) -> MessageMenu {
    let words = !reply.text.isBlank
    var entries: [Entry] = []

    if words {
      entries.append(Entry(.copyText))

      if MarkdownPlainText.differs(reply.text) {
        entries.append(Entry(.copyMarkdown))
      }
    }

    if context.regenerateTarget == reply.id {
      entries.append(Entry(.regenerate, enabled: !context.turnActive && !context.blocked))
    }

    if context.canBranch {
      entries.append(Entry(.branch, enabled: !context.blocked))
    }

    return MessageMenu(entries: entries, links: words ? MarkdownPlainText.links(in: reply.text) : [])
  }

  private static func turnMenu(_ turn: UserItem, _ context: MessageMenuContext) -> MessageMenu {
    let words = !turn.text.isBlank
    var entries: [Entry] = []

    if words {
      entries.append(Entry(.copyText))
    }

    // Only the reader's own words go back out as theirs: a colleague's turn in a shared chat does not.
    if words, context.canEdit, context.authors.mayRepeat(turn.author?.id) {
      entries.append(Entry(.editResend, enabled: !context.turnActive && !context.blocked))
    }

    if context.canBranch {
      entries.append(Entry(.branch, enabled: !context.blocked))
    }

    return MessageMenu(entries: entries, links: words ? MarkdownPlainText.links(in: turn.text) : [])
  }

  // MARK: What a line copies or puts back, read off the item as it is now

  /// The words `Copy text` puts on the pasteboard, or nil where there are none.
  public static func copyText(of item: TranscriptItem) -> String? {
    switch item {
    case .assistant(let reply):
      reply.text.isBlank ? nil : MarkdownPlainText.block(reply.text)
    case .user(let turn):
      turn.text.isBlank ? nil : turn.text
    default:
      nil
    }
  }

  /// The Markdown source `Copy as Markdown` puts on the pasteboard, or nil where there is none.
  public static func copyMarkdown(of item: TranscriptItem) -> String? {
    guard case .assistant(let reply) = item, !reply.text.isBlank else {
      return nil
    }

    return reply.text
  }

  /**
   What the composer holds after `Edit and resend` on `item`: the turn's words, and the files it
   carried by their `@file:` reference, which is what the gateway understands. A picture does not come
   back: its bytes are no longer on this device and its reference means nothing without them.
   Nil for anything but the reader's own turn with words.
   */
  public static func editResendDraft(of item: TranscriptItem) -> String? {
    guard case .user(let turn) = item, !turn.text.isBlank else {
      return nil
    }

    let files = (turn.attachments ?? []).filter { $0.hasPrefix("@file:") }

    return files.isEmpty ? turn.text : "\(turn.text)\n\(files.joined(separator: " "))"
  }

  /// The words a branch taken at `item` is named after (`BranchPoint.title`), or nil for a row that
  /// has none of its own.
  public static func words(of item: TranscriptItem) -> String? {
    switch item {
    case .assistant(let reply): reply.text
    case .user(let turn): turn.text
    default: nil
    }
  }
}

/// What the chat says about itself when a message's menu opens: read then, not when the row was built,
/// because rows are not redrawn when the newest reply moves on.
public struct MessageMenuContext: Sendable, Equatable {
  /// The one reply that may be asked for again, if there is one (`ChatModel.regenerateTarget`).
  public var regenerateTarget: String?
  /// Whose turns may go out again under the reader's name.
  public var authors: RetryAuthors
  /// A turn runs: Regenerate and Edit and resend wait.
  public var turnActive: Bool
  /// An interactive request has the composer: nothing that sends, types or forks is offered
  /// (HERM-251).
  public var blocked: Bool
  /// This screen can put words back in the composer.
  public var canEdit: Bool
  /// This screen can fork the conversation.
  public var canBranch: Bool

  public init(
    regenerateTarget: String? = nil,
    authors: RetryAuthors = .untrusted,
    turnActive: Bool = false,
    blocked: Bool = false,
    canEdit: Bool = false,
    canBranch: Bool = false
  ) {
    self.regenerateTarget = regenerateTarget
    self.authors = authors
    self.turnActive = turnActive
    self.blocked = blocked
    self.canEdit = canEdit
    self.canBranch = canBranch
  }

  /// A transcript that only reads (a gallery, a viewer of another conversation): copying is all
  /// there is.
  public static let readOnly = MessageMenuContext()
}

extension String {
  /// Nothing but whitespace.
  fileprivate var isBlank: Bool {
    trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
