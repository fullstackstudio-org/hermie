import Foundation
import HermieGateway
import HermieProtocol

/// One `seen` entry: which chat a device was reading, and when (Unix seconds).
public struct PushSeenEntry: Sendable, Hashable {
  public var bot: String
  public var at: Double

  public init(bot: String, at: Double) {
    self.bot = bot
    self.at = at
  }

  /// As it goes into `push.seen`: `{bot, at}` where the gateway reads it, a bare stamp otherwise.
  public func json(perChat: Bool) -> JSONValue {
    perChat ? ["bot": .string(bot), "at": .number(at)] : .number(at)
  }
}

/**
 The push section's rows and readers, transliterated from `packages/gateway-client/src/push.ts` and
 replayed against `contract/gateway/vectors/push.json`, so this app writes and reads the rows the
 plugin and Hermie Web read and write. Plain JSON in and out, as the reference is.

 The section lives at `hermie-app[:<user>].push`: `registrations[<installation id>]` is one device's
 row, `seen[<installation id>]` its heartbeat, `perBot` the reader's per-chat overrides.
 */
public enum PushRows {
  public static let sectionVersion = 1
  public static let sectionKey = "push"
  public static let perBotKey = "perBot"
  public static let seenKey = "seen"
  public static let registrationsKey = "registrations"
  /// How long a `seen` stamp stays in the section before it is swept out.
  public static let seenTTL: Double = 86_400
  public static let relayPlatforms = ["ios", "macos"]
  /// The row field that says this installation handles clearing pushes (`clear` in the contract):
  /// `true` when it does, absent when it does not. Not part of `pushRowFor`'s reference (the vectors
  /// replay that unchanged); `PushRowWriter` adds it.
  public static let clearsKey = "clears"
  /// The row field that says this installation never shows Allow or Deny for a request that is not
  /// an approval (`requests` in the contract): `true` when it does not, absent when it does. A Web
  /// Push row gets a `confirm` or a secure input only with it. Written by `PushRowWriter` beside
  /// `clears`.
  public static let requestMethodsKey = "requestMethods"
  /// The row field that says this installation lets an urgent request (an approval, a question or a
  /// confirmation) arrive time-sensitive, so a Focus lets it through (`interruption` in the contract):
  /// `true` while "Urgent requests break through Focus" is on, absent while it is off. A sender sets
  /// the level only for a row that says it. Written by `PushRowWriter` beside `clears`.
  public static let urgentBreakthroughKey = "urgentBreakthrough"
  /// The plugin capability that says the notifier reads `{bot, at}` in `seen`.
  public static let perChatCapability = "push.seen.per_chat"
  /// The plugin capability that says the notifier can deliver to a relay row.
  public static let relayCapability = "push.relay"

