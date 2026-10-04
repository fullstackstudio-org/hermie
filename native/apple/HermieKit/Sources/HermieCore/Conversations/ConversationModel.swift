import Foundation
import HermieProtocol

/// Which group of the Conversations page a session belongs to.
public enum ConversationKind: Sendable, Equatable, Hashable {
  /// The bot's one forever-chat, the hidden session titled exactly `Bot Chat` (ADR-0007).
  case canonical
  /// A fork of another conversation, found by its `Branch` title.
  case branch
  /// Any other session of the profile: one `/new` put away, or one somebody named themselves.
  case past
}

/// What a person may do with one conversation (`Conversation.actions`).
public enum ConversationAction: Sendable, Equatable, Hashable {
  case open
  case rename
  case delete
  /// Make it the Bot Chat.
  case adopt
}

/**
 One of a profile's conversations, as the Conversations page draws it
 (`core/sessions/session-model.ts` in the web client).

 `id` is the STORED id throughout: the durable registry row, which `session.resume` and
 `session.delete` take, and the only id a listing hands out. A runtime id belongs to a live
 session, and this list is mostly of sessions nothing is running.

 Every text here came from the gateway or from the bot: it is plain text, never Markdown, and the
 `display…` forms are cleaned and bounded for drawing.
 */
public struct Conversation: Sendable, Equatable, Hashable, Identifiable {
  public var id: String
  /// The compression-lineage tip, for reading REST transcript rows.
  public var resolvedID: String
  public var title: String
  public var preview: String
  public var messageCount: Int
  /// Unix seconds, or 0 where the gateway did not say.
  public var lastActive: Double
  public var kind: ConversationKind

  /// The longest title drawn, in code points.
  public static let titleLimit = 120
  /// The longest preview drawn, in code points.
  public static let previewLimit = 160

  public init(
    id: String,
    resolvedID: String? = nil,
    title: String,
    preview: String = "",
    messageCount: Int = 0,
    lastActive: Double = 0,
    kind: ConversationKind
  ) {
    self.id = id
    self.resolvedID = resolvedID ?? id
    self.title = title
    self.preview = preview
    self.messageCount = messageCount
    self.lastActive = lastActive
    self.kind = kind
  }

  /// The title as drawn: cleaned, on one line, bounded; the id where there is nothing left.
  public var displayTitle: String {
    let cleaned = SecurePrompt.displayText(title, limit: Self.titleLimit).replacingOccurrences(of: "\n", with: " ")

    return cleaned.isEmpty ? id : cleaned
  }

  /// The first words of the conversation as drawn: cleaned, on one line, bounded; may be empty.
  public var displayPreview: String {
    SecurePrompt.displayText(preview, limit: Self.previewLimit).replacingOccurrences(of: "\n", with: " ")
  }

  /**
   What a person may do with this conversation.

   The guard ADR-0007 needs, in one place: the canonical row answers an EMPTY list, so a surface that
   draws whatever this returns cannot offer Delete on the one chat that may never be deleted, not by
   forgetting a check, because there is no check to forget.
   */
  public var actions: [ConversationAction] {
    switch kind {
    case .canonical: []
    case .branch, .past: [.open, .rename, .delete, .adopt]
    }
  }

  public func allows(_ action: ConversationAction) -> Bool {
    actions.contains(action)
  }
}

/// The groups the Conversations page draws, in the order it draws them.
public struct ConversationGroups: Sendable, Equatable {
  /// Exactly one row, or none where the gateway listed no canonical chat.
  public var canonical: Conversation?
  public var branches: [Conversation]
  public var past: [Conversation]

  public init(canonical: Conversation? = nil, branches: [Conversation] = [], past: [Conversation] = []) {
    self.canonical = canonical
    self.branches = branches
    self.past = past
  }

  /// Every conversation of the three groups.
  public var all: [Conversation] {
    (canonical.map { [$0] } ?? []) + branches + past
  }

  public func conversation(id: String) -> Conversation? {
    all.first { $0.id == id }
  }
}

