/// The closed set of things the auth layer records (the names of
/// `AuthEventName` in `auth-timeline.ts`). An event carries a name, an HTTP
/// status or close code, an error kind, a lifetime and a reason, and nothing
/// else: no token, no message text, no host.
public enum AuthEventName: String, Sendable, Equatable, CaseIterable {
  case dialStart = "dial.start"
  case dialReady = "dial.ready"
  case ticketMinted = "ticket.minted"
  case ticketFailed = "ticket.failed"
  case tokenServed = "token.served"
  case tokenReadFailed = "token.read_failed"
  case tokenAbsent = "token.absent"
  case tokenWriteOK = "token.write_ok"
  case tokenWriteFailed = "token.write_failed"
  case tokenCleared = "token.cleared"
  case refreshStart = "refresh.start"
  case refreshOK = "refresh.ok"
  case refreshFailed = "refresh.failed"
  case wsClosed = "ws.closed"
  case restUnauthorized = "rest.unauthorized"
  case signinRequired = "signin.required"
  case signinNoRefresh = "signin.no_refresh"
  case startupFailed = "startup.failed"
}

/// Why a session ended (`SignOutReason`).
public enum SignOutReason: String, Sendable, Equatable, CaseIterable {
  case refreshRejected = "refresh_rejected"
  case refreshFailed = "refresh_failed"
  case noRefreshToken = "no_refresh_token"
  case rejectedAfterRefresh = "rejected_after_refresh"
  case tokenUnreadable = "token_unreadable"
}

/// One auth event, without its time: the recorder stamps it.
public struct AuthEvent: Sendable, Equatable {
  public var event: AuthEventName
  public var status: Int?
  public var closeCode: Int?
  public var kind: GatewayErrorKind?
  /// Seconds until the access token expires, as this device's clock reads it.
  public var expiresIn: Double?
  public var reason: SignOutReason?

  public init(
    _ event: AuthEventName,
    status: Int? = nil,
    closeCode: Int? = nil,
    kind: GatewayErrorKind? = nil,
    expiresIn: Double? = nil,
    reason: SignOutReason? = nil
  ) {
    self.event = event
    self.status = status
    self.closeCode = closeCode
    self.kind = kind
    self.expiresIn = expiresIn
    self.reason = reason
  }

  /// The classification of a failure and nothing else from it (`kindOf`): a
  /// `GatewayError`'s kind and status; anything else stays anonymous.
  static func failure(_ event: AuthEventName, _ error: any Error) -> AuthEvent {
    guard let error = error as? GatewayError else {
      return AuthEvent(event)
    }

    return AuthEvent(event, status: error.status, kind: error.kind)
  }
}

/// Where the auth layer writes what it did (`AuthTimelineSink`). The ring
/// itself belongs to whoever owns the connection.
public protocol AuthEventRecorder: Sendable {
  func record(_ event: AuthEvent)
}
