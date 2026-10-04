import Foundation
import HermieTranscript

/// What Branch from here did.
public enum BranchOutcome: Sendable, Equatable {
  /// The conversation was forked; this is the new one (a branch, under the title the gateway settled on).
  case branched(Conversation)
  /// The gateway or the connection refused; the words are for a line over the chat.
  case failed(String)
  /// A fork from this chat is already on its way, or the message is not in the transcript: nothing was asked.
  case nothing
}

extension ChatModel {
  // MARK: Regenerate

  /**
   The one reply that may be asked for again: the newest one that is not an interim note, when a prompt
   of the reader's own stands before it and none after (the rule Retry on a failed reply holds to,
   `retryPrompt`). Nil when there is none, or the newest turn is a colleague's: repeating their words
   would put them under the reader's name.

   A row that draws nothing (a placeholder, a demoted chip) is no reply the reader can point at.
   */
  nonisolated static func regenerateTarget(in items: [VisibleItem], authors: RetryAuthors) -> String? {
    for entry in items.reversed() {
      guard case .assistant(let reply) = entry.item, !reply.interim else {
        continue
      }

      guard entry.presentation == .full || entry.presentation == .collapsed else {
        continue
      }

      return retryPrompt(before: reply.id, in: items, authors: authors) == nil ? nil : reply.id
    }

    return nil
  }

  /// The one reply that may be asked for again, in the chat as it is now.
  public func regenerateTarget(authors: RetryAuthors = .untrusted) -> String? {
    Self.regenerateTarget(in: items, authors: authors)
  }

  /**
   Regenerate on a reply's menu: the prompt it answered goes out again, as Retry does on a failed one
   (`retryTurn`). Only the newest reply: the menu was built when it was opened, and the chat can move
   on while it is open, so the target is decided again here.
   */
  @discardableResult
  public func regenerate(_ itemID: String, authors: RetryAuthors = .untrusted) async -> RetryOutcome {
    guard regenerateTarget(authors: authors) == itemID else {
      return .nothing
    }

    return await retryTurn(of: itemID, authors: authors)
  }

  // MARK: The menu's context

  /// What the chat says for a message's menu, as it is now.
  public func menuContext(
    authors: RetryAuthors, blocked: Bool, canEdit: Bool, canBranch: Bool
  ) -> MessageMenuContext {
    MessageMenuContext(
      regenerateTarget: regenerateTarget(authors: authors),
      authors: authors,
      turnActive: turnActive,
      blocked: blocked,
      canEdit: canEdit,
      canBranch: canBranch && canSend
    )
  }

  // MARK: Branch

  /**
   Branch from here: fork this conversation at `itemID` into a conversation of its own
   (`TranscriptStore.branch`). The chat itself does not move and is not reloaded; the caller decides
   what to do with the new conversation (open it).

   One at a time: a second press while the first is on its way asks nothing.
   */
  @discardableResult
  public func branch(from itemID: String) async -> BranchOutcome {
    guard !branching, let visible = items.first(where: { $0.item.id == itemID }) else {
      return .nothing
    }

    branching = true
    defer { branching = false }

    do {
      let conversation = try await store.branch(
        key, from: itemID, title: BranchPoint.title(for: MessageMenu.words(of: visible.item) ?? ""))

      return .branched(conversation)
    } catch {
      return .failed(ChatResolver.describe(error))
    }
  }
}
