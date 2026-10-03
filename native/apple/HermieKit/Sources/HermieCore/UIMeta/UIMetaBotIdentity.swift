import Foundation
import HermieProtocol

/// The colours a chat can be given (`ACCENT_ORDER` in the Expo app's `ui/tokens.ts`), in the order
/// the picker lists them. The raw value is the wire spelling: the bot's `hermie` section carries it
/// as `colour`, and `default` is stored as nothing.
public enum BotAccent: String, Sendable, Hashable, CaseIterable {
  case `default`
  case indigo
  case violet
  case magenta
  case red
  case orange
  case teal
  case green
  case graphite
  case slate
  case lime

  /// The solid fill, as sRGB `0xRRGGBB` (`ACCENTS[name].fill`): the swatch, the avatar ring.
  public var fillHex: UInt32 {
    switch self {
    case .default: 0x1668E3
    case .indigo: 0x4B4CC8
    case .violet: 0x7B3FC4
    case .magenta: 0xB62F81
    case .red: 0xC5303A
    case .orange: 0xB04C08
    case .teal: 0x0E7A84
    case .green: 0x16783C
    case .graphite: 0x485468
    case .slate: 0x4F6B96
    case .lime: 0xC7FF4A
    }
  }

  /// The colour white text is readable on (`ACCENTS[name].bubble`).
  public var bubbleHex: UInt32 {
    switch self {
    case .default: 0x2A72DC
    case .indigo: 0x5556CE
    case .violet: 0x8244CE
    case .magenta: 0xC0368A
    case .red: 0xCF3B44
    case .orange: 0xB8540C
    case .teal: 0x14828C
    case .green: 0x1A8043
    case .graphite: 0x54607A
    case .slate: 0x4F6B96
    case .lime: 0x4A7F15
    }
  }
}

/**
 A bot's name and colour as the person chose them, and how they are written.

 - **The label** is the app section's `labels`: bot name to the name this person gave it, at most
   `labelLimit` characters; empty is stored as nothing, so the row falls back to the gateway's
   display name and then to the handle (`setLabel` in the Expo app's `store/chat-layout.ts`).
 - **The colour** is the bot's own `hermie` section's `colour`, shared by everybody on the
   gateway; `default` is stored as nothing, and a section left holding nothing else goes
   (`UIMetaDocuments.editBot`).

 Every other field of either section is carried as it came.
 */
public enum BotIdentity {
  /// `BOT_LABEL_MAX`.
  public static let labelLimit = 64

  /// The label as it would be stored: trimmed and cut to `labelLimit`. Empty is "no label".
  public static func cleaned(label: String) -> String {
    String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(labelLimit))
  }

  /// `labels` of an app section: the non-empty strings, as they are.
  static func labels(_ value: JSONValue?) -> [String: String] {
    guard case .object(let object)? = value else {
      return [:]
    }

    return object.compactMapValues { entry in
      guard let text = entry.stringValue, !text.isEmpty else { return nil }
      return text
    }
  }

  /// The colour of a bot section, when it names one this build knows.
  static func accent(_ section: JSONObject?) -> BotAccent? {
    section?[UIMetaField.colour]?.stringValue.flatMap(BotAccent.init(rawValue:))
  }

  /// Name a bot in the person's own list; an empty name takes the label back.
  public static func setLabel(_ name: String, _ label: String, in app: inout JSONObject) {
    var labels = app[UIMetaField.labels]?.objectValue ?? [:]
    let cleaned = cleaned(label: label)

    if cleaned.isEmpty {
      labels.removeValue(forKey: name)
    } else {
      labels[name] = .string(cleaned)
    }

    app[UIMetaField.labels] = .object(labels)
  }

  /// Colour a bot's chat. `default` removes the choice.
  public static func setAccent(_ accent: BotAccent, in section: inout JSONObject) {
    if accent == .default {
      section.removeValue(forKey: UIMetaField.colour)
    } else {
      section[UIMetaField.colour] = .string(accent.rawValue)
    }
  }
}
