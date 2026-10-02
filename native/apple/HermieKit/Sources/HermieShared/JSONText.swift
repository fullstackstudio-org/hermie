import Foundation

/**
 JSON written the way `JSON.stringify` writes it: keys in the order given, compact, `/` and
 non-ASCII left alone, and numbers without a decimal point when they are whole.

 `JSONEncoder` and `JSONSerialization` order an object's keys however their dictionaries hash, so
 the same value is different bytes from one run to the next. The files in the App Group were written
 by `JSON.stringify` before this app existed, and are now written here instead; writing the same
 bytes for the same value keeps "did the file change" a byte comparison and keeps a diff of two
 snapshots readable.
 */
enum JSONText: Sendable, Equatable {
  case object([(String, JSONText)])
  case array([JSONText])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  static func == (left: JSONText, right: JSONText) -> Bool {
    left.text == right.text
  }

  var data: Data {
    Data(text.utf8)
  }

  var text: String {
    var out = ""

    write(into: &out)

    return out
  }

  private func write(into out: inout String) {
    switch self {
    case let .object(members):
      out += "{"

      for (index, member) in members.enumerated() {
        if index > 0 {
          out += ","
        }

        Self.quote(member.0, into: &out)
        out += ":"
        member.1.write(into: &out)
      }

      out += "}"
    case let .array(values):
      out += "["

      for (index, value) in values.enumerated() {
        if index > 0 {
          out += ","
        }

        value.write(into: &out)
      }

      out += "]"
    case let .string(value):
      Self.quote(value, into: &out)
    case let .number(value):
      out += Self.number(value)
    case let .bool(value):
      out += value ? "true" : "false"
    case .null:
      out += "null"
    }
  }

  /// `JSON.stringify` of a string: `"` and `\` escaped, control characters as short or `\u00xx` escapes.
  private static func quote(_ value: String, into out: inout String) {
    out += "\""

    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20:
        out += "\\u00" + String(scalar.value, radix: 16).leftPadded(to: 2)
      default:
        out.unicodeScalars.append(scalar)
      }
    }

    out += "\""
  }

  /// A JavaScript number as `String(n)`: whole numbers without a fraction, `null` for what JSON cannot say.
  private static func number(_ value: Double) -> String {
    guard value.isFinite else {
      return "null"
    }

    if value == value.rounded(), abs(value) < 9.0e15 {
      return String(Int64(value))
    }

    return value.description
  }
}

extension String {
  fileprivate func leftPadded(to width: Int) -> String {
    count >= width ? self : String(repeating: "0", count: width - count) + self
  }
}

// MARK: - The files, as JSON.stringify writes them

extension WidgetSnapshot {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [
      ("version", .number(Double(version))),
      ("generatedAt", .number(generatedAt))
    ]

    if let gatewayKey {
      members.append(("gatewayKey", .string(gatewayKey)))
    }

    members.append(("bots", .array(bots.map(\.jsonText))))
    members.append(("folders", .array((folders ?? []).map(\.jsonText))))

    return .object(members)
  }
}

extension WidgetSnapshot.Bot {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [("name", .string(name)), ("displayName", .string(displayName))]

    if let avatarPath {
      members.append(("avatarPath", .string(avatarPath)))
    }

    members += [
      ("initials", .string(initials)),
      ("colour", .string(colour)),
      ("presence", .string(presence)),
      ("lastLine", .string(lastLine)),
      ("lastAt", .number(lastAt)),
      ("unread", .number(Double(unread))),
      ("needsInput", .bool(needsInput))
    ]

    return .object(members)
  }
}

extension WidgetSnapshot.Folder {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [("id", .string(id)), ("name", .string(name))]

    if let colour {
      members.append(("colour", .string(colour)))
    }

    members += [
      ("bots", .array(bots.map(JSONText.string))),
      ("unread", .number(Double(unread))),
      ("needsInput", .number(Double(needsInput))),
      ("size", .number(Double(size)))
    ]

    return .object(members)
  }
}

extension ShareTargets {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [
      ("version", .number(Double(version))),
      ("generatedAt", .number(generatedAt))
    ]

    if let gatewayKey {
      members.append(("gatewayKey", .string(gatewayKey)))
    }

    members += [
      (
        "copy",
        .object([("sent", .string(copy.sent)), ("queued", .string(copy.queued)), ("sending", .string(copy.sending))])
      ),
      (
        "targets",
        .array(targets.map { .object([("bot", .string($0.bot)), ("session", .string($0.session))]) })
      )
    ]

    return .object(members)
  }
}

extension PendingIntent {
  var jsonText: JSONText {
    .object([
      ("version", .number(Double(version))),
      ("id", .string(id)),
      ("kind", .string(kind.rawValue)),
      ("bot", .string(bot)),
      ("text", .string(text)),
      ("createdAt", .number(createdAt))
    ])
  }
}

extension IntentResult {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [
      ("version", .number(Double(version))),
      ("id", .string(id)),
      ("ok", .bool(ok))
    ]

    if let reply {
      members.append(("reply", .string(reply)))
    }

    if let error {
      members.append(("error", .string(error)))
    }

    return .object(members)
  }
}

extension ShareDeliveryRecord {
  var jsonText: JSONText {
    .object([
      ("version", .number(Double(version))),
      ("gatewayId", .string(gatewayId)),
      ("gatewayKey", .string(gatewayKey)),
      ("baseUrl", .string(baseUrl)),
      ("authMode", .string(authMode.rawValue)),
      ("authHeader", .string(authHeader.rawValue)),
      ("token", .string(token)),
      ("expiresAt", .number(expiresAt)),
      ("headers", .object(headers.sorted { $0.key < $1.key }.map { ($0.key, .string($0.value)) }))
    ])
  }
}
