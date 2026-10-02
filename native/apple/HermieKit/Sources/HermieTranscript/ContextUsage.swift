import HermieProtocol

// How full a session's context window is, from whatever the gateway said
// (`context-usage.ts`).
//
// The gateway reports usage in three places and they are the same numbers: the
// `session.usage` tick while a turn runs, the `usage` on `message.complete` when
// it ends, and the `usage` inside `SessionLiveInfo` that a resume answers with.
// The reducer folds all three into `ChatState.usage`, so this reads one field and
// the surfaces that draw it do not have to know which event last touched it.
//
// ## Two numbers, and no guessing at the second one
//
// A ring needs a numerator and a denominator. `context_used` is the first and
// `context_max` is the second, and **without `context_max` there is no ring at
// all** — not a default, not a table of model context sizes keyed off
// `usage.model`. A table like that is a promise about somebody else's product:
// it is right until a provider ships a longer window or a gateway is configured
// to reserve part of one, and when it is wrong it is wrong in the direction that
// tells a reader they have room they do not have. `nil` is the honest answer,
// and the caller hides the control.
//
// ## The percentage is computed, not read
//
// `Usage` also carries `context_percent`, and it is deliberately ignored. The
// contract does not say whether it is a fraction or a hundredth, and the two are
// indistinguishable for any session under one per cent — which is every session
// for the first few turns, i.e. exactly when a wrong reading would be least
// likely to be noticed. Dividing the two numbers we already trust cannot
// disagree with the bar drawn beside it.

public struct ContextUsage: TranscriptJSONCodable, Hashable {
  /// Tokens in the window right now, as the gateway counted them.
  public var used: Double
  /// The window's size. Always positive; the whole thing is `nil` without it.
  public var limit: Double
  /// `used / limit`, clamped to `0…1`.
  ///
  /// Clamped because a session can genuinely be over: the gateway counts what it
  /// sent, and a compaction that has not happened yet leaves the figure above the
  /// window for a moment. A ring drawn past full is a drawing bug; `used` itself
  /// is left truthful, so the numbers under the ring still say what happened.
  public var fraction: Double
  /// `fraction` as whole per cent, for the label beside the ring.
  public var percent: Double
  /// The gateway flagged the count as approximate rather than exact.
  public var estimated: Bool
  /// How the gateway arrived at the window size, when it said.
  public var source: String?

  public init(used: Double, limit: Double, fraction: Double, percent: Double, estimated: Bool, source: String? = nil) {
    self.used = used
    self.limit = limit
    self.fraction = fraction
    self.percent = percent
    self.estimated = estimated
    self.source = source
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "ContextUsage")
    used = try reader.required("used")
    limit = try reader.required("limit")
    fraction = try reader.required("fraction")
    percent = try reader.required("percent")
    estimated = try reader.required("estimated")
    source = reader.optional("source")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("estimated", estimated)
    writer.set("fraction", fraction)
    writer.set("limit", limit)
    writer.set("percent", percent)
    writer.set("used", used)
    writer.set("source", source)
    return writer.json
  }
}

/// A finite, non-negative number, or `nil`.
private func positive(_ value: JSONValue?) -> Double? {
  guard case .number(let number)? = value, number.isFinite, number >= 0 else { return nil }
  return number
}

/// Read a usage record, or answer `nil` when it cannot say how full the window
/// is.
///
/// `nil` means "there is nothing to draw" and never "draw a zero": a chat whose
/// gateway does not report context is a chat with no ring, and a ring sitting
/// empty would say the session is fresh.
///
/// Reads the raw members, not `Usage`'s typed `Int` properties: the TypeScript
/// accepts any finite number there, fractions included.
public func contextUsageOf(_ usage: Usage?) -> ContextUsage? {
  guard let usage else {
    return nil
  }

  let limit = positive(usage.json["context_max"])
  let used = positive(usage.json["context_used"])

  guard let limit, limit != 0, let used else {
    return nil
  }

  let fraction = min(1, used / limit)
  let source = usage.json["context_source"]?.stringValue.map(JS.trim) ?? ""

  return ContextUsage(
    used: used,
    limit: limit,
    fraction: fraction,
    percent: JS.round(fraction * 100),
    estimated: usage.json["context_estimated"] == .bool(true),
    source: source.isEmpty ? nil : source
  )
}

/// The same reading, from a live-info snapshot.
///
/// A resume answers with `info.usage` before any `session.usage` tick has
/// arrived, so this is what fills the ring on a cold open of a chat that is not
/// running a turn.
public func contextUsageOfInfo(_ info: SessionLiveInfo?) -> ContextUsage? {
  contextUsageOf(info.flatMap { usageIfTruthy($0.json["usage"]) })
}

/// One chat's reading, from the two places the reducer keeps one.
///
/// `state.usage` is whatever the last `session.usage` tick or `message.complete`
/// carried, so it is by construction the most recent thing the gateway said — no
/// merging and no comparing is needed, and none is done. `info.usage` is only the
/// fallback for a chat that has resumed and not yet run a turn, which is the cold
/// open every reader sees first.
///
/// Deliberately NOT a max of the two. Usage goes DOWN when the session compacts,
/// and a reading that only ever grew would show a window still full minutes after
/// the gateway emptied it.
public func chatContextUsage(usage: Usage?, info: SessionLiveInfo?) -> ContextUsage? {
  contextUsageOf(usage) ?? contextUsageOfInfo(info)
}

/// `chatContextUsage(state)`.
public func chatContextUsage(_ state: ChatState?) -> ContextUsage? {
  chatContextUsage(usage: state?.usage, info: state?.info)
}

/// `if (!usage)`: any truthy value goes on to the member reads, which find
/// nothing on a non-object; only an object can produce a reading.
private func usageIfTruthy(_ value: JSONValue?) -> Usage? {
  guard case .object(let object)? = value else { return nil }
  return Usage(json: object)
}