/// How `session.list` rows become `ConversationGroups` (`classifyConversations`).
///
/// The listing has no parent field and no kind field, so the TITLE is the only signal, and that is
/// a stated trade: a retired conversation is `Bot Chat · <date time>` (what a new conversation
/// writes when it puts one away), a branch is `Branch · <first words>`, and the canonical row is
/// found by its id where the roster knows one and by `title == "Bot Chat"` otherwise (the registry
/// key itself). A conversation somebody RENAMES out of its prefix stops being grouped as a branch
/// and becomes an ordinary past conversation; nothing is lost.
public enum ConversationClassifier {
  /// What a branch's title starts with.
  public static let branchTitlePrefix = "Branch"

  /// `Bot Chat · `: what a conversation put away by `/new` is called.
  public static let retiredTitlePrefix = "\(ChatResolver.canonicalTitle) · "

  public static func isBranchTitle(_ title: String) -> Bool {
    title == branchTitlePrefix || title.hasPrefix("\(branchTitlePrefix) · ")
  }

  public static func isRetiredTitle(_ title: String) -> Bool {
    title.hasPrefix(retiredTitlePrefix)
  }

  /**
   Turn a `session.list` answer into the three groups, sorted.

   Newest first inside each group, by `started_at`, with the title as the tie-break so that a
   gateway which reports no timestamps still produces a stable order. Rows with no id are dropped.
   The canonical row is taken OUT of the other two groups even when its title also matches a prefix,
   so it can never be listed twice and can never turn up somewhere Delete is offered.

   - Parameters:
     - canonicalID: the stored id the roster resolved as this bot's canonical chat. Preferred over
       the title where it is known, because an id cannot be typed into the wrong row: a person who
       names a past conversation `Bot Chat` while it is visible would otherwise make it look
       canonical.
     - canonicalResolvedID: the lineage tip of the same row, which a listing may report instead.
   */
  public static func classify(
    rows: [SessionListRow],
    canonicalID: String? = nil,
    canonicalResolvedID: String? = nil
  ) -> ConversationGroups {
    let canonicalIDs = Set([canonicalID, canonicalResolvedID].compactMap { $0 }.filter { !$0.isEmpty })
    var canonical: Conversation?
    var branches: [Conversation] = []
    var past: [Conversation] = []

    for row in rows {
      guard let id = row.id, !id.isEmpty else {
        continue
      }

      let title = row.title ?? ""
      let resolved = row.resolvedID.flatMap { $0.isEmpty ? nil : $0 } ?? id
      let isCanonical =
        canonicalIDs.isEmpty
        ? title == ChatResolver.canonicalTitle
        : canonicalIDs.contains(id) || canonicalIDs.contains(resolved)
      let kind: ConversationKind = isCanonical ? .canonical : isBranchTitle(title) ? .branch : .past
      let conversation = Conversation(
        id: id,
        resolvedID: resolved,
        // A session upstream never got around to titling lists as an empty string.
        title: title.isEmpty ? id : title,
        preview: row.preview ?? "",
        messageCount: row.messageCount ?? 0,
        lastActive: row.startedAt.flatMap { $0.isFinite ? $0 : nil } ?? 0,
        kind: kind
      )

      switch kind {
      case .canonical:
        // First one wins: two rows both answering to the canonical id is a gateway in a state this
        // app cannot fix, and picking one beats drawing the chat twice.
        canonical = canonical ?? conversation
      case .branch:
        branches.append(conversation)
      case .past:
        past.append(conversation)
      }
    }

    return ConversationGroups(canonical: canonical, branches: sorted(branches), past: sorted(past))
  }

  /// Newest first, with the title as a tie-break so the order is total.
  public static func sorted(_ rows: [Conversation]) -> [Conversation] {
    rows.sorted { left, right in
      if left.lastActive != right.lastActive {
        return left.lastActive > right.lastActive
      }

      return left.title.compare(right.title) == .orderedAscending
    }
  }
}
