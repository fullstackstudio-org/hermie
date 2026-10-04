import Foundation
import HermieTranscript

/// What Retry on a failed reply did.
public enum RetryOutcome: Sendable, Equatable {
  /// The prompt the failed reply answered went out again.
  case resent(String)
  /// A turn is running: nothing was sent (a send now would wait behind it as a queued message).
  case busy
  /// No prompt of the reader's own stands before the reply: nothing to repeat.
  case nothing
}

extension ChatModel {
  /**
   Retry on a failed reply's card (`AssistantErrorCard`): send the prompt that reply answered again,
   as the reader would by hand. The web client's regenerate falls back to the same thing on a gateway
   without `/retry` (`regenerate.ts`, "the previous prompt again"); this app has no slash-command
   catalogue, so this is its one road, and it is honest: the transcript then holds two turns.

   The prompt is the newest user row with words before the failed reply, and only when it is the
   reader's own (or unattributed): repeating a colleague's words in the group chat would put them
   under the reader's name. A picture sent with it is not sent again (its bytes are no longer on this
   device); a file is, by the `@file:` reference its text carries.
   */
  @discardableResult
  public func retryTurn(of itemID: String, ownAuthorID: String? = nil) async -> RetryOutcome {
    guard !turnActive else {
      return .busy
    }

    guard let text = Self.retryPrompt(before: itemID, in: items, ownAuthorID: ownAuthorID) else {
      return .nothing
    }

    await send(text)
    return .resent(text)
  }

  /// The words of the reader's prompt the reply `itemID` answered, or nil (see `retryTurn`).
  nonisolated static func retryPrompt(before itemID: String, in items: [VisibleItem], ownAuthorID: String?) -> String? {
    guard let index = items.lastIndex(where: { $0.item.id == itemID }) else {
      return nil
    }

    for candidate in items[..<index].reversed() {
      guard case .user(let user) = candidate.item,
        !user.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else {
        continue
      }

      // The newest prompt is the one the reply answered: a colleague's means there is nothing of
      // the reader's to repeat, not that an older one of theirs should go instead.
      if let author = user.author?.id, let ownAuthorID, author != ownAuthorID {
        return nil
      }

      return user.text
    }

    return nil
  }
}
