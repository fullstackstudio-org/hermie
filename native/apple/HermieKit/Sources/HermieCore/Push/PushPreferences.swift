import Foundation
import HermieProtocol

/**
 What this device asks to be told about: which kinds of notification it wants, and whether it wants
 the words of a message in them (`types` and `preview` of `store/push.ts`).

 - **Types.** Every type is on until the reader turns one off: a messenger that does not tell you about
   a message is not one, and a reader who switched notifications on and heard nothing about the turn
   that failed overnight would have no reason to suspect there was a switch for it. A type this build
   has never stored an answer for takes the default (`PushRows.adoptedTypes`), so a release that adds
   a type does not leave every existing device with it off and nothing on screen to say so. A device
   with every type off has no row on any gateway (`PushRowWriter`): nobody would send it anything.
 - **Preview.** Off. ADR-0017's payload says who and what KIND, never what was said, because it is
   rendered by Apple on a lock screen; turning that off is a decision, and the hint under the switch
   says where the text will end up. Senders ignore it for a relay row until the row carries an
   encryption key (D29), so it is written to say what the reader chose.

 Device-wide, like the switch (`StoreKeys.pushEnabled`): one set of choices for every gateway row this
 device writes, kept in `hermie.push.preferences` as `{"types": {…}, "preview": bool}`.
 */
public struct PushPreferences: Sendable, Equatable {
  /// One answer for each type of `PushContract.types`.
  public var types: JSONObject
  public var preview: Bool

  /// What a reader who has just switched notifications on gets.
  public static let standard = PushPreferences(types: PushRows.defaultTypes, preview: false)

  public init(types: JSONObject, preview: Bool) {
    self.types = types
    self.preview = preview
  }

  /// Whether this type is asked for.
  public func wants(_ type: String) -> Bool {
    types[type] == .bool(true)
  }

  /// No type is asked for: the device has no row anywhere.
  public var wantsNothing: Bool {
    PushRows.noTypeWanted(types)
  }

  /// The stored text read back, defensively: another build wrote it. A stored boolean wins, a type it
  /// never stored an answer for takes the default, anything unreadable is the standard.
  public static func decoded(_ text: String?) -> PushPreferences {
    guard let text, let value = try? JSONValue(parsing: text), case .object(let object) = value else {
      return .standard
    }

    return PushPreferences(
      types: PushRows.adoptedTypes(object["types"], defaults: PushRows.defaultTypes),
      preview: object["preview"] == .bool(true)
    )
  }

  /// The text kept in the store.
  public func encoded() -> String? {
    try? JSONValue.object(["types": .object(types), "preview": .bool(preview)]).canonicalString()
  }

  /// A copy with one type switched. A name this build does not know changes nothing.
  public func setting(_ type: String, _ on: Bool) -> PushPreferences {
    guard PushContract.types.contains(type) else {
      return self
    }

    var next = self
    next.types[type] = .bool(on)

    return next
  }
}
