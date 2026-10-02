import HermieProtocol

/// How a port's answer compares with the recorded one.
///
/// The contract compares canonical texts, and `JSONValue` equality is exactly that:
/// keys unordered, numbers numerically (`1` is `1.0`, `-0` is `0`). One leniency is
/// allowed and counted separately: a `null` member and an absent one compare equal
/// (the plan's "absent and null are equal"). A port that writes `null` where the
/// TypeScript omits a key, or the other way round, still passes, but the report
/// shows how many calls only passed that way, so the drift is visible.
enum GoldenCompare {
  enum Verdict: Equatable {
    case equal
    /// Equal once every `null` object member is dropped on both sides.
    case equalModuloNull
    case different([String])
  }

  static func compare(expected: JSONValue, actual: JSONValue, limit: Int = 6) -> Verdict {
    if expected == actual {
      return .equal
    }
    if strippingNullMembers(expected) == strippingNullMembers(actual) {
      return .equalModuloNull
    }
    var differences: [String] = []
    diff(strippingNullMembers(expected), strippingNullMembers(actual), path: "$", into: &differences, limit: limit)
    return .different(differences.isEmpty ? ["values differ"] : differences)
  }

  /// Every object member whose value is `null` removed, at every depth. Array
  /// elements are kept (a `null` element is a value in an array).
  static func strippingNullMembers(_ value: JSONValue) -> JSONValue {
    switch value {
    case .object(let object):
      var out: JSONObject = [:]
      out.reserveCapacity(object.count)
      for (key, member) in object where member != .null {
        out[key] = strippingNullMembers(member)
      }
      return .object(out)
    case .array(let elements):
      return .array(elements.map(strippingNullMembers))
    default:
      return value
    }
  }

  /// The first `limit` places where `actual` departs from `expected`, as
  /// `path: expected …, actual …`.
  static func diff(_ expected: JSONValue, _ actual: JSONValue, path: String, into out: inout [String], limit: Int) {
    guard out.count < limit, expected != actual else { return }

    switch (expected, actual) {
    case (.object(let left), .object(let right)):
      for key in Set(left.keys).union(right.keys).sorted() {
        guard out.count < limit else { return }
        let member = memberPath(path, key)
        switch (left[key], right[key]) {
        case (let l?, let r?): diff(l, r, path: member, into: &out, limit: limit)
        case (let l?, nil): out.append("\(member): missing, expected \(excerpt(l))")
        case (nil, let r?): out.append("\(member): unexpected \(excerpt(r))")
        case (nil, nil): break
        }
      }
    case (.array(let left), .array(let right)):
      if left.count != right.count {
        out.append("\(path): expected \(left.count) elements, actual \(right.count)")
      }
      for index in 0..<min(left.count, right.count) {
        guard out.count < limit else { return }
        diff(left[index], right[index], path: "\(path)[\(index)]", into: &out, limit: limit)
      }
    default:
      out.append("\(path): expected \(excerpt(expected)), actual \(excerpt(actual))")
    }
  }

  static func memberPath(_ path: String, _ key: String) -> String {
    let plain =
      !key.isEmpty && key.unicodeScalars.allSatisfy { $0.properties.isAlphabetic || ("0"..."9").contains($0) || $0 == "_" }
    return plain ? "\(path).\(key)" : "\(path)[\(JSONValue.string(key))]"
  }

  /// The canonical text, cut to a readable length.
  static func excerpt(_ value: JSONValue, max: Int = 240) -> String {
    let text = value.description
    guard text.count > max else { return text }
    return String(text.prefix(max)) + "… (\(text.count) characters)"
  }
}
