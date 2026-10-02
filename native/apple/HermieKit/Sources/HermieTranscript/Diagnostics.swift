import Foundation
import HermieProtocol

// What to look at when a chat shows something twice (`diagnostics.ts`)
// ====================================================================
//
// A duplicate is hard to report from a phone: the evidence is a screenshot of
// two bubbles, which says nothing about WHICH path put the second one there.
// This answers that in numbers a developer screen can show and a reader can
// paste into an issue — how many items the transcript holds, how many the
// gateway has given a durable row id, and which items are carrying the same
// text as another.
//
// Nothing here reads message text out. A repeated text is reported as a
// fingerprint — a 32-bit digest and a length — so two items can be shown to
// hold the same words without the words leaving the device.

/// One item of a `RepeatedText`.
public struct RepeatedTextItem: Sendable, Hashable {
  public var id: String
  public var origin: ItemOrigin
  public var rowID: Int?
  public var seq: Int

  public init(id: String, origin: ItemOrigin, rowID: Int? = nil, seq: Int) {
    self.id = id
    self.origin = origin
    self.rowID = rowID
    self.seq = seq
  }

  public var jsonValue: JSONValue {
    var object: JSONObject = ["id": .string(id), "origin": origin.jsonValue, "seq": .number(Double(seq))]
    if let rowID { object["rowId"] = .number(Double(rowID)) }
    return .object(object)
  }
}

/// One text that more than one item is carrying.
public struct RepeatedText: Sendable, Hashable {
  public var kind: TranscriptItemKind
  /// A digest of the normalised text; not reversible, and not a secret either.
  public var fingerprint: String
  /// Characters (UTF-16 code units) in the normalised text, which is often enough
  /// to recognise it.
  public var length: Int
  public var items: [RepeatedTextItem]

  public init(kind: TranscriptItemKind, fingerprint: String, length: Int, items: [RepeatedTextItem]) {
    self.kind = kind
    self.fingerprint = fingerprint
    self.length = length
    self.items = items
  }

  public var jsonValue: JSONValue {
    .object([
      "kind": .string(kind.rawValue),
      "fingerprint": .string(fingerprint),
      "length": .number(Double(length)),
      "items": .array(items.map(\.jsonValue))
    ])
  }
}

public struct TranscriptDiagnostics: Sendable, Hashable {
  public var items: Int
  /// Items the gateway has given a durable row id.
  public var persisted: Int
  /// Items with no row id that a re-description could still pair with — the
  /// optimistic bubble, the streaming reply, a resume projection. A number that
  /// stays above zero while nothing is running is the shape of this bug.
  public var unpaired: Int
  /// Items on screen standing in for an author a tail fetch has not named yet.
  public var placeholders: Int
  public var repeated: [RepeatedText]
  public var highestRowID: Int?
  public var lastSeq: Int
  public var lastSeqSessionID: String?
  public var epoch: String?
  public var hydration: HydrationState
  public var turnActive: Bool
  public var turnLocal: Bool
  public var foreignReconcilePending: Bool
  /// A prompt the gateway parked, if the transcript believes one is waiting.
  public var parkedPrompts: Int

  public var jsonValue: JSONValue {
    var object: JSONObject = [
      "items": .number(Double(items)),
      "persisted": .number(Double(persisted)),
      "unpaired": .number(Double(unpaired)),
      "placeholders": .number(Double(placeholders)),
      "repeated": .array(repeated.map(\.jsonValue)),
      "lastSeq": .number(Double(lastSeq)),
      "hydration": hydration.jsonValue,
      "turnActive": .bool(turnActive),
      "turnLocal": .bool(turnLocal),
      "foreignReconcilePending": .bool(foreignReconcilePending),
      "parkedPrompts": .number(Double(parkedPrompts))
    ]
    if let highestRowID { object["highestRowId"] = .number(Double(highestRowID)) }
    if let lastSeqSessionID { object["lastSeqSessionId"] = .string(lastSeqSessionID) }
    if let epoch { object["epoch"] = .string(epoch) }
    return .object(object)
  }
}

/// Items the backend never persists, so an absent row id means nothing for them.
private func isEphemeral(_ item: TranscriptItem) -> Bool {
  switch item {
  case .approval, .clarify, .status: true
  default: false
  }
}

/// FNV-1a, 32 bits, hex. Deliberately not a cryptographic hash: it is a label
/// that makes two equal strings look equal in a bug report, nothing more. Over
/// UTF-16 code units, as `charCodeAt` reads them.
public func textFingerprint(_ text: String) -> String {
  var hash: UInt32 = 0x811c_9dc5

  for unit in text.utf16 {
    hash ^= UInt32(unit)
    hash = hash &* 0x0100_0193
  }

  let hex = String(hash, radix: 16)
  return String(repeating: "0", count: 8 - hex.count) + hex
}

