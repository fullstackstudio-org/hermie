import Foundation

// `hermie-cards`: a stack or a grid of cards a bot returns, drawn as a picture
// ============================================================================
//
// A reply carries a set of cards as a fenced block whose language is `hermie-cards` and whose body is one
// JSON object (an icon, a title, a subtitle, tags, one highlighted card, labelled connectors):
//
//     {"title": "How I would set it up", "layout": "stack", "connector": "arrow",
//      "cards": [{"icon": "server", "title": "Gateway", "tags": ["k3s"], "highlight": true, "next": "deploys to"},
//                {"icon": "globe", "title": "Website"}]}
//
// The definition is `contract/markup/` (`README.md` section 3 is the order this validator works in,
// `examples.json` the cases it is held to, `cards.schema.json` the caps), and `native/web/src/markdown/
// markup/cards-spec.ts` is the validator of the web client: the two make the same decision on every block.
//
// The rule is the one the chart and the Mermaid blocks follow: a block that is not exactly what the format
// says is NOT drawn, and the caller shows it as the code block it is, never repaired. The one lenient field
// is the icon name (decision D3): an icon is decoration, so a name outside the vocabulary draws the generic
// glyph instead of refusing a picture over an ornament.
//
// Pure and total: no SwiftUI, never traps. The renderer is `HermieCardsView.swift`.

/// How the cards are laid out.
public enum HermieCardsLayout: String, Sendable, Hashable, CaseIterable {
  /// One card under the other, joined by connectors.
  case stack
  /// Cards side by side, wrapping.
  case grid
}

/// What joins a card to the next one in a stack.
public enum HermieCardsConnector: String, Sendable, Hashable, CaseIterable {
  case arrow
  case line
  case none
}

/// One card of a block that passed validation.
public struct HermieCard: Sendable, Hashable {
  public var title: String
  public var subtitle: String?
  /// A vocabulary name (lower case), or `generic`. `nil`: no glyph.
  public var icon: String?
  public var tags: [String]
  public var highlight: Bool
  /// The label on the connector to the next card.
  public var next: String?

  public init(
    title: String, subtitle: String? = nil, icon: String? = nil, tags: [String] = [], highlight: Bool = false,
    next: String? = nil
  ) {
    self.title = title
    self.subtitle = subtitle
    self.icon = icon
    self.tags = tags
    self.highlight = highlight
    self.next = next
  }
}

/// A set of cards that passed validation: the normal form of `contract/markup/examples.json` (`expect`).
/// Every field is within the limits of `HermieCardsLimits`.
public struct HermieCardsSpec: Sendable, Hashable {
  public var title: String?
  public var layout: HermieCardsLayout
  /// `nil` with a grid.
  public var connector: HermieCardsConnector?
  public var cards: [HermieCard]

  public init(
    title: String? = nil, layout: HermieCardsLayout = .stack, connector: HermieCardsConnector? = nil,
    cards: [HermieCard]
  ) {
    self.title = title
    self.layout = layout
    self.connector = connector
    self.cards = cards
  }
}

/// The caps (`contract/markup/examples.json` `limits`, `cards.schema.json`).
public enum HermieCardsLimits {
  /// The block's text, in UTF-8 bytes. Checked before anything is parsed.
  public static let maxSourceBytes = 16 * 1024
  public static let minCards = 2
  public static let maxCards = 12
  public static let maxTitleLength = 120
  public static let maxCardTitleLength = 60
  public static let maxSubtitleLength = 140
  public static let maxTags = 6
  public static let maxTagLength = 24
  public static let maxNextLength = 40
  public static let maxIconLength = 32
}

/// Why a block is not a set of cards. Each case is one rule of the format (`contract/markup/README.md`
/// section 3), named as `examples.json` names it, so a test can say which rule an example breaks.
public enum HermieCardsError: Error, Sendable, Hashable {
  case tooLarge
  case notJSON
  case notAnObject
  case unknownKey(String)
  case missing(String)
  case wrongType(String)
  case unknownLayout(String)
  case unknownConnector(String)
  case connectorNeedsStack
  case tooFewCards
  case tooManyCards
  case labelTooLong(String)
  case emptyLabel(String)
  case tooManyTags
  case duplicateTag(String)
  case twoHighlights
  case nextOnLastCard
  case nextNeedsStack

