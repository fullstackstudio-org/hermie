/// The reconnect ladder: the vendored `@hermes/shared/reconnect-backoff` plus
/// the bounded jitter and protocol floor `connection.ts` puts on top.
///
/// Randomness is a parameter: `random` returns a value in `[0, 1)`, the role
/// `Math.random()` plays in the reference (the vectors record it). The
/// arithmetic is IEEE double in the reference's order, so the results match to
/// the last bit.
public enum ReconnectBackoff {
  /// Delay for the first retry (attempt 0) before jitter, in ms.
  public static let baseDelayMs: Double = 300
  /// Ceiling on the ladder (`RECONNECT_CAP_MS`).
  public static let capMs: Double = 15_000
  /// The lowest share of the ceiling a default wait may be: jitter is 50–100 %.
  public static let jitterFloor: Double = 0.5
  /// Where the ladder starts after a `protocol` failure (attempt 3 is a 2.4 s ceiling).
  public static let protocolLadderFloor = 3
  /// `2 ** attempt` is clamped here so the arithmetic stays finite.
  private static let maxExponent: Double = 32

  /// `min(capMs, baseDelayMs * 2 ** min(max(0, trunc(attempt)), 32))`.
  public static func ceilingMs(attempt: Double, baseDelayMs: Double = baseDelayMs, capMs: Double = capMs) -> Double {
    // NaN propagates through Math.trunc/max/min/** in the reference; it would trap `Int(_:)` here.
    guard !attempt.isNaN else {
      return .nan
    }

    let exponent = min(max(0, attempt.rounded(.towardZero)), maxExponent)
    var power = 1.0

    for _ in 0..<Int(exponent) {
      power *= 2
    }

    return min(capMs, baseDelayMs * power)
  }

  /// `reconnectBackoffDelayMs`: with jitter (the upstream default) a full-jitter
  /// draw `random() * ceiling`; without it, the ceiling itself.
  public static func delayMs(
    attempt: Double,
    baseDelayMs: Double = baseDelayMs,
    capMs: Double = capMs,
    jitter: Bool = true,
    random: () -> Double
  ) -> Double {
    let ceiling = ceilingMs(attempt: attempt, baseDelayMs: baseDelayMs, capMs: capMs)
    return jitter ? random() * ceiling : ceiling
  }

  /// `defaultBackoffDelayMs`: the connection's own ladder, bounded jitter so a
  /// wait is never less than half its rung: `ceiling * (0.5 + 0.5 * random())`.
  public static func defaultDelayMs(attempt: Double, random: () -> Double) -> Double {
    let ceiling = ceilingMs(attempt: attempt, capMs: capMs)
    return ceiling * (jitterFloor + (1 - jitterFloor) * random())
  }

  /// The rung a failure climbs from: a `protocol` failure (something that is
  /// not a gateway answered) starts no lower than `protocolLadderFloor`;
  /// everything else climbs from where it was.
  public static func rung(attempt: Int, failure: GatewayErrorKind) -> Int {
    failure == .protocol ? max(attempt, protocolLadderFloor) : attempt
  }
}
