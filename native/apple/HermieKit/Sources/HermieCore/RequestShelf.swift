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
/// A request that is over is forgotten (`forget`, `keep(only:)`): the gateway hands out its ids again
/// after a restart, and a new request under an old id must come up. Where the end of a request is not
/// told (an approval, a passkey confirmation), the request carries a `stamp` (when it arrived) and only
/// the same id with the same stamp counts as put away.
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

  /// Per chat and kind: the ids put away, each with the stamp it was put away under.
  private var shelved: [Key: [String: Double]] = [:]

  /// The stamp of a request that carries none.
  public static let noStamp: Double = -1

  public init() {}

  /// Whether `id` (arrived at `stamp`) was put away in `chat`.
  public func contains(_ id: String, chat: String, kind: Kind, stamp: Double = noStamp) -> Bool {
    shelved[Key(chat: chat, kind: kind)]?[id] == stamp
  }

  /// The ids put away in `chat`, of one kind.
  public func ids(chat: String, kind: Kind) -> Set<String> {
    Set(shelved[Key(chat: chat, kind: kind)].map { Array($0.keys) } ?? [])
  }

  /// Put `id` away: not an answer, and it does not come up again by itself.
  public func putAway(_ id: String, chat: String, kind: Kind, stamp: Double = noStamp) {
    let key = Key(chat: chat, kind: kind)

    guard shelved[key]?[id] != stamp else {
      return
    }

    shelved[key, default: [:]][id] = stamp
  }

  /// The person opened it again.
  public func bringBack(_ id: String, chat: String, kind: Kind) {
    remove(Key(chat: chat, kind: kind), id)
  }

  /// The request is over, in whichever chat it was: it is no longer put away.
  public func forget(_ id: String, kind: Kind) {
    for key in shelved.keys where key.kind == kind {
      remove(key, id)
    }
  }

  /// Forget the ids of `kind` in `chat` that are no longer open, so the shelf holds only requests
  /// still waiting. Called with a list the caller knows is complete.
  public func keep(only open: Set<String>, chat: String, kind: Kind) {
    let key = Key(chat: chat, kind: kind)

    guard let current = shelved[key] else {
      return
    }

    let kept = current.filter { open.contains($0.key) }

    guard kept.count != current.count else {
      return
    }

    shelved[key] = kept.isEmpty ? nil : kept
  }

  private func remove(_ key: Key, _ id: String) {
    guard shelved[key]?[id] != nil else {
      return
    }

    shelved[key]?[id] = nil

    if shelved[key]?.isEmpty == true {
      shelved[key] = nil
    }
  }
}
