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

  /// `isGatewayKey`: sixteen lowercase hex digits, what `gatewayKeyOf` produces.
  public static func isGatewayKey(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)

    return scalars.count == 16 && scalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
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