  /// The rule's name as `examples.json` writes it.
  public var rule: String {
    switch self {
    case .tooLarge: "tooLarge"
    case .notJSON: "notJSON"
    case .notAnObject: "notAnObject"
    case .unknownKey: "unknownKey"
    case .missing: "missing"
    case .wrongType: "wrongType"
    case .unknownLayout: "unknownLayout"
    case .unknownConnector: "unknownConnector"
    case .connectorNeedsStack: "connectorNeedsStack"
    case .tooFewCards: "tooFewCards"
    case .tooManyCards: "tooManyCards"
    case .labelTooLong: "labelTooLong"
    case .emptyLabel: "emptyLabel"
    case .tooManyTags: "tooManyTags"
    case .duplicateTag: "duplicateTag"
    case .twoHighlights: "twoHighlights"
    case .nextOnLastCard: "nextOnLastCard"
    case .nextNeedsStack: "nextNeedsStack"
    }
  }

  /// The key (or the unknown value, or the duplicate tag) the rule is about, where it has one.
  public var key: String? {
    switch self {
    case .unknownKey(let key), .missing(let key), .wrongType(let key), .unknownLayout(let key),
      .unknownConnector(let key), .labelTooLong(let key), .emptyLabel(let key), .duplicateTag(let key):
      key
    default:
      nil
    }
  }
}

/// What the markdown renderer does with a fenced block.
public enum HermieCardsDecision: Sendable, Hashable {
  /// Draw this.
  case cards(HermieCardsSpec)
  /// Show it as the code block it is: not a cards fence, or a cards fence that is not valid.
  case code
}

public enum HermieCards {
  /// The fence's language.
  public static let fenceLanguage = "hermie-cards"

  /// Whether a fence's language names a cards block. Case does not matter: models capitalise.
  public static func isCardsFence(language: String?) -> Bool {
    language?.lowercased() == fenceLanguage
  }

  /// The one decision the renderer makes: the cards when the fence is a cards fence and its body validates,
  /// the code block it came from otherwise.
  public static func decide(language: String?, source: String) -> HermieCardsDecision {
    guard isCardsFence(language: language), let spec = try? parse(source).get() else {
      return .code
    }

    return .cards(spec)
  }

  /// Validate a block's body.
  public static func parse(_ source: String) -> Result<HermieCardsSpec, HermieCardsError> {
    do {
      return .success(try validated(source))
    } catch let error as HermieCardsError {
      return .failure(error)
    } catch {
      return .failure(.notJSON)
    }
  }

  // MARK: Validation

  private typealias Object = [String: StrictJSON.Value]

  private static let topLevelKeys: Set<String> = ["title", "layout", "connector", "cards"]
  private static let cardKeys: Set<String> = ["title", "subtitle", "icon", "tags", "highlight", "next"]

