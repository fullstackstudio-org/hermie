import Foundation
import HermieProtocol

/// What a one-string prompt asks for, read from its params with every text
/// cleaned and bounded for display (`SecurePrompt.displayText`).
///
/// A prompt for a secret is a phishing surface: anyone who can make the bot ask
/// can make the sheet appear. So the texts here are the request's own words,
/// shown as plain text under chrome the app draws itself, never as Markdown or
/// links, never longer than their bound, and with no control or direction
/// characters that could make one text look like another.
public enum SecurePromptKind: Sendable, Equatable {
  /// A value for an environment variable, stored on the gateway for the bot's
  /// profile; the bot itself never sees it.
  case secret(envVar: String, prompt: String)
  /// The administrator password for a command the bot runs on the gateway
  /// host. `command` is already redacted by the gateway; it may be empty.
  case sudo(command: String)
  /// The master password of an external password manager.
  case vaultUnlock(name: String)
  /// A one-time code a site asked for.
  case vaultCode(site: String, hint: String)
  /// A login to save for a site the bot is about to sign in to.
  case vaultSaveLogin(site: String, origin: String)

  /// How long the gateway waits for an answer before it gives up by itself
  /// (`tui_gateway/agent_callbacks.py`; `secret` uses `_ask`'s default).
  public var gatewayTimeout: Duration {
    switch self {
    case .secret: .seconds(300)
    case .sudo, .vaultUnlock: .seconds(120)
    case .vaultCode, .vaultSaveLogin: .seconds(180)
    }
  }

  /// The prompt a server request asks, or nil when it is not a one-string prompt.
  public init?(_ body: ServerRequestBody) {
    typealias S = SecurePrompt

    switch body {
    case .secret(let p):
      self = .secret(
        envVar: S.displayText(p.envVar, limit: S.nameLimit),
        prompt: S.displayText(p.prompt, limit: S.textLimit)
      )
    case .sudo(let p):
      self = .sudo(command: S.displayText(p.command, limit: S.commandLimit))
    case .vaultUnlock(let p):
      let name = S.displayText(p.displayName, limit: S.nameLimit)
      self = .vaultUnlock(name: name.isEmpty ? S.displayText(p.backend, limit: S.nameLimit) : name)
    case .vaultCode(let p):
      self = .vaultCode(
        site: S.displayText(p.site, limit: S.nameLimit),
        hint: S.displayText(p.hint, limit: S.textLimit)
      )
    case .vaultSaveLogin(let p):
      let origin = S.displayText(p.origin, limit: S.nameLimit)
      let site = S.displayText(p.site, limit: S.nameLimit)
      self = .vaultSaveLogin(site: site.isEmpty ? origin : site, origin: origin)
    case .approval, .clarify, .confirm, .inputForm, .inputFile, .reviewDraft, .reviewDiff, .unknown:
      return nil
    }
  }
}

/// One open one-string prompt, as the sheet shows it. It holds what was asked,
/// never what is answered.
public struct SecurePrompt: Sendable, Equatable, Identifiable {
  /// The server request's id (`srq-…`).
  public let id: String
  public let method: String
  public let kind: SecurePromptKind
  /// The chat it belongs to (the bot's name).
  public var chatKey: String
  /// The runtime session the request names.
  public let sessionID: String
  /// When the gateway stops waiting, on the session's clock, for the
  /// countdown; nil when this client cannot know (the request was first seen
  /// re-delivered after a reconnect, so it may have been waiting a while).
  public var deadline: Duration?
  /// The gateway asks again because an answer sent from here never reached it
  /// (it re-delivered the request after a reconnect): the sheet says so.
  public var earlierAnswerLost: Bool

  public init(
    id: String,
    method: String,
    kind: SecurePromptKind,
    chatKey: String,
    sessionID: String,
    deadline: Duration?,
    earlierAnswerLost: Bool = false
  ) {
    self.id = id
    self.method = method
    self.kind = kind
    self.chatKey = chatKey
    self.sessionID = sessionID
    self.deadline = deadline
    self.earlierAnswerLost = earlierAnswerLost
  }

