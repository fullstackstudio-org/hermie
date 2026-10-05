import Foundation

/**
 What an entry says about a request, and what it never does.

 The gateway marks no approval as sensitive, so the app judges by what it can see: a command whose first line
 names a password, a token, a key or a credential, carries one of the well-known token shapes, or has a
 password in a URL, and a tool whose own name says it deals with secrets, are sensitive. A sensitive request
 is logged by its kind and nothing else, and a command is cut to its first line and a short length either
 way: the log is a record of what was decided, not a copy of what the bot ran.
 */
public enum DecisionSummary {
  /// The longest summary kept, in characters, the ellipsis included.
  public static let limit = 120

  /// An approval's summary: the command's first line, cut. `nil` for a sensitive request, and for a command
  /// with no text.
  public static func approval(command: String, toolName: String? = nil, flaggedSensitive: Bool = false) -> String? {
    guard !flaggedSensitive, !isSensitive(tool: toolName) else {
      return nil
    }

    let first = command.split(whereSeparator: \.isNewline).lazy
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty }

    guard let first, !looksSensitive(command) else {
      return nil
    }

    let text = line(first)

    return text.isEmpty ? nil : text
  }

  /// A name the gateway gave (a connector), cleaned and cut.
  public static func name(_ raw: String) -> String? {
    let text = line(raw)

    return text.isEmpty ? nil : text
  }

  /// One line of display text: the request's own words cleaned of control and direction characters
  /// (`SecurePrompt.displayText`), then cut at `limit`.
  static func line(_ raw: String) -> String {
    SecurePrompt.displayText(raw, limit: limit).replacingOccurrences(of: "\n", with: " ")
  }

  // MARK: Sensitivity

  static func isSensitive(tool: String?) -> Bool {
    guard let tool = tool?.lowercased(), !tool.isEmpty else {
      return false
    }

    return toolWords.contains { tool.contains($0) }
  }

  private static let toolWords = ["vault", "secret", "credential", "password", "keychain", "sudo"]

  /// Whether the command carries something that must not be kept. Looks at the whole command, not only the line
  /// that would be stored: a first line that is harmless beside a token on the next one is still a command
  /// that handles a token.
  static func looksSensitive(_ command: String) -> Bool {
    let text = command.lowercased()

    if words.contains(where: { text.contains($0) }) {
      return true
    }

    return shapes.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)) != nil
  }

  private static let words = [
    "password", "passwd", "passphrase", "secret", "token", "api_key", "api-key", "apikey", "authorization",
    "bearer ", "credential", "private_key", "private-key", "private key", "-----begin", "x-api-key", "cookie:"
  ]

  /// The shapes of well-known tokens, and a password inside a URL.
  private static let shapes: NSRegularExpression = {
    let pattern = [
      "\\bsk-[A-Za-z0-9_-]{12,}",
      "\\bgh[pousr]_[A-Za-z0-9]{12,}",
      "\\bxox[abprs]-[A-Za-z0-9-]{8,}",
      "\\bAKIA[0-9A-Z]{12,}",
      "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
      "://[^/\\s:@]+:[^/\\s@]+@"
    ].joined(separator: "|")

    return try! NSRegularExpression(pattern: pattern)
  }()
}