  private static func validated(_ source: String) throws -> HermieCardsSpec {
    guard source.utf8.count <= HermieCardsLimits.maxSourceBytes else {
      throw HermieCardsError.tooLarge
    }

    guard let parsed = StrictJSON.parse(source) else {
      throw HermieCardsError.notJSON
    }

    guard case .object(let object) = parsed else {
      throw HermieCardsError.notAnObject
    }

    if let unknown = firstUnknownKey(object, known: topLevelKeys) {
      throw HermieCardsError.unknownKey(unknown)
    }

    let layoutName = try choice(
      object["layout"], key: "layout", allowed: HermieCardsLayout.allCases.map(\.rawValue)
    ) { .unknownLayout($0) }
    let connectorName = try choice(
      object["connector"], key: "connector", allowed: HermieCardsConnector.allCases.map(\.rawValue)
    ) { .unknownConnector($0) }
    let layout = layoutName.flatMap(HermieCardsLayout.init(rawValue:)) ?? .stack
    let connector = connectorName.flatMap(HermieCardsConnector.init(rawValue:))

    if layout == .grid, connector != nil {
      throw HermieCardsError.connectorNeedsStack
    }

    let title = try optionalText(object["title"], key: "title", limit: HermieCardsLimits.maxTitleLength)

    guard let rawCards = object["cards"], rawCards != .null else {
      throw HermieCardsError.missing("cards")
    }

    guard case .array(let list) = rawCards else {
      throw HermieCardsError.wrongType("cards")
    }

    // Counted before any card is read.
    guard list.count >= HermieCardsLimits.minCards else {
      throw HermieCardsError.tooFewCards
    }

    guard list.count <= HermieCardsLimits.maxCards else {
      throw HermieCardsError.tooManyCards
    }

    let cards = try list.map(card)

    if cards.filter(\.highlight).count > 1 {
      throw HermieCardsError.twoHighlights
    }

    if cards.last?.next != nil {
      throw HermieCardsError.nextOnLastCard
    }

    if layout == .grid, cards.contains(where: { $0.next != nil }) {
      throw HermieCardsError.nextNeedsStack
    }

    return HermieCardsSpec(
      title: title, layout: layout, connector: layout == .grid ? nil : (connector ?? .arrow), cards: cards)
  }

  private static func firstUnknownKey(_ object: Object, known: Set<String>) -> String? {
    object.keys.filter { !known.contains($0) }.sorted().first
  }

  /// One of a few words. Absent or `null` is the default; a non-string is `wrongType`, any other word is the
  /// rule's own error (with the value as its key).
  private static func choice(
    _ value: StrictJSON.Value?, key: String, allowed: [String], unknown: (String) -> HermieCardsError
  ) throws -> String? {
    guard let value, value != .null else {
      return nil
    }

    guard case .string(let word) = value else {
      throw HermieCardsError.wrongType(key)
    }

    guard allowed.contains(word) else {
      throw unknown(word)
    }

    return word
  }

  /// A string, trimmed. Absent or `null` is none; an empty one is none too.
  private static func optionalText(_ value: StrictJSON.Value?, key: String, limit: Int) throws -> String? {
    guard let value, value != .null else {
      return nil
    }

    guard case .string(let text) = value else {
      throw HermieCardsError.wrongType(key)
    }

    let trimmed = jsTrim(text)

    guard trimmed.count <= limit else {
      throw HermieCardsError.labelTooLong(key)
    }

    return trimmed.isEmpty ? nil : trimmed
  }

  private static func card(_ item: StrictJSON.Value) throws -> HermieCard {
    guard case .object(let object) = item else {
      throw HermieCardsError.wrongType("cards")
    }

    if let unknown = firstUnknownKey(object, known: cardKeys) {
      throw HermieCardsError.unknownKey(unknown)
    }

    guard let rawTitle = object["title"], rawTitle != .null else {
      throw HermieCardsError.missing("title")
    }

    guard case .string(let titleText) = rawTitle else {
      throw HermieCardsError.wrongType("title")
    }

    let title = jsTrim(titleText)

    guard !title.isEmpty else {
      throw HermieCardsError.emptyLabel("title")
    }

    guard title.count <= HermieCardsLimits.maxCardTitleLength else {
      throw HermieCardsError.labelTooLong("title")
    }

    let subtitle = try optionalText(object["subtitle"], key: "subtitle", limit: HermieCardsLimits.maxSubtitleLength)
    let iconName = try optionalText(object["icon"], key: "icon", limit: HermieCardsLimits.maxIconLength)
    let tags = try tagList(object["tags"])
    let next = try optionalText(object["next"], key: "next", limit: HermieCardsLimits.maxNextLength)
    let highlight = try boolean(object["highlight"], key: "highlight")

    let icon = iconName.map { name -> String in
      let lowered = name.lowercased()
      return HermieCardIcons.symbols[lowered] != nil ? lowered : "generic"
    }

    return HermieCard(title: title, subtitle: subtitle, icon: icon, tags: tags, highlight: highlight, next: next)
  }

