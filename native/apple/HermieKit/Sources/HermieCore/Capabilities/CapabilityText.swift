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

  /// A route that is not mounted at all: a 404 that carries no `detail` of its own. A 404 WITH one is
  /// the router answering about something that is not there (one missing card), which is an ordinary
  /// failure and not "this gateway has no such feature".
  static func isMissingRoute(_ error: any Error) -> Bool {
    guard let gateway = error as? GatewayError, gateway.status == 404 else {
      return false
    }

    return (gateway.hint ?? "").isEmpty
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
