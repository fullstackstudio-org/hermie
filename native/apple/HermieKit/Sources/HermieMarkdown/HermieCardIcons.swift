import Foundation

// The icons of a `hermie-cards` block: the closed vocabulary of `contract/markup/icons.json`, as the SF
// Symbol each name draws on Apple platforms.
// =====================================================================================================
//
// A card's `icon` is a NAME that resolves through this table, never a string handed to a symbol loader:
// what the view draws is `Image(systemName:)` of a literal from here, and nothing a reply wrote. A name
// that is not in the table draws the generic glyph (decision D3 of the plan: an icon is decoration, so
// a mistyped one does not cost the reader the whole picture).
//
// The table is the SF Symbol column of `icons.json` and nothing else (the web draws the `svg` column).
// `HermieCardsTests` holds the two to each other, so a name added to the contract fails there until it is
// added here.

public enum HermieCardIcons {
  /// The glyph an unknown name falls back to.
  public static let generic = "square.grid.2x2"

  /// Vocabulary name (lower case) to SF Symbol.
  public static let symbols: [String: String] = [
    "people": "person.2",
    "device": "laptopcomputer",
    "server": "server.rack",
    "database": "cylinder.split.1x2",
    "cloud": "cloud",
    "globe": "globe",
    "lock": "lock",
    "key": "key",
    "mail": "envelope",
    "calendar": "calendar",
    "clock": "clock",
    "chart": "chart.bar",
    "document": "doc.text",
    "folder": "folder",
    "code": "chevron.left.forwardslash.chevron.right",
    "terminal": "terminal",
    "gear": "gearshape",
    "bolt": "bolt",
    "flag": "flag",
    "star": "star",
    "heart": "heart",
    "check": "checkmark.circle",
    "warning": "exclamationmark.triangle",
    "question": "questionmark.circle",
    "pin": "mappin",
    "map": "map",
    "car": "car",
    "home": "house",
    "shop": "storefront",
    "money": "eurosign.circle",
    "cart": "cart",
    "bell": "bell",
    "camera": "camera",
    "image": "photo",
    "music": "music.note",
    "phone": "phone",
    "chat": "bubble.left",
    "link": "link",
    "search": "magnifyingglass",
    "filter": "line.3.horizontal.decrease",
    "tag": "tag",
    "box": "shippingbox",
    "truck": "truck.box",
    "plane": "airplane",
    "leaf": "leaf",
    "flame": "flame",
    "sun": "sun.max",
    "moon": "moon"
  ]

  /// The names a card may use, lower case.
  public static var names: Set<String> { Set(symbols.keys) }

  /// The SF Symbol for the icon of a validated card: the vocabulary's for its name, the generic one for
  /// `generic` or anything else.
  public static func symbol(for name: String) -> String {
    symbols[name] ?? generic
  }
}