  private static func tagList(_ value: StrictJSON.Value?) throws -> [String] {
    guard let value, value != .null else {
      return []
    }

    guard case .array(let list) = value else {
      throw HermieCardsError.wrongType("tags")
    }

    // Counted before any tag is read.
    guard list.count <= HermieCardsLimits.maxTags else {
      throw HermieCardsError.tooManyTags
    }

    var seen = Set<String>()
    var tags: [String] = []

    for item in list {
      guard case .string(let text) = item else {
        throw HermieCardsError.wrongType("tags")
      }

      let tag = jsTrim(text)

      guard !tag.isEmpty else {
        throw HermieCardsError.emptyLabel("tags")
      }

      guard tag.count <= HermieCardsLimits.maxTagLength else {
        throw HermieCardsError.labelTooLong("tags")
      }

      // Case counts as a difference: `api` and `API` are two tags.
      guard seen.insert(tag).inserted else {
        throw HermieCardsError.duplicateTag(tag)
      }

      tags.append(tag)
    }

    return tags
  }

  /// A JSON boolean, or none. `1` and `"yes"` are not booleans.
  private static func boolean(_ value: StrictJSON.Value?, key: String) throws -> Bool {
    guard let value, value != .null else {
      return false
    }

    guard case .bool(let flag) = value else {
      throw HermieCardsError.wrongType(key)
    }

    return flag
  }

  // MARK: Words

  /// `String.prototype.trim` as the web validator has it: the ECMAScript white space and line terminators
  /// (so a byte order mark goes, and a next-line control does not), on both ends.
  static func jsTrim(_ text: String) -> String {
    let scalars = text.unicodeScalars
    guard let first = scalars.firstIndex(where: { !isJSSpace($0) }) else {
      return ""
    }
    let last = scalars.lastIndex(where: { !isJSSpace($0) }) ?? first
    return String(scalars[first...last])
  }

  private static func isJSSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
      return true
    case 0x2000...0x200A:
      return true
    default:
      return false
    }
  }
}

/// What a card is read as, with the fragments' wording supplied by the caller (so a language can order the
/// sentence its own way). The same sentence as the web client's `cardSpeech`.
public enum HermieCardsSpeech {
  public struct Words: Sendable {
    /// "Card {position} of {total}, {title}"
    public var card: @Sendable (Int, Int, String) -> String
    /// "highlighted"
    public var highlighted: String
    /// "tags {tags}"
    public var tags: @Sendable (String) -> String
    /// "then: {label}"
    public var then: @Sendable (String) -> String

    public init(
      card: @escaping @Sendable (Int, Int, String) -> String,
      highlighted: String,
      tags: @escaping @Sendable (String) -> String,
      then: @escaping @Sendable (String) -> String
    ) {
      self.card = card
      self.highlighted = highlighted
      self.tags = tags
      self.then = then
    }
  }

  /// One card as a screen reader says it: "Card 2 of 5, Gateway, k3s, highlighted, tags k3s, Postgres, then:
  /// deploys to". The connector's label is part of the card it leaves, so the connectors need no element of
  /// their own. Empty for an index outside the cards.
  public static func sentence(_ spec: HermieCardsSpec, index: Int, words: Words) -> String {
    guard spec.cards.indices.contains(index) else {
      return ""
    }

    let card = spec.cards[index]
    var parts = [words.card(index + 1, spec.cards.count, card.title)]

    if let subtitle = card.subtitle {
      parts.append(subtitle)
    }

    if card.highlight {
      parts.append(words.highlighted)
    }

    if !card.tags.isEmpty {
      parts.append(words.tags(card.tags.joined(separator: ", ")))
    }

    if let next = card.next {
      parts.append(words.then(next))
    }

    return parts.joined(separator: ", ")
  }
}
