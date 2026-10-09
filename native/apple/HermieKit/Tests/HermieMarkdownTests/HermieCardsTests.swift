import Foundation
import Testing

@testable import HermieMarkdown

/// `hermie-cards`, held to the contract (`contract/markup/`): every valid example comes out as its normal
/// form, every invalid one is refused for the rule it names (and the key it names), the limits are the
/// schema's, and the icon table is the contract's. The web validator is held to the same file
/// (`native/web/src/markdown/markup/cards-spec.test.ts`), so the two make one decision.
@Suite("hermie-cards: the block format") struct HermieCardsTests {
  // MARK: The contract's own examples

  private static let markupDirectory: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("contract/markup")
  }()

  private static func contract(_ name: String) -> [String: Any] {
    guard let data = try? Data(contentsOf: markupDirectory.appendingPathComponent(name)),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      preconditionFailure("contract/markup/\(name) is not readable")
    }
    return json
  }

  nonisolated(unsafe) static let examples = contract("examples.json")
  nonisolated(unsafe) static let icons = contract("icons.json")
  nonisolated(unsafe) static let schema = contract("cards.schema.json")

  private static var cardsExamples: [String: Any] { examples["cards"] as? [String: Any] ?? [:] }
  static var valid: [[String: Any]] { cardsExamples["valid"] as? [[String: Any]] ?? [] }
  static var invalid: [[String: Any]] { cardsExamples["invalid"] as? [[String: Any]] ?? [] }
  static var limits: [String: Int] { examples["limits"] as? [String: Int] ?? [:] }

  /// The block's text as an example gives it: the text itself, or an object written out, padded to a size.
  static func text(of entry: [String: Any]) -> String {
    var text: String
    if let source = entry["source"] as? String {
      text = source
    } else if let block = entry["block"],
      let data = try? JSONSerialization.data(withJSONObject: block, options: [.fragmentsAllowed]),
      let written = String(data: data, encoding: .utf8)
    {
      text = written
    } else {
      preconditionFailure("an example with neither a source nor a block")
    }

    if let size = entry["padTo"] as? Int {
      text += String(repeating: " ", count: max(0, size - text.utf8.count))
    }

    return text
  }

  /// A spec as the contract writes its normal form.
  private static func normalForm(_ spec: HermieCardsSpec) -> NSDictionary {
    var object: [String: Any] = ["layout": spec.layout.rawValue]
    if let title = spec.title { object["title"] = title }
    if let connector = spec.connector { object["connector"] = connector.rawValue }
    object["cards"] = spec.cards.map { card -> [String: Any] in
      var entry: [String: Any] = ["title": card.title, "tags": card.tags, "highlight": card.highlight]
      if let subtitle = card.subtitle { entry["subtitle"] = subtitle }
      if let icon = card.icon { entry["icon"] = icon }
      if let next = card.next { entry["next"] = next }
      return entry
    }
    return object as NSDictionary
  }

  // MARK: Limits

  @Test func theLimitsAreTheContractsAndTheSchemas() throws {
    #expect(Self.limits["maxSourceBytes"] == HermieCardsLimits.maxSourceBytes)
    #expect(Self.limits["minCards"] == HermieCardsLimits.minCards)
    #expect(Self.limits["maxCards"] == HermieCardsLimits.maxCards)
    #expect(Self.limits["maxTitleLength"] == HermieCardsLimits.maxTitleLength)
    #expect(Self.limits["maxCardTitleLength"] == HermieCardsLimits.maxCardTitleLength)
    #expect(Self.limits["maxSubtitleLength"] == HermieCardsLimits.maxSubtitleLength)
    #expect(Self.limits["maxTags"] == HermieCardsLimits.maxTags)
    #expect(Self.limits["maxTagLength"] == HermieCardsLimits.maxTagLength)
    #expect(Self.limits["maxNextLength"] == HermieCardsLimits.maxNextLength)
    #expect(Self.limits["maxIconLength"] == HermieCardsLimits.maxIconLength)
    #expect(Self.limits.count == 10, "a limit the contract adds needs a constant here")

    let properties = try #require(Self.schema["properties"] as? [String: Any])
    let defs = try #require(Self.schema["$defs"] as? [String: Any])
    let card = try #require((defs["card"] as? [String: Any])?["properties"] as? [String: Any])
    func number(_ object: Any?, _ key: String) -> Int? { (object as? [String: Any])?[key] as? Int }

    #expect(number(properties["title"], "maxLength") == HermieCardsLimits.maxTitleLength)
    #expect(number(properties["cards"], "minItems") == HermieCardsLimits.minCards)
    #expect(number(properties["cards"], "maxItems") == HermieCardsLimits.maxCards)
    #expect(number(card["title"], "maxLength") == HermieCardsLimits.maxCardTitleLength)
    #expect(number(card["subtitle"], "maxLength") == HermieCardsLimits.maxSubtitleLength)
    #expect(number(card["icon"], "maxLength") == HermieCardsLimits.maxIconLength)
    #expect(number(card["tags"], "maxItems") == HermieCardsLimits.maxTags)
    #expect(number(card["next"], "maxLength") == HermieCardsLimits.maxNextLength)
  }

  @Test func theContractHasAsManyExamplesAsThePlanAsksFor() {
    #expect(Self.valid.count >= 8)
    #expect(Self.invalid.count >= 12)
  }

  // MARK: Every example

  @Test func everyValidExampleComesOutAsItsNormalForm() throws {
    for example in Self.valid {
      let name = example["name"] as? String ?? "?"
      let source = Self.text(of: example)

      switch HermieCards.parse(source) {
      case .success(let spec):
        let expected = example["expect"] as? NSDictionary
        #expect(Self.normalForm(spec) == expected, "\(name)")
        #expect(HermieCards.decide(language: "hermie-cards", source: source) == .cards(spec), "\(name)")
      case .failure(let error):
        Issue.record("\(name): refused as \(error)")
      }
    }
  }

  @Test func everyInvalidExampleIsRefusedForTheRuleAndTheKeyItNames() {
    for example in Self.invalid {
      let name = example["name"] as? String ?? "?"
      let source = Self.text(of: example)

      switch HermieCards.parse(source) {
      case .success:
        Issue.record("\(name): was accepted")
      case .failure(let error):
        #expect(error.rule == example["rule"] as? String, "\(name): refused as \(error)")
        #expect(error.key == example["key"] as? String, "\(name): refused for the key \(error.key ?? "none")")
      }

      #expect(HermieCards.decide(language: "hermie-cards", source: source) == .code, "\(name)")
    }
  }

  @Test func theInvalidExamplesNameEveryRuleOfTheFormat() {
    let named = Set(Self.invalid.compactMap { $0["rule"] as? String })
    let every = [
      "tooLarge", "notJSON", "notAnObject", "unknownKey", "missing", "wrongType", "unknownLayout",
      "unknownConnector", "connectorNeedsStack", "tooFewCards", "tooManyCards", "labelTooLong", "emptyLabel",
      "tooManyTags", "duplicateTag", "twoHighlights", "nextOnLastCard", "nextNeedsStack"
    ]

    for rule in every {
      #expect(named.contains(rule), "\(rule)")
    }
  }

  // MARK: The decision

  @Test func aCardsFenceThatValidatesIsCardsInAnyCase() {
    let block = #"{"cards":[{"title":"A"},{"title":"B"}]}"#

    guard case .cards(let spec) = HermieCards.decide(language: "hermie-cards", source: block) else {
      Issue.record("not cards")
      return
    }
    #expect(spec.cards.map(\.title) == ["A", "B"])

    if case .cards = HermieCards.decide(language: "Hermie-Cards", source: block) {} else {
      Issue.record("a capitalised fence is cards too")
    }
  }

  @Test func anotherLanguageNoLanguageAndAnInvalidBlockStayCode() {
    let block = #"{"cards":[{"title":"A"},{"title":"B"}]}"#

    #expect(HermieCards.decide(language: "json", source: block) == .code)
    #expect(HermieCards.decide(language: nil, source: block) == .code)
    #expect(HermieCards.decide(language: "hermie-chart", source: block) == .code)
    #expect(HermieCards.decide(language: "hermie-cards", source: #"{"cards":[]}"#) == .code)
    #expect(HermieCards.decide(language: "hermie-cards", source: block + "x") == .code)
    #expect(HermieCards.decide(language: "hermie-cards", source: #"{"cards":[{"title":"A"},"#) == .code, "still streaming")
  }

  // MARK: Rules the examples do not pin to a single byte

  @Test func aBooleanIsNotANumberAndANumberIsNotABoolean() {
    let flag: (String) -> HermieCardsError? = { value in
      if case .failure(let error) = HermieCards.parse(
        #"{"cards":[{"title":"A","highlight":\#(value)},{"title":"B"}]}"#)
      {
        return error
      }
      return nil
    }

    #expect(flag("true") == nil && flag("false") == nil && flag("null") == nil)
    #expect(flag("1") == .wrongType("highlight"))
    #expect(flag("0") == .wrongType("highlight"))
    #expect(flag("\"true\"") == .wrongType("highlight"))
  }

  @Test func aNumberIsNeverTurnedIntoAString() {
    for source in [
      #"{"title":1,"cards":[{"title":"A"},{"title":"B"}]}"#,
      #"{"cards":[{"title":true},{"title":"B"}]}"#,
      #"{"cards":[{"title":"A","subtitle":2},{"title":"B"}]}"#,
      #"{"cards":[{"title":"A","next":3},{"title":"B"}]}"#,
      #"{"cards":[{"title":"A","tags":[true]},{"title":"B"}]}"#,
      #"{"layout":true,"cards":[{"title":"A"},{"title":"B"}]}"#,
      #"{"connector":0,"cards":[{"title":"A"},{"title":"B"}]}"#
    ] {
      #expect(HermieCards.decide(language: "hermie-cards", source: source) == .code, "\(source)")
    }
  }

  @Test func theIconNameIsMatchedWithoutRegardToCaseAndAnythingElseIsTheGenericGlyph() throws {
    let spec = try HermieCards.parse(
      #"{"cards":[{"title":"A","icon":"SERVER"},{"title":"B","icon":"rocket"},{"title":"C"}]}"#
    ).get()

    #expect(spec.cards.map(\.icon) == ["server", "generic", nil])
    #expect(HermieCardIcons.symbol(for: "server") == "server.rack")
    #expect(HermieCardIcons.symbol(for: "generic") == HermieCardIcons.generic)
    #expect(HermieCardIcons.symbol(for: "rocket") == HermieCardIcons.generic)
  }

  @Test func theBlockTextIsMeasuredInBytesBeforeItIsParsed() {
    let atTheCap = String(repeating: " ", count: HermieCardsLimits.maxSourceBytes - 2) + "{}"
    let overTheCap = " " + atTheCap

    // At the cap it gets as far as the rules (an empty object has no cards); over it, it never does.
    #expect(HermieCards.parse(atTheCap) == .failure(.missing("cards")))
    #expect(HermieCards.parse(overTheCap) == .failure(.tooLarge))
    // A multi-byte character counts every byte: 8192 two-byte letters are 16384 bytes, one more is over.
    let wide = String(repeating: "é", count: HermieCardsLimits.maxSourceBytes / 2)
    #expect(HermieCards.parse(wide + " ") == .failure(.tooLarge))
  }

  @Test func theWhiteSpaceThatIsTrimmedIsEcmaScriptsNotFoundations() throws {
    // A byte order mark is white space to `String.prototype.trim` (so the web client trims it), and a
    // next-line control is not.
    let spec = try HermieCards.parse("{\"cards\":[{\"title\":\"\u{FEFF}A\u{FEFF}\"},{\"title\":\"B\"}]}").get()
    #expect(spec.cards[0].title == "A")
    #expect(HermieCards.jsTrim("\u{85}x") == "\u{85}x")
    #expect(HermieCards.jsTrim("\u{3000}\u{2003} x y \u{A0}\n") == "x y")
    #expect(HermieCards.jsTrim(" \t\n") == "")
  }

  // MARK: The reader is as strict as JSON.parse

  @Test func theReaderRefusesWhatJSONParseRefuses() {
    for text in [
      "{\"a\":[1,2,],}", "[1,]", "{\"a\":1,}", "[NaN]", "[Infinity]", "[01]", "[1.]", "[.5]", "[+1]", "// c\n[1]",
      "/* c */[1]", "['a']", "{a:1}", "[\"a\tb\"]", "[\"\\x41\"]", "[1] x", "[1][2]", "{\"a\":1}{", "\u{FEFF}[1]",
      "[\"a\u{0}b\"]", "[-]", "[1e]", "\u{A0}[1]", "[tru]", "{\"a\" 1}", "{\"a\":}", "[,1]", "{,}", "\"unterminated"
    ] {
      #expect(StrictJSON.parse(text) == nil, "\(text.debugDescription)")
    }
  }

  @Test func theReaderReadsWhatJSONParseReads() {
    #expect(StrictJSON.parse(" \t\r\n[1, -2.5e+3 ,true,false,null,\"x\"]\n") != nil)
    #expect(StrictJSON.parse("{}") == .object([:]))
    #expect(StrictJSON.parse("[]") == .array([]))
    #expect(StrictJSON.parse("\"\\u00e9\\n\\/\"") == .string("é\n/"))
    #expect(StrictJSON.parse("\"\\ud83d\\ude00\"") == .string("😀"), "a surrogate pair is one scalar")
    #expect(StrictJSON.parse("\"\\ud800\"") == .string("\u{FFFD}"), "a lone surrogate is a replacement glyph")
    #expect(StrictJSON.parse("-0") == .number(-0))
    #expect(StrictJSON.parse("1e999") == .number(.infinity))
  }

  @Test func aRepeatedKeyKeepsTheLastValueAsJSONParseDoes() throws {
    let spec = try HermieCards.parse(
      #"{"cards":[{"title":"A","title":"Last"},{"title":"B"}]}"#
    ).get()
    #expect(spec.cards[0].title == "Last")
  }

  @Test func nestingIsCappedInsteadOfOverflowingTheStack() {
    let deep = String(repeating: "[", count: 100_000) + String(repeating: "]", count: 100_000)
    #expect(StrictJSON.parse(deep) == nil)
    #expect(StrictJSON.parse(String(repeating: "[", count: 60) + String(repeating: "]", count: 60)) != nil)
  }

  // MARK: A hostile block

  @Test func aHostileBlockIsRefusedAndNeverTraps() {
    let hostile: [String] = [
      "", " ", "{", "null", "1e999", "[]", "{}",
      #"{"__proto__": {"x": 1}, "cards": []}"#,
      #"{"constructor": 1}"#,
      #"{"cards": [{"title": "A", "__proto__": 1}, {"title": "B"}]}"#,
      #"{"cards": [null, null]}"#,
      #"{"cards": [[], []]}"#,
      "{\"cards\": [" + String(repeating: "{\"title\":\"x\"},", count: 5000) + "{\"title\":\"x\"}]}",
      String(repeating: "[", count: 10_000),
      #"{"cards": [{"title": ""#.appending(String(repeating: "x", count: 70_000)).appending(#""}, {"title": "y"}]}"#),
      #"{"cards": [{"title": "A"}, {"title": "B"}], "layout": {"toString": 1}}"#
    ]

    for source in hostile {
      if case .success = HermieCards.parse(source) {
        Issue.record("accepted: \(source.prefix(60))")
      }
    }

    #expect(
      HermieCards.parse(#"{"__proto__": {"x": 1}, "cards": [{"title": "A"}, {"title": "B"}]}"#)
        == .failure(.unknownKey("__proto__")))
  }

  // MARK: What a screen reader says

  private static let words = HermieCardsSpeech.Words(
    card: { position, total, title in "Card \(position) of \(total), \(title)" },
    highlighted: "highlighted",
    tags: { "tags \($0)" },
    then: { "then: \($0)" })

  @Test func aCardIsReadAsOneSentenceWithItsPositionHighlightTagsAndConnector() throws {
    let spec = try HermieCards.parse(
      #"{"cards":[{"title":"Gateway per klant","subtitle":"k3s, eigen Postgres","tags":["k3s","Postgres"],"highlight":true,"next":"deployt naar"},{"title":"Website"}]}"#
    ).get()

    #expect(
      HermieCardsSpeech.sentence(spec, index: 0, words: Self.words)
        == "Card 1 of 2, Gateway per klant, k3s, eigen Postgres, highlighted, tags k3s, Postgres, then: deployt naar")
    #expect(HermieCardsSpeech.sentence(spec, index: 1, words: Self.words) == "Card 2 of 2, Website")
    #expect(HermieCardsSpeech.sentence(spec, index: 2, words: Self.words) == "")
    #expect(HermieCardsSpeech.sentence(spec, index: -1, words: Self.words) == "")
  }

  // MARK: The icon vocabulary

  private static var iconRows: [[String: String]] {
    (icons["icons"] as? [[String: String]]) ?? []
  }

  @Test func theSwiftTableIsTheContractsSymbolColumn() {
    let contract = Dictionary(uniqueKeysWithValues: Self.iconRows.compactMap { row in
      row["name"].flatMap { name in row["sfSymbol"].map { (name, $0) } }
    })

    #expect(contract.count == 48)
    #expect(HermieCardIcons.symbols == contract, "icons.json and HermieCardIcons.swift disagree")
    #expect(HermieCardIcons.names == Set(contract.keys))
    #expect((Self.icons["generic"] as? [String: String])?["sfSymbol"] == HermieCardIcons.generic)
  }

  @Test func theNamesAreLowerCaseLettersAndTheSymbolsAreUnique() {
    let names = Self.iconRows.compactMap { $0["name"] }
    let symbols = Self.iconRows.compactMap { $0["sfSymbol"] }

    #expect(names.allSatisfy { $0.allSatisfy { $0.isLowercase && $0.isLetter } })
    #expect(Set(symbols).count == symbols.count)
  }
}