  /// The longest name shown (a variable, a site, a password manager).
  public static let nameLimit = 120
  /// The longest free text shown (a prompt, a hint).
  public static let textLimit = 600
  /// The longest command shown.
  public static let commandLimit = 1_000

  /// The most combining marks kept on one base character: enough for any
  /// script, too few to paint over the lines above and below.
  public static let marksPerCharacter = 4

  /// `raw` for display, in one bounded pass over its scalars:
  ///
  /// - control, format (the direction overrides among them), separator,
  ///   private-use and unassigned scalars are dropped;
  /// - a tab is a space, runs of spaces are one, and every run of line breaks
  ///   (blank lines included) is one line break;
  /// - at most `marksPerCharacter` combining marks stay on one character;
  /// - the result is trimmed and holds at most `limit` scalars, with an
  ///   ellipsis when anything was cut.
  ///
  /// At most `limit * 8 + 64` scalars of `raw` are read, so a request of any
  /// size costs the same.
  public static func displayText(_ raw: String?, limit: Int) -> String {
    guard let raw, !raw.isEmpty, limit > 0 else {
      return ""
    }

    var out = String.UnicodeScalarView()
    var count = 0
    var marks = 0
    var pendingSpace = false
    var pendingBreak = false
    var cut = false
    var read = 0
    let readLimit = limit * 8 + 64

    for scalar in raw.unicodeScalars {
      read += 1

      if read > readLimit {
        cut = true
        break
      }

      let category = scalar.properties.generalCategory

      switch scalar {
      case "\n", "\r":
        pendingBreak = true
        pendingSpace = false
        continue
      case "\t", " ":
        pendingSpace = true
        continue
      default:
        break
      }

      switch category {
      case .control, .format, .lineSeparator, .paragraphSeparator, .privateUse, .unassigned, .surrogate:
        continue
      case .spaceSeparator:
        pendingSpace = true
        continue
      case .nonspacingMark, .spacingMark, .enclosingMark:
        marks += 1

        // On no character (the start, or after a blank), or one too many.
        if marks > marksPerCharacter || count == 0 || pendingSpace || pendingBreak {
          continue
        }
      default:
        marks = 0
      }

      // The separator a run of blanks stands for, never at the start.
      if count > 0, pendingBreak || pendingSpace {
        out.append(pendingBreak ? "\n" : " ")
        count += 1
      }

      pendingBreak = false
      pendingSpace = false

      if count >= limit {
        cut = true
        break
      }

      out.append(scalar)
      count += 1
    }

    // A trailing separator was never written; one written just before the cut is dropped.
    var text = String(out)

    while let last = text.unicodeScalars.last, last == " " || last == "\n" {
      text.unicodeScalars.removeLast()
    }

    return cut ? text + "…" : text
  }

  /// The text that answers this prompt with `value`, or nil when `value`
  /// cannot answer it (nothing typed). A one-time code drops the spaces and
  /// dashes people type to read it in groups; a login is the JSON text the
  /// gateway reads (`{"identifier": …, "password": …}`).
  public func answer(_ value: SecretValue, identifier: String = "") -> String? {
    switch kind {
    case .vaultCode:
      let code = String(value.revealed.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && $0 != "-" })
      return code.isEmpty ? nil : code
    case .vaultSaveLogin:
      let name = identifier.trimmingCharacters(in: .whitespacesAndNewlines)

      guard !name.isEmpty, !value.isEmpty else {
        return nil
      }

      let login: JSONValue = .object(["identifier": .string(name), "password": .string(value.revealed)])
      return (try? login.canonicalData()).map { String(decoding: $0, as: UTF8.self) }
    case .secret, .sudo, .vaultUnlock:
      return value.isEmpty ? nil : value.revealed
    }
  }
}
