import Foundation
import HermieGateway
import HermieProtocol

/**
 How the capability panels (Memory, Skills, MCP servers, Connectors, Boards) word what the gateway
 said: bounded plain text, never Markdown, and a REST refusal in its own sentence.

 A REST refusal carries the gateway's `detail` as the error's `hint` (`HTTPClient.detail(of:)`): the
 message beside it is only "HTTP 409", which is nothing a person can act on, so the hint is what is
 shown where there is one.
 */
enum CapabilityText {
  /// An error's words for a line on screen.
  static func words(of error: any Error) -> String {
    let said =
      if let gateway = error as? GatewayError, let hint = gateway.hint, !hint.isEmpty {
        hint
      } else {
        ChatResolver.describe(error)
      }

    return line(said, limit: SecurePrompt.textLimit)
  }

  /// Text the gateway or a bot wrote, as one bounded line of plain text.
  static func line(_ raw: String?, limit: Int = SecurePrompt.textLimit) -> String {
    SecurePrompt.displayText(raw, limit: limit).replacingOccurrences(of: "\n", with: " ")
  }

  /// Text the gateway or a bot wrote, bounded but with its line breaks kept (a description, a note).
  static func text(_ raw: String?, limit: Int = SecurePrompt.textLimit) -> String {
    SecurePrompt.displayText(raw, limit: limit)
  }

  /// The HTTP status of a REST refusal, when the error is one.
  static func status(of error: any Error) -> Int? {
    (error as? GatewayError)?.status
  }

  /// A 404. The REST client attaches no sentence to one (`HTTPClient` words every 404 as "no such
  /// endpoint"), so a 404 cannot tell "the plugin is not mounted" from "the plugin answered that this
  /// one thing is not there". A route that exists whenever the plugin does (the list of boards, the
  /// memory listing) is therefore the one to ask; a 404 from anything under it means the thing is gone.
  static func isMissingRoute(_ error: any Error) -> Bool {
    (error as? GatewayError)?.status == 404
  }

  /// A route that is there and switched off for this profile (403).
  static func isSwitchedOff(_ error: any Error) -> Bool {
    status(of: error) == 403
  }

  /// A query string, every value percent-encoded as one whole component (`&`, `+`, `=` and `#` inside
  /// a value are encoded, which `URLComponents` would leave alone).
  static func query(_ items: [(String, String)]) -> String {
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&+=#")

    return items.map { name, value in
      let encoded = value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
      return "\(name)=\(encoded)"
    }.joined(separator: "&")
  }
}
