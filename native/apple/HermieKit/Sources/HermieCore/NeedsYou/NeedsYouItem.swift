import Foundation

// MARK: - What kind of thing waits

/**
 What a request that waits for the person is, in the few words the inbox draws it by. The wire
 methods are many (`PushRequestMethod`); the person tells them apart by what they are asked to do,
 not by the method's name.
 */
public enum NeedsYouKind: String, Sendable, CaseIterable, Hashable {
  /// An approval of a tool call or a command.
  case approval
  /// A clarifying question.
  case question
  /// A secret, a password or a code typed into the app (`PushRequestMethod.isSecureInput`).
  case secureInput
  /// A `confirm`, plain or by passkey.
  case confirmation
  /// A form, a file, a signature: something the person fills in or hands over.
  case input
  /// A draft or a diff to read and decide on.
  case review
  /// Something only this device can give: its location, a contact, an event, a scanned code.
  case device
  /// A connector, an MCP server or a catalog entry to authorise (`ConnectionRequest`).
  case connector
  /// A method a newer plugin may add.
  case other

  /// The kind of a wire method (`PushRequestMethod`, or a `vault.*` method of a newer plugin).
  public init(method: String) {
    if method == NeedsYouItem.connectionMethod {
      self = .connector
      return
    }

    guard let known = PushRequestMethod(rawValue: method) else {
      self = method.hasPrefix("vault.") ? .secureInput : .other
      return
    }

    switch known {
    case .approval: self = .approval
    case .clarify: self = .question
    case .secret, .sudo, .vaultUnlockPrompt, .vaultCode, .vaultSaveLogin: self = .secureInput
    case .confirm: self = .confirmation
    case .inputForm, .inputFile, .inputSignature: self = .input
    case .reviewDraft, .reviewDiff: self = .review
    case .deviceLocation, .deviceContact, .deviceCalendar, .deviceScan: self = .device
    }
  }
}

// MARK: - One row

/**
 One thing that waits for the person, on one gateway, for one bot.

 It holds ids, kinds and at most one cleaned line of an approval's or a question's own words
 (`OpenRequest.text`, which only those two kinds ever carry: a secure prompt, a form, a draft, a
 diff and a device request never put text here, so a secret cannot reach the list). A tap on it
 opens the chat; the request itself is read again from the gateway there.
 */
public struct NeedsYouItem: Sendable, Equatable, Identifiable {
  /// One request wherever it was found: the gateway's ids restart, so the gateway is part of it.
  public var id: String
  /// The registry id (`g…`).
  public var gatewayId: String
  /// What the person calls the gateway.
  public var gatewayName: String
  /// The gateway's link key, for a `hermie://chat` link.
  public var gatewayKey: String
  /// The chat it belongs to: the bot's name.
  public var bot: String
  /// What the person calls that bot.
  public var botName: String
  public var kind: NeedsYouKind
  /// The wire method; `connection.request` for a connector card.
  public var method: String
  /// The id the chat's sheet or card is found by (`RequestShelf`).
  public var requestId: String
  /// A `confirm`'s level.
  public var level: PushConfirmLevel?
  /// One cleaned line of an approval's or a question's own words, or `""`.
  public var text: String
  /// The connectors a connection card asks for, by the names the gateway gave them.
  public var targets: [String]
  /// When this device first saw it waiting. A request that was already open when the app connected
  /// is dated by that moment, so this is a lower bound on how long it has waited.
  public var since: Date

  public init(
    id: String,
    gatewayId: String,
    gatewayName: String = "",
    gatewayKey: String = "",
    bot: String,
    botName: String = "",
    kind: NeedsYouKind,
    method: String,
    requestId: String,
    level: PushConfirmLevel? = nil,
    text: String = "",
    targets: [String] = [],
    since: Date
  ) {
    self.id = id
    self.gatewayId = gatewayId
    self.gatewayName = gatewayName
    self.gatewayKey = gatewayKey
    self.bot = bot
    self.botName = botName
    self.kind = kind
    self.method = method
    self.requestId = requestId
    self.level = level
    self.text = text
    self.targets = targets
    self.since = since
  }

  /// A connection card has no `PushRequestMethod`; this is how it is told from the others.
  public static let connectionMethod = "connection.request"

  /// The bot as the list names it: what the person calls it, else the handle.
  public var displayBot: String {
    botName.isEmpty ? bot : botName
  }
}

// MARK: - Its words

/// The sentences a row is titled with, in the reader's language. `HermieUI` has the localised ones.
public struct NeedsYouCopy: Sendable {
  public var request: RequestAlertCopy
  /// What a connector card says: "Connect an account to continue".
  public var connector: String
  /// What a method this build does not name says.
  public var other: String

  public init(request: RequestAlertCopy, connector: String, other: String) {
    self.request = request
    self.connector = connector
    self.other = other
  }

  public static let english = NeedsYouCopy(
    request: .english, connector: "Connect an account to continue", other: "Needs your attention")
}

extension NeedsYouItem {
  /// The longest line of an approval's or a question's own words a title carries.
  public static let textLimit = 120
  /// The most connector names a title lists before it says there are more.
  public static let namedTargets = 3

  /**
   A short title that is safe to show: the kind of request in the contract's words, and for an
   approval or a question its own one-line text. Never a field, a value, a command, a diff or a
   draft: those stay in the chat's sheet. A connector card names the connectors (the gateway's own
   labels for what to authorise, not credentials).
   */
  public func title(copy: NeedsYouCopy) -> String {
    if kind == .connector {
      let names = targets.prefix(Self.namedTargets).joined(separator: ", ")

      guard !names.isEmpty else {
        return copy.connector
      }

      return "\(copy.connector): \(names)\(targets.count > Self.namedTargets ? " …" : "")"
    }

    guard let known = PushRequestMethod(rawValue: method) else {
      return copy.other
    }

    let phrase = copy.request.phrase(known, level)

    guard known.carriesPreview else {
      return phrase
    }

    let line = RequestAlertContent.oneLine(text, limit: Self.textLimit)

    return line.isEmpty ? phrase : "\(phrase): \(line)"
  }
}
