import HermieProtocol

/// A stamped author as a row carries it: the person, and `via` when an agent sent the row for
/// them (`display_metadata.author`, and `replayed_by` the same). The port of `authorViaOf` and
/// `authorStampOf` of `@hermie/gateway-client`, and the same rule `HermieTranscript` applies to a
/// history row; `contract/gateway/mcp.md` is the contract.
///
/// Namespaced under this type because `HermieTranscript` has its own `AuthorVia` (the targets
/// may not import each other, and `HermieCore` imports both).
public struct AuthorStamp: Sendable, Equatable {
  /// What sent a row on somebody's behalf.
  public struct Via: Sendable, Equatable {
    public var kind: String
    public var client: String

    public init(kind: String, client: String) {
      self.kind = kind
      self.client = client
    }
  }

  public var id: String
  public var name: String?
  public var via: Via?

  public init(id: String, name: String? = nil, via: Via? = nil) {
    self.id = id
    self.name = name
    self.via = via
  }

  /// The longest client name carried, in code points: the gateway cleans to the same cap.
  public static let clientLimit = 80

  /// One line of plain text: format characters (`Cf`) gone, other controls and line or
  /// paragraph separators a space, whitespace collapsed and trimmed, held to the limit.
  static func cleanClient(_ value: String) -> String {
    var collapsed: [Unicode.Scalar] = []
    var inRun = false

    for scalar in value.unicodeScalars {
      let category = scalar.properties.generalCategory

      if category == .format {
        continue
      }

      if category == .control || category == .lineSeparator || category == .paragraphSeparator
        || JSText.isWhitespace(scalar)
      {
        inRun = true
        continue
      }

      if inRun {
        collapsed.append(" ")
        inRun = false
      }

      collapsed.append(scalar)
    }

    // A run at either end left one space: the trim takes it.
    let text = JSText.trim(JSText.string(collapsed))
    return JSText.trim(JSText.string(text.unicodeScalars.prefix(clientLimit)))
  }

  /// `via` out of an author object: a non-empty string `kind` and a `client` that is a non-empty
  /// string once cleaned. Keys it does not know are ignored; any other shape is no `via` at all.
  public static func via(of value: JSONValue?) -> Via? {
    guard case .object(let object)? = value,
      case .string(let kind)? = object["kind"], !JSText.trim(kind).isEmpty,
      case .string(let client)? = object["client"]
    else {
      return nil
    }

    let cleaned = cleanClient(client)
    return cleaned.isEmpty ? nil : Via(kind: JSText.trim(kind), client: cleaned)
  }

  /// A stamped author out of an untrusted value: a non-empty string `id`, a string `name` when
  /// there is one, and `via` when it is well formed. A value without a usable `id`, or with a
  /// `name` of another type, is no author (never half of one); an unusable `via` costs the marker
  /// only, and unknown keys are ignored.
  public static func of(_ value: JSONValue?) -> AuthorStamp? {
    guard case .object(let object)? = value, case .string(let id)? = object["id"], !id.isEmpty else {
      return nil
    }

    var name: String?

    switch object["name"] {
    case nil:
      break
    case .string(let text)?:
      name = text.isEmpty ? nil : text
    default:
      return nil
    }

    return AuthorStamp(id: id, name: name, via: via(of: object["via"]))
  }
}
