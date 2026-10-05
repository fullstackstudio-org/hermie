import Foundation
import HermieProtocol

/**
 One gateway's way into the decision log: every place a request is answered tells it what was decided, once
 the answer went out.

 There is one method per kind of request, and none of them takes a value the person typed, a payload the device
 gave or the text of a form: what cannot be passed cannot be stored. What they do take is what the person can
 see on the card anyway (an approval's command, a connector's name), and that goes through
 `DecisionSummary`, which cuts it and drops it altogether for a request that looks sensitive.

 A recorder without a log (a test, a preview) does nothing, and the answering code never has to ask.
 */
public struct DecisionRecorder: Sendable {
  public let gatewayID: String
  public let gatewayName: String

  private let log: DecisionLog?
  private let now: @Sendable () -> Date

  public init(
    log: DecisionLog?,
    gatewayID: String,
    gatewayName: String,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.log = log
    self.gatewayID = gatewayID
    self.gatewayName = gatewayName
    self.now = now
  }

  /// A recorder that keeps nothing.
  public static func discarding(gatewayID: String = "", gatewayName: String = "") -> DecisionRecorder {
    DecisionRecorder(log: nil, gatewayID: gatewayID, gatewayName: gatewayName)
  }

  /// Whether anything is kept at all.
  public var isRecording: Bool { log != nil }

  // MARK: Approvals and questions

  /// An approval answered with one of the choices it offered. `command` and `toolName` only feed the summary.
  public func approval(
    bot: String,
    session: String,
    choice: String,
    command: String?,
    toolName: String? = nil,
    via method: DecisionMethod
  ) async {
    await write(
      kind: .approval,
      outcome: Self.outcome(ofApproval: choice),
      method: method,
      bot: bot,
      session: session,
      summary: command.flatMap { DecisionSummary.approval(command: $0, toolName: toolName) }
    )
  }

  /// A question answered. What was answered is not kept, nor what was asked.
  public func clarify(bot: String, session: String, via method: DecisionMethod) async {
    await write(kind: .clarify, outcome: .answered, method: method, bot: bot, session: session, summary: nil)
  }

  /// A `confirm`: confirmed (with a passkey) or declined (a tap).
  public func confirm(confirmed: Bool, bot: String, session: String, via method: DecisionMethod) async {
    await write(
      kind: .confirm, outcome: confirmed ? .confirmed : .declined, method: method, bot: bot, session: session,
      summary: nil)
  }

  // MARK: Other requests

  /// A one-string prompt: answered with a value (`entered`) or skipped (`declined`). `request` is the prompt's
  /// method (`secret`, `sudo`, `vault.code`, ...), which says what kind of prompt it was and no more.
  public func secure(entered: Bool, bot: String, session: String, request: String, via method: DecisionMethod) async {
    await write(
      kind: .secure, outcome: entered ? .entered : .declined, method: method, bot: bot, session: session,
      summary: Self.known(request))
  }

  /// An interactive request answered, skipped or declined. `request` is its method (`input.form`,
  /// `device.location`, ...); what it was answered with is not an argument.
  public func interactive(
    request: String,
    outcome: DecisionOutcome,
    bot: String,
    session: String,
    via method: DecisionMethod
  ) async {
    guard let kind = Self.kind(ofRequest: request) else {
      return
    }

    await write(kind: kind, outcome: outcome, method: method, bot: bot, session: session, summary: Self.known(request))
  }

  /// A row of a connection card: its link opened (`authorised`), "Not now" (`declined`), or the whole
  /// operation let go (`skipped`). `name` is the connector's name; the link is not kept.
  public func connector(outcome: DecisionOutcome, bot: String, session: String, name: String?) async {
    await write(
      kind: .connector, outcome: outcome, method: .tap, bot: bot, session: session,
      summary: name.flatMap(DecisionSummary.name))
  }

  /// An approval taken back on the Permissions page (the gateway said it removed it). `label` is the grant's own
  /// label, already redacted by the gateway; it is held to `DecisionSummary.limit` characters all the same. `session` is
  /// the runtime session of a session approval, empty for a standing one.
  public func permissionRevoked(bot: String, session: String, label: String) async {
    await write(
      kind: .permissionRevoked, outcome: .revoked, method: .tap, bot: bot, session: session,
      summary: DecisionSummary.label(label))
  }

  // MARK: Mapping

  /// What an approval's choice decided; a choice this build does not know is only `answered`.
  static func outcome(ofApproval choice: String) -> DecisionOutcome {
    switch choice {
    case "once": .approved
    case "session": .approvedSession
    case "always": .approvedAlways
    case "deny": .denied
    default: .answered
    }
  }

  /// The kind a request method is logged as; nil for a method that is not a request the person decides.
  public static func kind(ofRequest method: String) -> DecisionKind? {
    switch method {
    case ServerRequestBody.Method.secret, ServerRequestBody.Method.sudo, ServerRequestBody.Method.vaultUnlock,
      ServerRequestBody.Method.vaultCode, ServerRequestBody.Method.vaultSaveLogin:
      .secure
    case ServerRequestBody.Method.deviceLocation, ServerRequestBody.Method.deviceContact,
      ServerRequestBody.Method.deviceCalendar, ServerRequestBody.Method.deviceScan:
      .device
    case ServerRequestBody.Method.inputForm, ServerRequestBody.Method.inputFile, ServerRequestBody.Method.inputSignature:
      .input
    case ServerRequestBody.Method.reviewDraft, ServerRequestBody.Method.reviewDiff:
      .review
    case ServerRequestBody.Method.confirm:
      .confirm
    default:
      nil
    }
  }

  /// What an interactive answer decided. Reads the case only, never what is inside it.
  static func outcome(of answer: InteractiveAnswer) -> DecisionOutcome {
    switch answer {
    case .skip: .skipped
    case .reject: .denied
    case .approve: .approved
    case .location, .contact, .calendarSaved, .scan: .shared
    case .form, .files, .diff, .signature: .answered
    }
  }

  /// A request method as the summary: only the methods the protocol defines, never text a peer chose.
  private static func known(_ request: String) -> String? {
    kind(ofRequest: request) == nil ? nil : request
  }

  // MARK: Writing

  private func write(
    kind: DecisionKind,
    outcome: DecisionOutcome,
    method: DecisionMethod,
    bot: String,
    session: String,
    summary: String?
  ) async {
    guard let log else {
      return
    }

    await log.record(
      DecisionEntry(
        at: now(),
        gatewayID: gatewayID,
        gateway: DecisionSummary.line(gatewayName),
        bot: DecisionSummary.line(bot),
        session: DecisionSummary.line(session),
        kind: kind,
        outcome: outcome,
        method: method,
        summary: summary
      )
    )
  }
}
