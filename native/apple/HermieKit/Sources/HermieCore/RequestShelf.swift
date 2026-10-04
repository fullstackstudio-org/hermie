import Foundation
import Observation

/// The requests the person put away, per chat, for as long as the session lives: with Later (or Esc),
/// or by leaving the chat while its sheet was up. Putting a request away is never an answer: it stays
/// open at the gateway and in the chat, and its sheet does not come up again by itself, not even when
/// the chat is opened again; the chat says it is waiting and opens it on request.
///
/// It is the session's and not a chat screen's: a chat screen is made again every time the chat is
/// opened, and what it held would be forgotten with it, raising the same sheet again over a chat the
/// person only meant to pass through.
///
/// Each kind of request has its own ids (the approval, clarify and confirm sheet, the secure prompts,
/// the interactive requests), so each model forgets only its own when it prunes.
@MainActor
@Observable
public final class RequestShelf {
  /// Which model a request belongs to.
  public enum Kind: Hashable, Sendable {
    /// Approvals, clarify questions and passkey confirmations (`RequestsModel`).
    case answer
    /// The one-string prompts (`SecureInputModel`).
    case secure
    /// Forms, file requests and draft reviews (`InteractiveModel`).
    case interactive
  }

  private struct Key: Hashable {
    let chat: String
    let kind: Kind
  }

  private var shelved: [Key: Set<String>] = [:]

  public init() {}

  /// Whether `id` was put away in `chat`.
  public func contains(_ id: String, chat: String, kind: Kind) -> Bool {
    shelved[Key(chat: chat, kind: kind)]?.contains(id) == true
  }

  /// The ids put away in `chat`, of one kind.
  public func ids(chat: String, kind: Kind) -> Set<String> {
    shelved[Key(chat: chat, kind: kind)] ?? []
  }

  /// Put `id` away: not an answer, and it does not come up again by itself.
  public func putAway(_ id: String, chat: String, kind: Kind) {
    let key = Key(chat: chat, kind: kind)

    guard shelved[key]?.contains(id) != true else {
      return
    }

    shelved[key, default: []].insert(id)
  }

  /// The person opened it again.
  public func bringBack(_ id: String, chat: String, kind: Kind) {
    let key = Key(chat: chat, kind: kind)

    guard shelved[key]?.contains(id) == true else {
      return
    }

    shelved[key]?.remove(id)

    if shelved[key]?.isEmpty == true {
      shelved[key] = nil
    }
  }

  /// Forget the ids of `kind` in `chat` that are no longer open, so the shelf holds only requests
  /// still waiting. Called with a list the caller knows is complete.
  public func keep(only open: Set<String>, chat: String, kind: Kind) {
    let key = Key(chat: chat, kind: kind)

    guard let current = shelved[key] else {
      return
    }

    let kept = current.intersection(open)

    guard kept != current else {
      return
    }

    shelved[key] = kept.isEmpty ? nil : kept
  }
}
