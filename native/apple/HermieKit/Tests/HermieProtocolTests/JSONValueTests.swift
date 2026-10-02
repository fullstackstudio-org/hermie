import Foundation
import Testing

@testable import HermieProtocol

@Suite("JSONValue")
struct JSONValueTests {
  @Test func parsesEveryKindOfValue() throws {
    let value = try JSONValue(parsing: #" { "a" : [1, -2.5e3, true, false, null, "x"], "b": {} , "c": [] } "#)
    #expect(
      value == [
        "a": [1, -2500, true, false, nil, "x"],
        "b": [:],
        "c": []
      ])
  }

  @Test func readsThroughTheAccessors() throws {
    let value: JSONValue = ["n": 3, "f": 1.5, "s": "t", "b": true, "o": ["k": nil], "a": [1, 2]]
    #expect(value["n"]?.intValue == 3)
    #expect(value["f"]?.intValue == nil)
    #expect(value["f"]?.doubleValue == 1.5)
    #expect(value["s"]?.stringValue == "t")
    #expect(value["b"]?.boolValue == true)
    #expect(value["o"]?["k"]?.isNull == true)
    #expect(value["a"]?[1] == 2)
    #expect(value["a"]?[2] == nil)
    #expect(value["missing"] == nil)
    #expect(value["s"]?["k"] == nil)
    #expect(JSONValue.string("").isTruthy == false)
    #expect(JSONValue.number(0).isTruthy == false)
    #expect(JSONValue.object([:]).isTruthy == true)
  }

  @Test func keepsTheLastOfARepeatedKey() throws {
    #expect(try JSONValue(parsing: #"{"a":1,"a":2}"#) == ["a": 2])
  }

  @Test func keepsIntegersExactUpTo2To53() throws {
    for text in ["9007199254740991", "-9007199254740991", "9007199254740992", "1790000000000", "0"] {
      let value = try JSONValue(parsing: text)
      #expect(try value.canonicalString() == text)
      #expect(value.intValue.map(String.init) == text)
    }
    // Past 2^53 a double cannot hold every integer; JavaScript rounds the same way.
    #expect(try JSONValue(parsing: "9007199254740993").canonicalString() == "9007199254740992")
  }

  @Test func readsNumberSpellingsAsOneNumber() throws {
    #expect(try JSONValue(parsing: "1.0") == 1)
    #expect(try JSONValue(parsing: "1e0") == 1)
    #expect(try JSONValue(parsing: "-0") == 0)
    #expect(try JSONValue(parsing: "1.0").canonicalString() == "1")
    #expect(try JSONValue(parsing: "1E+2").canonicalString() == "100")
  }

  @Test func refusesWhatJSONParseRefuses() {
    let bad = [
      "", " ", "{", "[1,]", "{\"a\":1,}", "01", "1.", ".5", "+1", "1e", "-", "NaN", "Infinity", "tru", "nul",
      "\"\\x\"", "\"unterminated", "\"tab\there\"", "{a:1}", "[1 2]", "1 2", "'a'", "\"\\u12\""
    ]
    for text in bad {
      #expect(throws: JSONParseError.self, "\(text)") { try JSONValue(parsing: text) }
    }
  }

  @Test func refusesANumberTooLargeForADouble() {
    #expect(throws: JSONParseError(reason: .numberOutOfRange, offset: 1)) { try JSONValue(parsing: "[1e400]") }
  }

