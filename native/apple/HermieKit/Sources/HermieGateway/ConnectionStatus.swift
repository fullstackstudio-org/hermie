/// Where the connection is right now: the `ConnectionStatus` string union of
/// `packages/gateway-client/src/types.ts`, one case per member, raw values the
/// wire spellings.
///
/// `probing` and `authenticating` are pre-dial phases; `needsSignin` and
/// `incompatible` are terminal until the app acts. The connection itself never
/// enters `probing` or `incompatible`: the reference's state machine does not
/// either. They are here because the app reports them through the same
/// vocabulary (the probe before a first connect, and the desktop-contract gate
/// on a session resume).
public enum ConnectionPhase: String, Sendable, Equatable, CaseIterable {
  case disconnected
  case probing
  case authenticating
  case connecting
  case ready
  case reconnecting
  case paused
  case offline
  case needsSignin = "needs_signin"
  case incompatible
}

/// One status transition as the reference's `StatusHandler` receives it:
/// the phase, and the error that explains it (`null` in the reference when
/// there is none).
public struct ConnectionStatus: Sendable, Equatable {
  public var phase: ConnectionPhase
  public var error: GatewayError?

  public init(_ phase: ConnectionPhase, error: GatewayError? = nil) {
    self.phase = phase
    self.error = error
  }
}
