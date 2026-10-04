import Foundation
import HermieGateway
import HermieProtocol

/// The structured fields of a `confirm` (`contract/confirm-passkey/README.md` §4.1), read strictly.
///
/// The key facts of the action (an amount, a recipient, a model…) are what the person confirms, and
/// at level `passkey` what the challenge commits to. A frame whose `fields` break the contract is not
/// shown in part: the whole request is refused (error 4040) and none of it is shown, because a
/// confirmation of less than the agent asked would be a confirmation of something else.
///
/// What is checked, on the raw JSON (a typed array drops an element that does not convert, and a field
/// dropped silently is a fact nobody sees): the list is 1 to 8 objects; every object has exactly the
/// keys `id`, `kind`, `label`, `value` and (only for an amount) `currency`; `id` is
/// `^[a-z][a-z0-9_]{0,31}$` and unique; `kind` is one of the seven; `label` is 1 to 40, `value` 1 to
/// 200 and `currency` 1 to 16 code points; each of the three is one line of verbatim text
/// (§6.2 of `contract/requests`: no line break, control, format, bidi or zero-width character, no
/// whitespace but U+0020, no invisible letter, no default-ignorable or unassigned code point, at most
/// 4 combining marks in a row, no run of more than 16 spaces, no space at either end).
public enum ConfirmFieldRules {
  public static let maxFields = 8
  public static let maxLabel = 40
  public static let maxValue = 200
  public static let maxCurrency = 16
  /// A run of spaces longer than this is refused (the same limit as a draft's).
  public static let maxSpaceRun = DraftText.maxSpaceRun
  public static let maxCombiningMarks = DraftText.maxCombiningMarks

  /// Why the fields are refused.
  public enum Problem: Error, Sendable, Equatable {
    /// `fields` is there but is not a list, or is an empty list.
    case notAList
    case tooMany
    case notAnObject
    /// A key the contract does not give a field, or a required one missing or not a string.
    case keys
    case id
    case idRepeated
    case kind
    case label
    case value
    case currency
  }

  /// The fields of a frame, in order: empty when it has none (an absent key; `null` is refused, §4.1 says
  /// "absent, or 1 to 8 objects"), or why the frame
  /// is refused.
  public static func read(_ raw: JSONValue?) -> Result<[ConfirmField], Problem> {
    switch raw {
    case nil:
      return .success([])
    case .array(let list)?:
      return read(list)
    default:
      return .failure(.notAList)
    }
  }

  private static func read(_ list: [JSONValue]) -> Result<[ConfirmField], Problem> {
    guard !list.isEmpty else {
      return .failure(.notAList)
    }

    guard list.count <= maxFields else {
      return .failure(.tooMany)
    }

    var fields: [ConfirmField] = []
    var seen: Set<String> = []

    for value in list {
      guard case .object(let object) = value else {
        return .failure(.notAnObject)
      }

      switch field(object) {
      case .failure(let problem):
        return .failure(problem)
      case .success(let field):
        guard seen.insert(field.id).inserted else {
          return .failure(.idRepeated)
        }

        fields.append(field)
      }
    }

    return .success(fields)
  }

  private static func field(_ object: JSONObject) -> Result<ConfirmField, Problem> {
    guard object.keys.allSatisfy({ ConfirmFieldView.knownKeys.contains($0) }) else {
      return .failure(.keys)
    }

    guard let id = object["id"]?.stringValue, let kindName = object["kind"]?.stringValue,
      let label = object["label"]?.stringValue, let value = object["value"]?.stringValue
    else {
      return .failure(.keys)
    }

    guard isID(id) else {
      return .failure(.id)
    }

    guard let kind = ConfirmFieldKind(rawValue: kindName) else {
      return .failure(.kind)
    }

    guard isLine(label, max: maxLabel) else {
      return .failure(.label)
    }

    guard isLine(value, max: maxValue) else {
      return .failure(.value)
    }

    var currency: String?

    switch object["currency"] {
    case nil, .null?:
      currency = nil
    case .string(let text)?:
      // Only an amount has one.
      guard kind == .amount, isLine(text, max: maxCurrency) else {
        return .failure(.currency)
      }

      currency = text
    default:
      return .failure(.currency)
    }

    return .success(ConfirmField(id: id, kind: kind, label: label, value: value, currency: currency))
  }

  /// `^[a-z][a-z0-9_]{0,31}$`.
  public static func isID(_ text: String) -> Bool {
    let bytes = Array(text.utf8)

    guard let first = bytes.first, bytes.count <= 32, first >= 0x61, first <= 0x7A else {
      return false
    }

    return bytes.dropFirst().allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x5F }
  }

  /// One line of verbatim text of 1 to `max` code points, as the rules above have it.
  public static func isLine(_ text: String, max: Int) -> Bool {
    let scalars = Array(text.unicodeScalars)

    guard scalars.count >= 1, scalars.count <= max, scalars.first != " ", scalars.last != " " else {
      return false
    }

    var marks = 0
    var spaces = 0

    for scalar in scalars {
      // A line feed is whitespace other than U+0020; `isNotVerbatim` leaves it to the draft's own rules.
      if scalar == "\n" || DraftText.isNotVerbatim(scalar) {
        return false
      }

      if scalar == " " {
        spaces += 1

        if spaces > maxSpaceRun {
          return false
        }
      } else {
        spaces = 0
      }

      let category = scalar.properties.generalCategory

      if category == .nonspacingMark || category == .enclosingMark {
        marks += 1

        if marks > maxCombiningMarks {
          return false
        }
      } else {
        marks = 0
      }
    }

    return true
  }
}
