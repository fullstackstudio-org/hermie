import Foundation
import HermieTranscript

/// What Retry on a failed reply did.
public enum RetryOutcome: Sendable, Equatable {
  /// The prompt the failed reply answered went out again.
  case resent(String)
  /// A turn is running, or a Retry is already on its way: nothing was sent.
  case busy
  /// No prompt of the reader's own stands before the reply, or the reply is not the newest one:
  /// nothing to repeat.
  case nothing
}

/// Whose prompts this device may send again under the reader's name.
public struct RetryAuthors: Sendable, Equatable {
  /// The gateway stamps who wrote each row (`per_message_author`).
  public var trusted: Bool
  /// The reader's own author id, once the gateway said who this is.
  public var own: String?

  public init(trusted: Bool, own: String?) {
    self.trusted = trusted
    self.own = own
  }

  /// A gateway that stamps no authors: every row reads as the reader's own, as before authors existed.
  public static let untrusted = RetryAuthors(trusted: false, own: nil)

  /// Whether a prompt written by `author` (nil: unattributed) may go out again as the reader's.
  func mayRepeat(_ author: String?) -> Bool {
    guard trusted, let author else {
      return true
    }

    // Stamped rows and the reader not known yet (just after connecting): a row with an author may be
    // a colleague's, so it is not repeated.
    return author == own
  }
}

extension GatewaySession {
  /// Whose prompts Retry may repeat on this gateway, from what it vouches for and who it says this is.
  public var retryAuthors: RetryAuthors {
    RetryAuthors(trusted: rowAuthorsTrusted, own: identity?.authorID)
  }
}

extension ChatModel {
  /**
   Retry on a failed reply's card (`AssistantErrorCard`): send the prompt that reply answered again,
   as the reader would by hand. The web client's regenerate falls back to the same thing on a gateway
   without `/retry` (`regenerate.ts`, "the previous prompt again"); this is its one road here, and it
   is honest: the transcript then holds two turns.

   - Only the newest turn is retried: a failed reply with a prompt of anyone's after it is history.
   - The prompt is the newest user row with words before the failed reply, and only when it may go
     out as the reader's (`RetryAuthors`): repeating a colleague's words would put them under the
     reader's name.
   - One at a time: a second press while the first is on its way, or while a turn runs, sends nothing.

   A picture sent with the prompt is not sent again (its bytes are no longer on this device); a file
   is, by the `@file:` reference its text carries.
   */
  @discardableResult
  public func retryTurn(of itemID: String, authors: RetryAuthors = .untrusted) async -> RetryOutcome {
    guard !turnActive, !retrying else {
      return .busy
    }

    guard let text = Self.retryPrompt(before: itemID, in: items, authors: authors) else {
      return .nothing
    }

    retrying = true
    defer { retrying = false }

    await send(text)
    return .resent(text)
  }

  /// The words of the reader's prompt the reply `itemID` answered, or nil (see `retryTurn`).
  nonisolated static func retryPrompt(before itemID: String, in items: [VisibleItem], authors: RetryAuthors) -> String? {
    guard let index = items.lastIndex(where: { $0.item.id == itemID }) else {
      return nil
    }

    // A prompt after the failed reply: it is not the newest turn any more.
    let later = items[items.index(after: index)...]

    guard !later.contains(where: { if case .user = $0.item { true } else { false } }) else {
      return nil
    }

    for candidate in items[..<index].reversed() {
      guard case .user(let user) = candidate.item,
        !user.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      else {
        continue
      }

      // The newest prompt is the one the reply answered: one that may not go out as the reader's
      // means there is nothing to repeat, not that an older one should go instead.
      return authors.mayRepeat(user.author?.id) ? user.text : nil
    }

    return nil
  }
}
