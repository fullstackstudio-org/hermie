import Foundation
import Testing

@testable import HermieProtocol

@Suite("Canonical JSON")
struct CanonicalJSONTests {
  // MARK: The README's rules, one by one

  @Test func writesOnlyThePlainValues() throws {
    #expect(try JSONValue.null.canonicalString() == "null")
    #expect(try JSONValue.bool(true).canonicalString() == "true")
    #expect(try JSONValue.bool(false).canonicalString() == "false")
    #expect(try JSONValue.array([]).canonicalString() == "[]")
    #expect(try JSONValue.object([:]).canonicalString() == "{}")
  }

  @Test func sortsKeysAtEveryDepthAndKeepsNull() throws {
    let value: JSONValue = ["b": ["z": 1, "a": nil], "a": [["d": 1, "c": 2]], "A": 0]
    #expect(try value.canonicalString() == #"{"A":0,"a":[{"c":2,"d":1}],"b":{"a":null,"z":1}}"#)
  }

  @Test func sortsKeysByUTF16CodeUnitNotByScalar() throws {
    // U+FFFF is one code unit 0xFFFF; U+1F600 is the pair D83D DE00, which sorts first.
    let value: JSONValue = ["\u{FFFF}": 1, "😀": 2, "é": 3, "z": 4, "Z": 5, "10": 6, "9": 7, "": 8]
    #expect(try value.canonicalString() == #"{"":8,"10":6,"9":7,"Z":5,"z":4,"é":3,"😀":2,"\#u{FFFF}":1}"#)
  }

  @Test func ordersIndexKeysFirstInTheJavaScriptObjectOrder() throws {
    let value: JSONValue = ["b": 1, "10": 2, "9": 3, "a": 4, "01": 5, "4294967295": 6, "4294967294": 7]
    #expect(
      try value.canonicalString(keyOrder: .ecmaScriptObject)
        == #"{"9":3,"10":2,"4294967294":7,"01":5,"4294967295":6,"a":4,"b":1}"#)
    #expect(
      try value.canonicalString()
        == #"{"01":5,"10":2,"4294967294":7,"4294967295":6,"9":3,"a":4,"b":1}"#)
  }

  @Test func keepsArrayOrder() throws {
    #expect(try JSONValue.array([3, 1, 2, nil]).canonicalString() == "[3,1,2,null]")
  }

  @Test func writesNumbersAsECMAScriptDoes() throws {
    let cases: [(Double, String)] = [
      (1_790_000_000_000, "1790000000000"), (-0.0, "0"), (0, "0"), (1, "1"), (1e21, "1e+21"), (1e-7, "1e-7"),
      (1e-6, "0.000001"), (123e-20, "1.23e-18"), (1e20, "100000000000000000000"), (0.1, "0.1"),
      (0.30000000000000004, "0.30000000000000004"), (-1.5, "-1.5"), (5e-324, "5e-324"),
      (1.7976931348623157e308, "1.7976931348623157e+308"), (2.5e-7, "2.5e-7"), (123_456.789, "123456.789")
    ]
    for (number, text) in cases {
      #expect(try JSONValue.number(number).canonicalString() == text, "\(number)")
    }
  }

  @Test func neverWritesAFractionForAnInteger() throws {
    #expect(try JSONValue.number(1.0).canonicalString() == "1")
    #expect(try JSONValue.number(-42.0).canonicalString() == "-42")
  }

  @Test func matchesJavaScriptOnEveryRecordedNumber() throws {
    var mismatches: [String] = []
    for vector in ecmaScriptNumberVectors {
      let number = Double(bitPattern: vector.bits)
      let written = ECMAScriptNumber.string(number)
      if written != vector.text { mismatches.append("\(vector.text) written as \(written)") }
      // And the text parses back to the same double.
      if try JSONValue(parsing: vector.text) != .number(number) { mismatches.append("\(vector.text) parsed wrong") }
    }
    #expect(ecmaScriptNumberVectors.count > 800)
    #expect(mismatches.isEmpty, "\(mismatches.prefix(10))")
  }

  @Test func refusesNonFiniteNumbers() {
    #expect(throws: CanonicalJSONError.nonFiniteNumber) { try JSONValue.number(.infinity).canonicalString() }
    #expect(throws: CanonicalJSONError.nonFiniteNumber) { try JSONValue.array([.number(.nan)]).canonicalString() }
    #expect(JSONValue.number(.nan).description == "<not canonical JSON>")
  }

  @Test func escapesStringsAsJSONStringify() throws {
    let text = "q\" b\\ s/ \u{08}\u{0C}\n\r\t \u{00}\u{01}\u{1F} \u{7F} é 😀 \u{2028}\u{2029}"
    #expect(
      try JSONValue.string(text).canonicalString()
        == #""q\" b\\ s/ \b\f\n\r\t \u0000\u0001\u001f "# + "\u{7F} é 😀 \u{2028}\u{2029}\"")
  }

  @Test func escapesKeysTheSameWay() throws {
    #expect(try JSONValue.object(["a\nb": 1]).canonicalString() == #"{"a\nb":1}"#)
  }

  @Test func writesNoWhitespace() throws {
    let value = try JSONValue(parsing: "{ \"a\" : [ 1 , { \"b\" : \" spaced \" } ] }")
    #expect(try value.canonicalString() == #"{"a":[1,{"b":" spaced "}]}"#)
  }

  @Test func canonicalTextIsStableAcrossAReparse() throws {
    let value: JSONValue = ["x": [0.1, 1e21, "é\n"], "y": ["z": nil]]
    let once = try value.canonicalString()
    #expect(try JSONValue(parsing: once).canonicalString() == once)
    #expect(try String(decoding: value.canonicalData(), as: UTF8.self) == once)
  }

  @Test func treatsAbsentAndUndefinedTheSameBecauseSwiftHasNoUndefined() throws {
    var object: JSONObject = ["a": 1]
    object[field: "b"] = String?.none
    #expect(try JSONValue.object(object).canonicalString() == #"{"a":1}"#)
  }

  // MARK: The README's examples

  @Test func readmeExamples() throws {
    // `1790000000000`, not `1.79e12`; `1e21`, `1e-7`; never `1.0` for `1`.
    #expect(try JSONValue(parsing: "1.79e12").canonicalString() == "1790000000000")
    #expect(try JSONValue(parsing: "1000000000000000000000").canonicalString() == "1e+21")
    #expect(try JSONValue(parsing: "0.0000001").canonicalString() == "1e-7")
    #expect(try JSONValue(parsing: "1.0").canonicalString() == "1")
    #expect(try JSONValue(parsing: "-0.0").canonicalString() == "0")
  }
}
