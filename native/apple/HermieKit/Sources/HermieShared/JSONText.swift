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

  /**
   A number as JavaScript's `Number.prototype.toString` writes it (ECMA-262, Number::toString),
   and `null` for what JSON cannot say.

   Both languages print the shortest digits that round-trip; they differ only in where the decimal
   point goes and when an exponent is used. So the digits and the point's position are read off
   Swift's `description`, and laid out by JavaScript's rules: plain notation from 1e-6 up to (not
   including) 1e21, an exponent outside that, `-0` as `0`.
   */
  static func number(_ value: Double) -> String {
    guard value.isFinite else {
      return "null"
    }

    if value == 0 {
      return "0"
    }

    let negative = value < 0
    let text = abs(value).description
    let parts = text.split(separator: "e", maxSplits: 1)
    let mantissa = parts[0]
    let exponent = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    let pieces = mantissa.split(separator: ".", omittingEmptySubsequences: false)
    let whole = String(pieces[0])
    let fraction = pieces.count > 1 ? String(pieces[1]) : ""
    var digits = whole + fraction
    // n: the value is 0.d1d2…dk × 10^n.
    var point = whole.count + exponent

    while digits.hasPrefix("0"), digits.count > 1 {
      digits.removeFirst()
      point -= 1
    }

    while digits.hasSuffix("0"), digits.count > 1 {
      digits.removeLast()
    }

    let count = digits.count
    let body: String

    if count <= point, point <= 21 {
      body = digits + String(repeating: "0", count: point - count)
    } else if 0 < point, point <= 21 {
      body = String(digits.prefix(point)) + "." + String(digits.dropFirst(point))
    } else if -6 < point, point <= 0 {
      body = "0." + String(repeating: "0", count: -point) + digits
    } else {
      let shown = point - 1
      let lead = String(digits.prefix(1)) + (count > 1 ? "." + String(digits.dropFirst()) : "")

      body = lead + "e" + (shown < 0 ? "-" : "+") + String(abs(shown))
    }

    return negative ? "-" + body : body
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
    ] + (gatewayKey.map { [("gatewayKey", JSONText.string($0))] } ?? []))
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

extension ShareManifest {
  /// The manifest as the share extension writes it, keys in the TypeScript order.
  public func encoded() -> Data {
    var members: [(String, JSONText)] = [
      ("version", .number(Double(version))),
      ("id", .string(id))
    ]

    if let bot {
      members.append(("bot", .string(bot)))
    }

    if let gatewayKey {
      members.append(("gatewayKey", .string(gatewayKey)))
    }

    members += [
      ("note", .string(note)),
      ("createdAt", .number(createdAt)),
      ("items", .array(items.map(\.jsonText)))
    ]

    return JSONText.object(members).data
  }
}

extension ShareItem {
  var jsonText: JSONText {
    var members: [(String, JSONText)] = [("kind", .string(kind.rawValue))]

    for (name, value) in [("path", path), ("filename", filename), ("mimeType", mimeType), ("text", text)] {
      if let value {
        members.append((name, .string(value)))
      }
    }

    if let size {
      members.append(("size", .number(Double(size))))
    }

    return .object(members)
  }
}

extension ShareClaim {
  public func encoded() -> Data {
    JSONText.object([("version", .number(Double(version))), ("bot", .string(bot)), ("at", .number(at))]).data
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
