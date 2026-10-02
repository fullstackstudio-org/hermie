/// The reader's own author id, spelled exactly the way the gateway stamps a
/// message's author (HERM-83; the port of `author-id.ts`).
///
/// The gateway builds `f"{provider.strip()}:{user_id.strip()}"`: provider
/// first, one colon, Python's `str.strip()` on each half, no case folding, and
/// no email fallback. A missing or blank half means no author id at all.
public struct OwnAuthor: Sendable, Equatable {
  public var id: String
  /// The display name, stripped; `nil` when there is none, as the gateway's `row_author` omits it.
  public var name: String?

  public init(id: String, name: String? = nil) {
    self.id = id
    self.name = name
  }

  /// `"<provider>:<user_id>"` for an `/api/auth/me` answer, or `nil` when either half is missing or blank.
  public static func authorID(provider: String?, userID: String?) -> String? {
    let provider = pythonStrip(provider ?? "")
    let userID = pythonStrip(userID ?? "")

    return provider.isEmpty || userID.isEmpty ? nil : "\(provider):\(userID)"
  }

  /// The reader's own author, in the shape a stamped row carries it.
  public static func of(provider: String?, userID: String?, displayName: String?) -> OwnAuthor? {
    guard let id = authorID(provider: provider, userID: userID) else {
      return nil
    }

    let name = pythonStrip(displayName ?? "")
    return OwnAuthor(id: id, name: name.isEmpty ? nil : name)
  }

  /// The characters Python's `str.isspace()` is true for. Not JavaScript's
  /// `trim` set and not Foundation's `.whitespacesAndNewlines`: Python strips
  /// U+001C–U+001F and U+0085 and keeps U+FEFF and U+180E.
  static func isPythonSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x1C...0x1F, 0x20, 0x85, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000:
      true
    default:
      false
    }
  }

  /// Python's `str.strip()`.
  static func pythonStrip(_ value: String) -> String {
    JSText.strip(value, where: isPythonSpace)
  }
}
