import Foundation

/**
 The small checks every surface that reads a file or a link applies to an id before using it.

 Each id here is minted by this app out of a fixed alphabet, so anything outside it did not come
 from a share sheet, a Shortcut, a widget or the folder list, and the right answer is to refuse it
 rather than to work out what it meant. The rules are the TypeScript ones, character for character.
 */
public enum Identifiers {
  /// `isSafeShareId`: `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$`. A directory name and a URL segment.
  public static func isSafeShareId(_ value: String) -> Bool {
    isSegment(value, allowingDots: true)
  }

  /// `isSafeIntentId`: the same alphabet as a share id.
  public static func isSafeIntentId(_ value: String) -> Bool {
    isSegment(value, allowingDots: true)
  }

  /// `isSafeFolderId`: `^[A-Za-z0-9_-]{1,64}$`.
  public static func isSafeFolderId(_ value: String) -> Bool {
    isSegment(value, allowingDots: false)
  }

  /// A stored session id as a link segment: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. The ids the gateway
  /// mints (a date, a time and a few hex digits) are inside it; anything else is left out of a link.
  public static func isSafeSessionId(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    guard let first = scalars.first, scalars.count <= 128,
      ("A"..."Z").contains(first) || ("a"..."z").contains(first) || ("0"..."9").contains(first)
    else {
      return false
    }

    return scalars.allSatisfy { scalar in
      ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
        || scalar == "_" || scalar == "-" || scalar == "." || scalar == ":"
    }
  }

  /// `isGatewayKey`: sixteen lowercase hex digits, what `gatewayKeyOf` produces.
  public static func isGatewayKey(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    return scalars.count == 16 && scalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
  }

  /// The longest bot name a link or a notification may name, in Unicode scalars.
  public static let maxBotNameLength = 128

  /**
   A bot name a link or a notification may select a chat by: non-empty, at most
   `maxBotNameLength` scalars, no `/`, no control or format character, and not `.` or `..`.

   The name only ever selects a chat on the roster, but it arrives from outside the app (any app
   can open a `hermie://` link; anyone who can send to this device can put one in a
   notification), so what can reach a `ChatRef` is bounded here, once, for both.
   */
  public static func isBotName(_ value: String) -> Bool {
    let scalars = value.unicodeScalars

    guard !scalars.isEmpty, scalars.count <= maxBotNameLength, value != ".", value != ".." else {
      return false
    }

    return !scalars.contains { $0 == "/" || CharacterSet.controlCharacters.contains($0) }
  }

  private static func isSegment(_ value: String, allowingDots: Bool) -> Bool {
    let scalars = Array(value.unicodeScalars)

    guard let first = scalars.first, scalars.count <= 64, first != "." else {
      return false
    }

    return scalars.allSatisfy { scalar in
      ("A"..."Z").contains(scalar) || ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
        || scalar == "_" || scalar == "-" || (allowingDots && scalar == ".")
    }
  }
}
