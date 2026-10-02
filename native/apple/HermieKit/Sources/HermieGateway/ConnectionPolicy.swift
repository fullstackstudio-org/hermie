/// How long things may take, in milliseconds. The values of `connection.ts`,
/// `http.ts`, `probe.ts` and the vendored JSON-RPC gateway client.
public enum GatewayTimeouts {
  /// After the socket opens, how long to wait for the first `gateway.ready` frame.
  public static let readyMs = 10_000
  /// The WebSocket dial and upgrade (`DEFAULT_CONNECT_TIMEOUT_MS` of the shared JSON-RPC client).
  public static let handshakeMs = 15_000
  /// One JSON-RPC call, unless the table below says otherwise.
  public static let defaultRPCMs = 30_000
  /// `prompt.submit`: a turn can legitimately run for half an hour.
  public static let promptSubmitMs = 1_800_000
  /// The first `session.resume` / `session.create` after a connect rebuilds an agent.
  public static let firstSessionMs = 60_000
  /// One REST call (`DEFAULT_REST_TIMEOUT_MS`).
  public static let restMs = 30_000
  /// The address probe (`PROBE_TIMEOUT_MS`).
  public static let probeMs = 10_000
  /// How long a reported "offline" must hold before the socket comes down.
  public static let offlineGraceMs = 2_500
  /// A dial that failed this recently means the ladder is still climbing.
  public static let dialFailureRecentMs = 30_000

  /// How long one call gets. Method names match exactly (case and whitespace count).
  public static func rpcTimeoutMs(method: String, firstSessionCallDone: Bool) -> Int {
    if JSText.same(method, "prompt.submit") {
      return promptSubmitMs
    }

    if !firstSessionCallDone, JSText.same(method, "session.resume") || JSText.same(method, "session.create") {
      return firstSessionMs
    }

    return defaultRPCMs
  }
}

/// What a WebSocket close code tells the connection to do.
public enum CloseCodeVerdict: Sendable, Equatable {
  /// 4401: the gateway refused the dial ticket. Mint a fresh one once; a second
  /// refusal in a row makes the credential the suspect.
  case auth
  /// 4403, 4404, 4408: a configuration problem, not a blip. Stop and say this.
  case config(message: String)
  /// Anything else (or no code): climb the reconnect ladder.
  case transient

  /// Classify a close code. `nil` (no code seen) is transient.
  public static func classify(_ closeCode: Int?) -> CloseCodeVerdict {
    switch closeCode {
    case 4401:
      .auth
    case 4403:
      .config(
        message:
          "The gateway rejected the connection because the address you used is not one it trusts. Set the gateway’s `dashboard.public_url` to this address and restart it."
      )
    case 4404:
      .config(message: "Chat is switched off on this gateway.")
    case 4408:
      .config(message: "Another client took this connection over. Reopen Hermie to reclaim it.")
    default:
      .transient
    }
  }

  /// The `GatewayError` the reference raises for a config close code; `nil` for the others.
  public static func configError(for closeCode: Int?) -> GatewayError? {
    guard case .config(let message) = classify(closeCode) else {
      return nil
    }

    return GatewayError(.config, message, closeCode: closeCode)
  }
}

/// The version gate on `SessionLiveInfo.desktop_contract`.
public enum DesktopContract {
  /// The oldest desktop contract this client speaks (`MIN_DESKTOP_CONTRACT`).
  public static let minimum = 7

  /// `desktop_contract` as it arrived: the gateway has sent numbers and strings.
  public enum Value: Sendable, Equatable {
    case number(Double)
    case string(String)
    /// Present but neither (null, a boolean, an array, an object).
    case other
  }

  /// The two fields of a session's live info the gate reads.
  public struct Info: Sendable, Equatable {
    /// `nil` when the field is absent.
    public var desktopContract: Value?
    /// True only for the JSON literal `true`.
    public var lazy: Bool

    public init(desktopContract: Value? = nil, lazy: Bool = false) {
      self.desktopContract = desktopContract
      self.lazy = lazy
    }
  }

  /// `assertDesktopContract`. Returns the contract checked, or `nil` when a lazy
  /// resume was let through on trust; throws `incompatible` below the minimum.
  ///
  /// A string is read as `parseInt(s, 10)` (`" 8 "` and `"8abc"` are 8, `"7.9"`
  /// is 7), a number as is (`7.5` stays 7.5). A `lazy` resume without the field
  /// is a new bot, not an old gateway: `known` (the contract last seen from this
  /// gateway) stands in, and with nothing known it is let through.
  public static func check(_ info: Info?, known: Double? = nil) throws(GatewayError) -> Double? {
    var contract: Double?

    switch info?.desktopContract {
    case .number(let value)?:
      contract = value.isNaN ? nil : value
    case .string(let text)?:
      contract = JSText.parseInt(text)
    case .other?, nil:
      contract = nil
    }

    if contract == nil {
      guard info?.lazy == true else {
        throw GatewayError(
          .incompatible,
          "This gateway does not report a desktop contract version, so it predates the session surface Hermie needs. Update Hermes on the gateway."
        )
      }

      guard let known, !known.isNaN else {
        return nil
      }

      contract = known
    }

    let checked = contract!

    if checked < Double(minimum) {
      throw GatewayError(
        .incompatible,
        "This gateway speaks desktop contract \(JSText.numberString(checked)); Hermie needs at least \(minimum). Update Hermes on the gateway."
      )
    }

    return checked
  }
}