public func transcriptDiagnostics(_ state: ChatState) -> TranscriptDiagnostics {
  // A JavaScript `Map`: walked in insertion order.
  var repeatedKeys: [String] = []
  var byText: [String: RepeatedText] = [:]
  var persisted = 0
  var unpaired = 0
  var placeholders = 0
  var parkedPrompts = 0
  var highestRowID: Int?

  for id in state.order {
    guard let item = state.items[id] else { continue }

    if let rowID = item.rowID {
      persisted += 1
      highestRowID = max(highestRowID ?? rowID, rowID)
    } else if !isEphemeral(item) {
      unpaired += 1
    }

    if case .user(let user) = item {
      if user.unknownAuthor == true {
        placeholders += 1
      }
      if user.origin == .optimistic && user.pending == true {
        parkedPrompts += 1
      }
    }

    let text = DiagnosticsPort.normalizedItemText(item)

    if text.isEmpty {
      continue
    }

    let key = "\(item.kind.rawValue)\n\(text)"
    let entry = RepeatedTextItem(id: item.id, origin: item.origin, rowID: item.rowID, seq: item.seq)

    if byText[key] == nil {
      repeatedKeys.append(key)
      byText[key] = RepeatedText(kind: item.kind, fingerprint: textFingerprint(text), length: JS.length(text), items: [entry])
    } else {
      byText[key]!.items.append(entry)
    }
  }

  return TranscriptDiagnostics(
    items: state.order.count,
    persisted: persisted,
    unpaired: unpaired,
    placeholders: placeholders,
    repeated: repeatedKeys.compactMap { byText[$0] }.filter { $0.items.count > 1 },
    highestRowID: highestRowID,
    lastSeq: state.lastSeq,
    lastSeqSessionID: state.lastSeqSessionID,
    epoch: state.epoch,
    hydration: state.hydration,
    turnActive: state.turn.active,
    turnLocal: state.turn.local,
    foreignReconcilePending: state.turn.foreignReconcilePending == true,
    parkedPrompts: parkedPrompts
  )
}

/// One line per finding, for a screen that has no room for a table.
///
/// Written to be pasteable into a bug report as-is: it names the paths rather
/// than the content, so "two user items, one with a row id and one without,
/// same fingerprint" reads as a diagnosis. A developer's report, so English, as
/// in the TypeScript.
public func formatTranscriptDiagnostics(_ botName: String, _ state: ChatState) -> [String] {
  let report = transcriptDiagnostics(state)
  var lines = [
    "\(botName): \(report.items) items, \(report.persisted) persisted, \(report.unpaired) unpaired",
    "\(botName): \(report.hydration.rawValue), turn \(report.turnActive ? "running" : "idle")"
      + (report.turnLocal ? " (ours)" : "")
      + (report.foreignReconcilePending ? ", tail pending" : "")
      + (report.parkedPrompts != 0 ? ", \(report.parkedPrompts) parked" : "")
      + (report.placeholders != 0 ? ", \(report.placeholders) unnamed" : "")
  ]

  for entry in report.repeated {
    let place = entry.items
      .map { item in "\(item.origin.rawValue)\(item.rowID.map { "#\($0)" } ?? "")" }
      .joined(separator: " + ")

    lines.append("\(botName): \(entry.items.count)x \(entry.kind.rawValue) \(entry.fingerprint)/\(entry.length) — \(place)")
  }

  return lines
}

/// Ported from `rows-to-items.ts`, which the history task owns: the one helper
/// the diagnostics read. Namespaced so it cannot collide with that task's
/// public `normalizedItemText`; once that lands, this can call it instead.
enum DiagnosticsPort {
  /// `/\s+/gu`
  private static let whitespaceRun = JSRegExp(JSPattern.s + "+")

  /// `normalizeMatchText`: `text.replace(/\s+/gu, ' ').trim().normalize('NFC')`.
  static func normalizeMatchText(_ text: String) -> String {
    JS.trim(whitespaceRun.replaceAll(in: text, with: " ")).precomposedStringWithCanonicalMapping
  }

  /// `normalizedItemText`: a row matcher used by reconciliation, the text two
  /// transports agree on.
  static func normalizedItemText(_ item: TranscriptItem) -> String {
    let text: String
    switch item {
    case .user(let user): text = user.text
    case .assistant(let assistant): text = assistant.text
    case .botDmIn(let dm): text = dm.text
    case .notice(let notice):
      // The BODY, and the title only when there is no body.
      //
      // A notice's title is whatever the surface decided to call it, and the
      // two descriptions of one row do not have to agree on that: the gateway
      // ships its own (`display_metadata.display_text`) on the persisted row,
      // and a live projection reading the same text off `inflight` cannot know
      // it. What they always agree on is what the notice SAYS, so that is the
      // key. A notice with no body keeps the title as its only identity.
      if let body = notice.body, !JS.trimsToEmpty(body) {
        text = body
      } else {
        text = notice.title
      }
    case .status(let status): text = status.text
    case .cronDelivery(let cron):
      // Both transports parse the same header into the same name and body, so
      // this is the key that pairs a live cron card with its persisted row.
      text = "\(cron.jobName)\n\(cron.body)"
    case .botDmOut(let dm):
      // The message that was dispatched; the target is in `itemMatchKey`.
      text = dm.message
    default:
      text = ""
    }

    return normalizeMatchText(text)
  }
}
