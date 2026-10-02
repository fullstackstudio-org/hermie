import Foundation
import Testing

@testable import HermieShared

@Suite("JSON as JSON.stringify writes it")
struct JSONTextTests {
  /// Each value and what `JSON.stringify` writes for it, taken from Node.
  @Test(
    "numbers",
    arguments: [
      (0.0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (1700, "1700"), (1_770_000_100.5, "1770000100.5"),
      (0.1, "0.1"), (1e-6, "0.000001"), (1.5e-7, "1.5e-7"), (1.2345678901234568e20, "123456789012345680000"),
      (1e21, "1e+21"), (1.7976931348623157e308, "1.7976931348623157e+308"), (5e-324, "5e-324"),
      (9_007_199_254_740_992, "9007199254740992"), (1.152921504606846976e18, "1152921504606847000"),
      (-2.5e-10, "-2.5e-10"), (0.000001234, "0.000001234"), (1e16, "10000000000000000"),
      (.nan, "null"), (.infinity, "null"), (-.infinity, "null")
    ] as [(Double, String)]
  )
  func numbers(value: Double, expected: String) {
    #expect(JSONText.number(value) == expected)
  }

  @Test("strings: quotes, backslashes and control characters escaped; slashes, DEL, U+2028/2029 and non-BMP left as they are")
  func strings() {
    let value = "q\"b\\s/\u{8}\u{C}\n\r\t\u{1}\u{1F}\u{7F}\u{2028}\u{2029}é😀"
    let expected = "\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001f\u{7F}\u{2028}\u{2029}é😀\""

    #expect(JSONText.string(value).text == expected)
    // And it parses back to the same text.
    #expect((try? JSONSerialization.jsonObject(with: Data(expected.utf8), options: .fragmentsAllowed)) as? String == value)
  }

  @Test("objects keep their order; arrays, booleans and null")
  func structure() {
    let value = JSONText.object([
      ("z", .number(1)), ("a", .array([.bool(true), .bool(false), .null])), ("m", .object([]))
    ])

    #expect(value.text == #"{"z":1,"a":[true,false,null],"m":{}}"#)
  }

  @Test("a manifest with a gateway key, a lease and a request round trip")
  func formats() throws {
    let manifest = ShareManifest(
      id: "abc", bot: "b", gatewayKey: "50696704682b12da", note: "n", createdAt: 1,
      items: [ShareItem(kind: .text, text: "t")])

    #expect(
      String(decoding: manifest.encoded(), as: UTF8.self)
        == #"{"version":1,"id":"abc","bot":"b","gatewayKey":"50696704682b12da","note":"n","createdAt":1,"items":[{"kind":"text","text":"t"}]}"#
    )
    #expect(ShareManifest.parse(manifest.encoded()) == manifest)
    #expect(ShareManifest.parse(Data(#"{"version":1,"id":"a","gatewayKey":"NOPE","note":"n"}"#.utf8))?.gatewayKey == nil)

    let intent = PendingIntent(id: "i", kind: .send, bot: "b", text: "t", createdAt: 5, gatewayKey: "50696704682b12da")

    #expect(PendingIntent.parse(intent.encoded()) == intent)

    let lease = ShareLease(at: 1_770_000_000)

    #expect(ShareLease.parse(lease.encoded(), now: Date()) == lease)
    #expect(ShareLease.parse(Data("{".utf8), now: Date(timeIntervalSince1970: 7)).at == 7)
    #expect(!ShareLease(at: 0).isFresh(now: Date(timeIntervalSince1970: ShareLease.lifetime)))
    #expect(!ShareLease(at: 10_000).isFresh(now: Date(timeIntervalSince1970: 0)))
  }
}
