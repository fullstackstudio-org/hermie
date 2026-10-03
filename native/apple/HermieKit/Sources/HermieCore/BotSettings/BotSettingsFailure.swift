import Foundation
import HermieGateway
import HermieProtocol

/**
 Why a bot settings call did not do what the screen asked, sorted by what the screen should do
 about it.

 - `forbidden`: this account may look at the bot and not change it. The screen goes read-only.
 - `unsupported`: the gateway has no such method (`-32601`). The section is hidden, not shown dead.
 - `offline`: no connection to ask over, or none in time. Nothing was changed; try again.
 - `notFound`: the gateway has no such profile.
 - `notApplied`: the gateway answered, and said it did not write the section.
 - `refused`: the gateway said no, in its own words. Those words are untrusted text.
 - `lastToolset`: nothing was sent. The gateway stores the toolsets as a pin of the enabled ones and
   reads an EMPTY pin as "no pin, use the defaults", so a bot with every toolset off cannot be
   written; the last one stays on instead of the screen reporting a state the gateway would undo.

 The gateway has no profile-level permission code of its own yet (`profiles.configure` answers any
 caller), so `forbidden` is read from what a gateway in front of it, or a later build, would say:
 the access-denied range of codes (`4030` to `4033`, `4403`) and the plain words for it.
 */
public enum BotSettingsFailure: Error, Sendable, Equatable {
  case forbidden(String)
  case unsupported
  case offline
  case notFound(String)
  case notApplied
  case refused(String)
  case lastToolset

  /// JSON-RPC's "method not found".
  static let methodNotFound = -32601
  /// The codes a gateway answers an account that may not do this with.
  static let forbiddenCodes: Set<Int> = [4030, 4031, 4032, 4033, 4403, 403]
  /// The gateway's "profile not found" for the `profiles.*` methods.
  static let profileNotFoundCodes: Set<Int> = [4064]

  /// The gateway's own words, when it had some: untrusted text, drawn as plain text.
  public var detail: String? {
    switch self {
    case .forbidden(let message), .notFound(let message), .refused(let message): message.isEmpty ? nil : message
    case .unsupported, .offline, .notApplied, .lastToolset: nil
    }
  }

  /// Whether this should put the screen into read-only.
  public var isForbidden: Bool {
    if case .forbidden = self { true } else { false }
  }

  /// Sort anything a gateway call can throw.
  public static func classify(_ error: any Error) -> BotSettingsFailure {
    if let failure = error as? BotSettingsFailure {
      return failure
    }

    if let rpc = error as? GatewayRPCError {
      switch rpc.kind {
      case .notConnected, .closed, .timeout:
        return .offline
      case .rejected:
        let code = rpc.code ?? 0

        if code == methodNotFound {
          return .unsupported
        }

        if forbiddenCodes.contains(code) || looksForbidden(rpc.message) {
          return .forbidden(rpc.message)
        }

        if profileNotFoundCodes.contains(code) {
          return .notFound(rpc.message)
        }

        return .refused(rpc.message)
      case .unencodable, .unexpectedResult:
        return .refused(rpc.message)
      }
    }

    if let gateway = error as? GatewayError {
      switch gateway.kind {
      case .auth:
        return .forbidden(gateway.message)
      case .network, .tls, .timeout:
        return .offline
      default:
        return .refused(gateway.message)
      }
    }

    return .refused(String(describing: error))
  }

  /// The plain words a refusal of this kind uses.
  static func looksForbidden(_ message: String) -> Bool {
    let text = message.lowercased()

    return ["forbidden", "not permitted", "permission denied", "not allowed", "read-only", "access denied"]
      .contains { text.contains($0) }
  }
}