  /// Everything that walks a value recurses (parse, canonical text, equality, hashing,
  /// release), so the parser bounds the depth. At the bound all of them must still fit the
  /// stack of a secondary thread in a debug build, which is where this test runs.
  /// (Foundation's `JSONEncoder` recurses far deeper per level and overflows that stack
  /// somewhere past 128; the wire path never goes through it, `canonicalData()` does.)
  @Test func refusesNestingDeeperThanTheBoundAndHandlesTheBound() throws {
    let depth = JSONParser.maxDepth
    let tooDeep = String(repeating: "[", count: depth + 1) + String(repeating: "]", count: depth + 1)
    #expect(throws: JSONParseError.self) { try JSONValue(parsing: tooDeep) }
    let objects = String(repeating: #"{"a":"#, count: depth + 1) + "1" + String(repeating: "}", count: depth + 1)
    #expect(throws: JSONParseError.self) { try JSONValue(parsing: objects) }

    let atBound = String(repeating: #"{"a":["#, count: depth / 2) + "1" + String(repeating: "]}", count: depth / 2)
    let value = try JSONValue(parsing: atBound)
    #expect(try value.canonicalString() == atBound)
    #expect(value == (try JSONValue(parsing: atBound)))
    #expect(Set([value, value]).count == 1)
    #expect(try JSONValue(parsing: value.canonicalData()) == value)

    let shallower = try JSONValue(parsing: String(repeating: "[", count: 64) + String(repeating: "]", count: 64))
    let data = try JSONEncoder().encode(shallower)
    #expect(try JSONDecoder().decode(JSONValue.self, from: data) == shallower)
  }

  @Test func decodesEscapesAndSurrogatePairs() throws {
    let value = try JSONValue(parsing: #""\"\\\/\b\f\n\r\t\u0041\u00e9\u20ac\ud83d\ude00""#)
    #expect(value == .string("\"\\/\u{08}\u{0C}\n\r\tAé€😀"))
  }

  /// The lone-surrogate policy: an unpaired `\uD8xx` / `\uDCxx` becomes U+FFFD (a Swift
  /// string cannot hold it, and dropping the whole frame would lose the turn). The contract
  /// corpus never contains one: the reference refuses to write them.
  @Test func replacesLoneSurrogatesWithTheReplacementCharacter() throws {
    #expect(try JSONValue(parsing: #""a\ud800b""#) == "a\u{FFFD}b")
    #expect(try JSONValue(parsing: #""a\udc00b""#) == "a\u{FFFD}b")
    #expect(try JSONValue(parsing: #""\ud800\u0041""#) == "\u{FFFD}A")
    #expect(try JSONValue(parsing: #""\ud800""#) == "\u{FFFD}")
    // Invalid UTF-8 (here, a CESU-style encoded surrogate) is replaced the same way.
    let bytes = Data([0x22, 0xED, 0xA0, 0x80, 0x22])
    #expect(try JSONValue(parsing: bytes).stringValue?.unicodeScalars.allSatisfy { $0 == "\u{FFFD}" } == true)
  }

  @Test func keepsNonASCIIAndRawUTF8() throws {
    let text = "\"héllo – 日本 😀 \u{2028}\""
    #expect(try JSONValue(parsing: text) == .string("héllo – 日本 😀 \u{2028}"))
  }

  @Test func roundTripsThroughFoundationCodable() throws {
    let value: JSONValue = [
      "int": 1_790_000_000_000, "neg": -3, "frac": 0.25, "big": 1e300, "t": true, "f": false, "nil": nil,
      "s": "x\ny", "a": [1, "2", [3]], "o": ["k": ["deep": nil]]
    ]
    let data = try JSONEncoder().encode(value)
    let text = String(decoding: data, as: UTF8.self)
    #expect(!text.contains("1790000000000.0"))
    #expect(!text.contains("e+12"))
    let back = try JSONDecoder().decode(JSONValue.self, from: data)
    #expect(back == value)
    #expect(try back.canonicalString() == value.canonicalString())
    // Bool and number stay apart through Foundation's decoder.
    #expect(try JSONDecoder().decode(JSONValue.self, from: Data("[1,0,true]".utf8)) == [1, 0, true])
  }

  @Test func decodesTypedViewsThroughFoundationCodable() throws {
    let data = Data(#"{"text":"hi","rendered":null,"extra":{"n":1}}"#.utf8)
    let payload = try JSONDecoder().decode(StreamDeltaPayload.self, from: data)
    #expect(payload.text == "hi")
    #expect(payload.rendered == nil)
    let encoded = try JSONEncoder().encode(payload)
    #expect(try JSONValue(parsing: encoded).canonicalString() == #"{"extra":{"n":1},"rendered":null,"text":"hi"}"#)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(StreamDeltaPayload.self, from: Data("[1]".utf8)) }
  }

  @Test func encodesOpenEnumsAsTheirRawValue() throws {
    let data = try JSONEncoder().encode([TurnStatus.complete, .unknown("paused")])
    #expect(String(decoding: data, as: UTF8.self) == #"["complete","paused"]"#)
    #expect(try JSONDecoder().decode([TurnStatus].self, from: data) == [.complete, .unknown("paused")])
  }
}
