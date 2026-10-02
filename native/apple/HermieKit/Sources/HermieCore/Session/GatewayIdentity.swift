import Foundation
import HermieGateway
import HermieTranscript
import Synchronization

/// Who a gateway says this client is, in the spelling its message rows use.
public struct GatewayIdentity: Sendable, Equatable {
  /// `<provider>:<user_id>`, built exactly as the gateway builds the author
  /// stamp on a row (`OwnAuthor.authorID`). The identity.
  public var authorID: String
  /// The gateway's display name for this login, when it has one. Untrusted text.
  public var displayName: String?
  /// `false` while this is the answer remembered from an earlier session and the
  /// gateway has not confirmed it yet on this connection.
  public var verified: Bool

  public init(authorID: String, displayName: String? = nil, verified: Bool) {
    self.authorID = authorID
    self.displayName = displayName
    self.verified = verified
  }

  /// As the transcript stamps an optimistic bubble.
  public var author: MessageAuthor {
    MessageAuthor(id: authorID, name: displayName)
  }
}

/// Why a gateway has no user identity for this client. A fact to show ("this
/// gateway treats you as anonymous"), not an error.
public enum GatewayAnonymity: String, Sendable, Equatable {
  /// The client signs in with an ungated gateway's shared session token (also
  /// behind a front door that checks its own credential): the gateway has no
  /// accounts, and stamps nobody on the rows this client writes.
  case sessionToken
  /// The gateway answered `/api/auth/me` without a provider or a user id, so it
  /// stamps nobody either.
  case noAccount
}

/// What the session knows about who it is.
public enum GatewayIdentityState: Sendable, Equatable {
  /// Not asked yet, and nothing remembered.
  case unknownYet
  case known(GatewayIdentity)
  case anonymous(GatewayAnonymity)
  /// The gateway could not be asked, and no earlier answer is held. The reason
  /// is for the developer detail. Asked again on the next connect.
  case failed(String)

  /// The next state after a probe. Never invents an identity: an id comes only
  /// from the gateway's own answer. A failed read keeps an identity already held
  /// (the gateway has not said otherwise; a refusal is no answer, as in the
  /// reference), and otherwise reports the failure.
  public func after(_ probe: IdentityProbe) -> GatewayIdentityState {
    switch probe {
    case .sessionToken:
      return .anonymous(.sessionToken)
    case .answered(let me):
      guard let own = OwnAuthor.of(provider: me.provider, userID: me.userID, displayName: me.displayName) else {
        return .anonymous(.noAccount)
      }

      return .known(GatewayIdentity(authorID: own.id, displayName: own.name, verified: true))
    case .failed(let reason):
      if case .known = self {
        return self
      }

      return .failed(reason)
    }
  }

  public var identity: GatewayIdentity? {
    if case .known(let identity) = self { identity } else { nil }
  }
}

/// The reader's own author, as the store reads it when a turn begins: the
/// session writes it from the main actor, the store reads it from its own.
final class OwnAuthorCell: Sendable {
  private let value = Mutex<MessageAuthor?>(nil)

  func get() -> MessageAuthor? {
    value.withLock { $0 }
  }

  func set(_ author: MessageAuthor?) {
    value.withLock { $0 = author }
  }
}

/// The remembered own author, as the reference stores it (`{"id", "name"?}`
/// under `hermie.chats.own_author@<gateway id>`).
struct StoredOwnAuthor: Codable, Sendable, Equatable {
  var id: String
  var name: String?
}