  /// Every type on: what a reader who switched notifications on gets until they turn one off.
  public static var defaultTypes: JSONObject {
    Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, JSONValue.bool(true)) })
  }

  /// `pushStampOf`: epoch seconds from a millisecond clock, floored.
  public static func stamp(milliseconds: Double) -> Double {
    (milliseconds / 1000).rounded(.down)
  }

  /// `noPushTypes`.
  public static func noTypes() -> JSONObject {
    Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, JSONValue.bool(false)) })
  }

  /// `pushTypesOf`: absent or anything but `true` is off.
  public static func typesOf(_ value: JSONValue?) -> JSONObject {
    let source = value?.objectValue ?? [:]
    return Dictionary(uniqueKeysWithValues: PushContract.types.map { ($0, JSONValue.bool(source[$0] == .bool(true))) })
  }

  /// `adoptedPushTypes`: a stored boolean wins; anything else takes the default.
  public static func adoptedTypes(_ stored: JSONValue?, defaults: JSONObject) -> JSONObject {
    let source = stored?.objectValue ?? [:]

    return Dictionary(
      uniqueKeysWithValues: PushContract.types.map { type in
        if case .bool(let value)? = source[type] {
          (type, JSONValue.bool(value))
        } else {
          (type, JSONValue.bool(defaults[type] == .bool(true)))
        }
      }
    )
  }

  /// `noTypeWanted`.
  public static func noTypeWanted(_ types: JSONObject) -> Bool {
    PushContract.types.allSatisfy { types[$0] != .bool(true) }
  }

  /// `effectivePushTypes`.
  public static func effectiveTypes(_ global: JSONObject, overrides: JSONObject?) -> JSONObject {
    var out = global

    for type in PushContract.types {
      if case .bool(let value)? = overrides?[type] {
        out[type] = .bool(value)
      }
    }

    return out
  }

  /// `pushRowFor`: one device's row from a `PushRegistrationInput`.
  public static func rowFor(_ input: JSONObject) -> JSONObject {
    var row: JSONObject = [
      "v": .number(Double(sectionVersion)),
      "platform": input["platform"] ?? .null,
      "types": input["types"] ?? [:],
      "preview": input["preview"] ?? .null,
      "updatedAt": input["updatedAt"] ?? .null
    ]

    if case .string(let key)? = input["gatewayKey"], !key.isEmpty {
      row["gatewayKey"] = .string(key)
    }

    let address = input["address"]?.objectValue ?? [:]

    switch address["transport"]?.stringValue {
    case "expo":
      row["transport"] = "expo"
      row["token"] = address["token"] ?? .null
    case "webpush":
      let keys = address["keys"]?.objectValue ?? [:]
      row["transport"] = "webpush"
      row["endpoint"] = address["endpoint"] ?? .null
      row["keys"] = ["p256dh": keys["p256dh"] ?? .null, "auth": keys["auth"] ?? .null]
    case "relay":
      row["transport"] = "relay"
      row["relay"] = address["relay"] ?? .null
      row["handle"] = address["handle"] ?? .null
      row["secret"] = address["secret"] ?? .null

      if let enc = address["enc"] {
        row["enc"] = enc
      }
    default:
      break
    }

    return row
  }

  /// `pushRelayOriginOf`: https only, no credentials, nothing after the authority but one `/`.
  public static func relayOriginOf(_ value: JSONValue?) -> String {
    guard case .string(let text)? = value, !text.isEmpty, let url = WebOrigin.parse(text), url.scheme == "https",
      !url.host.isEmpty
    else {
      return ""
    }

    let spelled = text.lowercased()
    return spelled == url.origin || spelled == url.origin + "/" ? url.origin : ""
  }

  /// `pushRelayAllowed`.
  public static func relayAllowed(_ origin: JSONValue?, allowList: [JSONValue]) -> Bool {
    let wanted = relayOriginOf(origin)
    return !wanted.isEmpty && allowList.contains { relayOriginOf($0) == wanted }
  }

  /// `PUSH_RELAY_CREDENTIAL`: base64url, 1 to 200 characters.
  static func isRelayCredential(_ value: JSONValue?) -> Bool {
    guard case .string(let text)? = value else {
      return false
    }

    let scalars = text.unicodeScalars
    return (1...200).contains(scalars.count)
      && scalars.allSatisfy { ("a"..."z").contains($0) || ("A"..."Z").contains($0) || ("0"..."9").contains($0) || $0 == "-" || $0 == "_" }
  }

  private static func nonEmptyString(_ value: JSONValue?) -> Bool {
    if case .string(let text)? = value { !text.isEmpty } else { false }
  }

  /// `pushAddressOf`: the address a row names, or nil when a sender must not use it.
  public static func addressOf(_ value: JSONValue?) -> JSONObject? {
    guard case .object(let row)? = value, row["v"] == .number(Double(sectionVersion)) else {
      return nil
    }

    let hasHandle = row["handle"] != nil

    switch row["transport"]?.stringValue {
    case "expo":
      guard nonEmptyString(row["token"]), !nonEmptyString(row["endpoint"]), !hasHandle, let token = row["token"] else {
        return nil
      }

      return ["transport": "expo", "token": token]

    case "webpush":
      let keys = row["keys"]?.objectValue ?? [:]

      guard nonEmptyString(row["endpoint"]), nonEmptyString(keys["p256dh"]), nonEmptyString(keys["auth"]),
        !nonEmptyString(row["token"]), !hasHandle, let endpoint = row["endpoint"], let p256dh = keys["p256dh"],
        let auth = keys["auth"]
      else {
        return nil
      }

      return ["transport": "webpush", "endpoint": endpoint, "keys": ["p256dh": p256dh, "auth": auth]]

    case "relay":
      let relay = relayOriginOf(row["relay"])

      guard !relay.isEmpty, isRelayCredential(row["handle"]), isRelayCredential(row["secret"]), row["token"] == nil,
        row["endpoint"] == nil, let platform = row["platform"]?.stringValue, relayPlatforms.contains(platform),
        let handle = row["handle"], let secret = row["secret"]
      else {
        return nil
      }

      var address: JSONObject = ["transport": "relay", "relay": .string(relay), "handle": handle, "secret": secret]

      if let enc = row["enc"] {
        address["enc"] = enc
      }

      return address

    default:
      return nil
    }
  }

  /// `push` of a section, when it is an object.
  private static func push(of section: JSONValue?) -> JSONObject? {
    section?.objectValue?[sectionKey]?.objectValue
  }

  /// `foreignPushRows`: every other installation's row, unvalidated.
  public static func foreignRows(_ section: JSONValue?, installation: String) -> JSONObject {
    let rows = push(of: section)?[registrationsKey]?.objectValue ?? [:]
    return rows.filter { !$0.key.isEmpty && $0.key != installation && $0.value != .null }
  }

  /// `pushSeenOf`: both shapes read; anything unreadable dropped.
  public static func seenOf(_ section: JSONValue?) -> [String: PushSeenEntry] {
    let raw = push(of: section)?[seenKey]?.objectValue ?? [:]
    var out: [String: PushSeenEntry] = [:]

    for (id, value) in raw where !id.isEmpty {
      if case .number(let at) = value, at.isFinite, at > 0 {
        out[id] = PushSeenEntry(bot: "", at: at.rounded(.down))
      } else if case .object(let entry) = value, case .number(let at)? = entry["at"], at.isFinite, at > 0 {
        out[id] = PushSeenEntry(bot: entry["bot"]?.stringValue ?? "", at: at.rounded(.down))
      }
    }

    return out
  }

  /// `pushPerBotOf`.
  public static func perBotOf(_ section: JSONValue?) -> JSONObject {
    let raw = push(of: section)?[perBotKey]?.objectValue ?? [:]
    var out: JSONObject = [:]

    for (bot, value) in raw where !bot.isEmpty {
      guard case .object(let bag) = value else {
        continue
      }

      var overrides: JSONObject = [:]

      for type in PushContract.types {
        if case .bool(let flag)? = bag[type] {
          overrides[type] = .bool(flag)
        }
      }

      if !overrides.isEmpty {
        out[bot] = .object(overrides)
      }
    }

    return out
  }

  /// The `seen` map as it goes into the section: entries older than a day (or never stamped)
  /// swept, each in the shape the gateway reads.
  public static func sweptSeen(_ seen: [String: PushSeenEntry], now: Double, perChat: Bool) -> JSONObject {
    var out: JSONObject = [:]

    for (id, entry) in seen where entry.at > 0 && now - entry.at <= seenTTL {
      out[id] = entry.json(perChat: perChat)
    }

    return out
  }

  /// `pushSectionFor`: the whole section from a `PushSectionInput`, or nil when there is nothing to say.
  public static func sectionFor(_ input: JSONObject) -> JSONObject? {
    var registrations = input["others"]?.objectValue ?? [:]

    if case .object(let own)? = input["own"], case .string(let installation)? = own["installationId"], !installation.isEmpty,
      !noTypeWanted(own["types"]?.objectValue ?? [:])
    {
      registrations[installation] = .object(rowFor(own))
    }

    var seen: [String: PushSeenEntry] = [:]

    for (id, value) in input["seen"]?.objectValue ?? [:] {
      if case .object(let entry) = value, case .number(let at)? = entry["at"] {
        seen[id] = PushSeenEntry(bot: entry["bot"]?.stringValue ?? "", at: at)
      }
    }

    let sweptSeen = sweptSeen(seen, now: input["now"]?.doubleValue ?? 0, perChat: input["perChat"] == .bool(true))
    var perBot: JSONObject = [:]

    for (bot, overrides) in input["perBot"]?.objectValue ?? [:] {
      if !bot.isEmpty, case .object(let bag) = overrides, !bag.isEmpty {
        perBot[bot] = .object(bag)
      }
    }

    guard !registrations.isEmpty || !sweptSeen.isEmpty || !perBot.isEmpty else {
      return nil
    }

    var section: JSONObject = [registrationsKey: .object(registrations), seenKey: .object(sweptSeen)]

    if !perBot.isEmpty {
      section[perBotKey] = .object(perBot)
    }

    return section
  }
}
