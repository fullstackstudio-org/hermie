import Foundation

/// What a decision was about, as the person tells requests apart.
public enum DecisionKind: String, Sendable, Codable, CaseIterable, Hashable, Identifiable {
  /// A tool call or command waiting for allow or deny (`approval`).
  case approval
  /// A question the bot asked (`clarify`).
  case clarify
  /// A `confirm` request, plain or with a passkey.
  case confirm
  /// A one-string prompt: a secret, the administrator password, a vault unlock, a one-time code, a login to save.
  case secure
  /// A request for something of this device: its position, a contact, a calendar entry, a scanned code.
  case device
  /// A form, files or a signature the bot asked for (`input.*`).
  case input
  /// A draft or a diff the bot wants reviewed (`review.*`).
  case review
  /// A connector the agent waits on to be authorised, or any other row of a connection card.
  case connector
  /// An approval the person took back on the Permissions page: a standing one or one of a session. The
  /// summary is the approval's label, which the gateway has already redacted.
  case permissionRevoked

  public var id: Self { self }
}

/// What the person decided.
public enum DecisionOutcome: String, Sendable, Codable, CaseIterable, Hashable, Identifiable {
  /// Allowed this once (an approval's `once`), or a draft approved.
  case approved
  /// Allowed for the rest of the session (`session`).
  case approvedSession
  /// Allowed for good (`always`): the gateway keeps it.
  case approvedAlways
  /// Refused (`deny`), or a draft sent back.
  case denied
  /// A question or a form answered, files given, a diff decided.
  case answered
  /// A `confirm` confirmed.
  case confirmed
  /// Turned down: a `confirm` declined, a secure prompt or a device request not given.
  case declined
  /// A secure prompt answered with a value. The value is never part of the entry.
  case entered
  /// A device request answered with what it asked for. What it asked for is never part of the entry.
  case shared
  /// A connector's authorisation link opened from this device.
  case authorised
  /// Left out on purpose: Skip, "Not now".
  case skipped
  /// Taken back: an approval the person revoked.
  case revoked

  public var id: Self { self }
}

/// How the decision was made.
public enum DecisionMethod: String, Sendable, Codable, CaseIterable, Hashable, Identifiable {
  /// A tap or click on a button of a card or a sheet.
  case tap
  /// A confirmation signed with a passkey.
  case passkey
  /// An action on a notification (Allow, Deny) without opening the chat.
  case notification
  /// The Return key in a field of a sheet.
  case keyboard

  public var id: Self { self }
}

/**
 One decision the person made on a request: what kind, for which bot on which gateway, when, what they
 decided and how.

 An entry never holds what was answered. A secure prompt's value, a device request's payload (a
 position, a contact, a signature, a scanned value), the text of a form or a draft are not here, and not
 anywhere near here: `DecisionRecorder` has no parameter that could carry one. `summary` says only what the
 request was about: an approval's command (its first line, cut short, and nothing at all when the command
 looks like it carries a secret), the name of a connector, or the method of a secure or interactive request.
 */
public struct DecisionEntry: Sendable, Codable, Hashable, Identifiable {
  public var id: String
  public var at: Date
  /// The gateway's id on this device (what a purge is keyed by).
  public var gatewayID: String
  /// The gateway's name when the decision was made.
  public var gateway: String
  /// The bot's name, which is also its chat's key; empty when the request could not be matched to a chat.
  public var bot: String
  /// The runtime session the request named; empty when it did not.
  public var session: String
  public var kind: DecisionKind
  public var outcome: DecisionOutcome
  public var method: DecisionMethod
  public var summary: String?

  public init(
    id: String = UUID().uuidString,
    at: Date,
    gatewayID: String,
    gateway: String,
    bot: String,
    session: String,
    kind: DecisionKind,
    outcome: DecisionOutcome,
    method: DecisionMethod,
    summary: String? = nil
  ) {
    self.id = id
    self.at = at
    self.gatewayID = gatewayID
    self.gateway = gateway
    self.bot = bot
    self.session = session
    self.kind = kind
    self.outcome = outcome
    self.method = method
    self.summary = summary
  }

  private enum CodingKeys: String, CodingKey {
    case id, at, gatewayID, gateway, bot, session, kind, outcome, method, summary
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)

    id = try container.decode(String.self, forKey: .id)
    // Epoch milliseconds, the way every stored time here is written.
    at = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .at) / 1000)
    gatewayID = try container.decode(String.self, forKey: .gatewayID)
    gateway = try container.decodeIfPresent(String.self, forKey: .gateway) ?? ""
    bot = try container.decodeIfPresent(String.self, forKey: .bot) ?? ""
    session = try container.decodeIfPresent(String.self, forKey: .session) ?? ""
    kind = try container.decode(DecisionKind.self, forKey: .kind)
    outcome = try container.decode(DecisionOutcome.self, forKey: .outcome)
    method = try container.decode(DecisionMethod.self, forKey: .method)
    summary = try container.decodeIfPresent(String.self, forKey: .summary)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)

    try container.encode(id, forKey: .id)
    try container.encode((at.timeIntervalSince1970 * 1000).rounded(), forKey: .at)
    try container.encode(gatewayID, forKey: .gatewayID)
    try container.encode(gateway, forKey: .gateway)
    try container.encode(bot, forKey: .bot)
    try container.encode(session, forKey: .session)
    try container.encode(kind, forKey: .kind)
    try container.encode(outcome, forKey: .outcome)
    try container.encode(method, forKey: .method)
    try container.encodeIfPresent(summary, forKey: .summary)
  }
}

/// How much of the log is kept: whichever limit is hit first.
public struct DecisionLimits: Sendable, Equatable {
  public var maxEntries: Int
  public var maxAge: TimeInterval

  public init(maxEntries: Int, maxAge: TimeInterval) {
    self.maxEntries = maxEntries
    self.maxAge = maxAge
  }

  /// 5,000 entries or 90 days.
  public static let standard = DecisionLimits(maxEntries: 5_000, maxAge: 90 * 24 * 3_600)
}
