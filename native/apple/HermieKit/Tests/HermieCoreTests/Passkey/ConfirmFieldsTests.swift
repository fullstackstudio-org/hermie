import CryptoKit
import Foundation
import HermieGateway
import HermiePasskeyTesting
import HermieProtocol
import Testing

@testable import HermieCore

private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// The contract's own version-2 `confirm` frame (`contract/confirm-passkey/vectors.json`).
private func contractFields() throws -> JSONValue {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("confirm-passkey/vectors.json"))
  let root = try JSONValue(parsing: data)
  return try #require(root["wire_examples"]?["confirm_request_frame_v2"]?["params"]?["fields"])
}

private func field(
  id: String = "f", kind: String = "text", label: String = "Label", value: String = "Value", currency: String? = nil,
  extra: [String: JSONValue] = [:]
) -> JSONValue {
  var object: JSONObject = ["id": .string(id), "kind": .string(kind), "label": .string(label), "value": .string(value)]

  if let currency {
    object["currency"] = .string(currency)
  }

  for (key, value) in extra {
    object[key] = value
  }

  return .object(object)
}

private func problem(_ raw: JSONValue?) -> ConfirmFieldRules.Problem? {
  if case .failure(let problem) = ConfirmFieldRules.read(raw) {
    return problem
  }

  return nil
}

private func fields(_ raw: JSONValue?) throws -> [ConfirmField] {
  switch ConfirmFieldRules.read(raw) {
  case .success(let fields): return fields
  case .failure(let problem):
    Issue.record("refused: \(problem)")
    throw problem
  }
}

/// The structured fields of a `confirm` (`contract/confirm-passkey` §4.1): what is accepted, what makes
/// the whole frame refused, and what the sheet and the challenge are made of.
@Suite("Confirm fields: the rules")
struct ConfirmFieldRulesTests {
  @Test("the contract's fields are read in order with every key")
  func contractFrame() throws {
    let read = try fields(try contractFields())
    #expect(read.map(\.id) == ["cost", "tokens", "model"])
    #expect(read.map(\.kind) == [.amount, .count, .model])
    #expect(read[0] == ConfirmField(id: "cost", kind: .amount, label: "Geschätzte Kosten (€)", value: "4,20", currency: "€"))
    #expect(read[1].currency == nil && read[2].value == "claude-opus-5-5")
  }

  @Test("no fields: an absent key or null is a request without any; an empty list is not")
  func absent() throws {
    #expect(try fields(nil).isEmpty)
    #expect(try fields(.null).isEmpty)
    #expect(problem([]) == .notAList, "never an empty list")
    #expect(problem("fields") == .notAList)
    #expect(problem(["a": 1]) == .notAList)
  }

  @Test("1 to 8 objects, each with exactly the contract's keys")
  func shape() throws {
    let many = (1...8).map { field(id: "f\($0)") }
    #expect(try fields(.array(many)).count == 8)
    #expect(problem(.array(many + [field(id: "f9")])) == .tooMany)
    #expect(problem(.array([field(), "text"])) == .notAnObject)
    #expect(problem(.array([field(extra: ["note": "x"])])) == .keys, "a key the contract does not give")
    #expect(problem(.array([.object(["id": "a", "kind": "text", "label": "L"])])) == .keys, "value missing")
    #expect(problem(.array([.object(["kind": "text", "label": "L", "value": "V"])])) == .keys, "id missing")
    #expect(problem(.array([.object(["id": "a", "label": "L", "value": "V"])])) == .keys, "kind missing")
    #expect(problem(.array([.object(["id": "a", "kind": "text", "value": "V"])])) == .keys, "label missing")
    #expect(problem(.array([.object(["id": "a", "kind": "text", "label": "L", "value": 5])])) == .keys, "value not a string")
  }

  @Test("the id is ^[a-z][a-z0-9_]{0,31}$ and unique; the kind is one of seven")
  func idAndKind() throws {
    for good in ["a", "cost", "a1", "a_b", "x0123456789012345678901234567890"] {
      #expect(ConfirmFieldRules.isID(good), "\(good)")
    }

    for bad in ["", "A", "1a", "_a", "a-b", "a b", "é", "x01234567890123456789012345678901", "a\n"] {
      #expect(!ConfirmFieldRules.isID(bad), "\(bad.debugDescription)")
      #expect(problem(.array([field(id: bad)])) == .id, "\(bad.debugDescription)")
    }

    #expect(problem(.array([field(id: "a"), field(id: "b"), field(id: "a")])) == .idRepeated)

    for kind in ["amount", "text", "recipient", "domain", "model", "count", "date"] {
      #expect(try fields(.array([field(kind: kind)])).first?.kind.rawValue == kind)
    }

    #expect(ConfirmFieldKind.allCases.count == 7)

    for bad in ["", "Amount", "email", "number", "url"] {
      #expect(problem(.array([field(kind: bad)])) == .kind, "\(bad)")
    }
  }

  @Test("label up to 40, value up to 200, currency up to 16 code points, and only an amount has one")
  func lengths() throws {
    let text = { (count: Int) in String(repeating: "x", count: count) }
    #expect(try fields(.array([field(label: text(40), value: text(200))])).count == 1)
    #expect(problem(.array([field(label: "")])) == .label)
    #expect(problem(.array([field(label: text(41))])) == .label)
    #expect(problem(.array([field(value: "")])) == .value)
    #expect(problem(.array([field(value: text(201))])) == .value)
    #expect(try fields(.array([field(label: String(repeating: "😀", count: 40))])).count == 1, "code points, not bytes")
    #expect(problem(.array([field(label: String(repeating: "😀", count: 41))])) == .label)

    #expect(try fields(.array([field(kind: "amount", currency: text(16))])).first?.currency == text(16))
    #expect(problem(.array([field(kind: "amount", currency: text(17))])) == .currency)
    #expect(problem(.array([field(kind: "amount", currency: "")])) == .currency)
    #expect(problem(.array([field(kind: "text", currency: "EUR")])) == .currency, "only an amount has a currency")
    #expect(problem(.array([field(kind: "recipient", currency: "€")])) == .currency)
    #expect(problem(.array([field(kind: "amount", extra: ["currency": 5])])) == .currency)
    #expect(try fields(.array([field(kind: "amount", extra: ["currency": .null])])).first?.currency == nil, "null is absent")
    #expect(try fields(.array([field(kind: "amount")])).first?.currency == nil, "an amount may have none")
  }

  @Test("label, value and currency are one line of verbatim text")
  func verbatim() {
    func refused(_ text: String) -> Bool {
      problem(.array([field(label: text)])) == .label && problem(.array([field(value: text)])) == .value
        && problem(.array([field(kind: "amount", currency: text)])) == .currency
    }

    for text in [
      "a\nb", "a\rb", "a\u{000B}b", "a\u{000C}b", "a\u{0085}b", "a\u{2028}b", "a\u{2029}b",  // line breaks
      "a\tb", "a\u{0007}b", "a\u{0000}b", "a\u{007F}b",  // controls
      "a\u{202E}b", "a\u{2066}b", "a\u{200B}b", "a\u{200D}b", "a\u{FEFF}b", "a\u{00AD}b",  // format
      "a\u{00A0}b", "a\u{3000}b", "a\u{2003}b",  // other whitespace
      "a\u{3164}b", "a\u{2800}b", "a\u{FE0F}b", "a\u{034F}b",  // invisible letters, default-ignorable
      "a\u{E000}b", "a\u{0378}b",  // private use, unassigned
      " a", "a ", " ", "a" + String(repeating: " ", count: 17) + "b",  // spaces at an end, a run of 17
      "a" + String(repeating: "\u{0301}", count: 5)  // five combining marks
    ] {
      #expect(refused(text), "\(text.unicodeScalars.map(\.value))")
    }
  }

  @Test("ordinary text passes, whatever the script: a run of 16 spaces, 4 marks, emoji, right-to-left text")
  func ordinary() throws {
    let passing = [
      "Geschätzte Kosten (€)", "日本語", "Ωmega 😀", "café", "a" + String(repeating: " ", count: 16) + "b",
      "a" + String(repeating: "\u{0301}", count: 4), "x@example.com", "xn--bcher-kva.example", "שלום", "¥12,000", "1.200.000"
    ]

    for text in passing {
      #expect(try fields(.array([field(label: text, value: text)])).count == 1, "\(text)")
    }
  }

  @Test("the digest commits to the fields in order, and the version follows the fields")
  func digest() throws {
    let read = try fields(try contractFields())
    let display = ConfirmDisplay(title: "T", summary: "S", detail: nil, baseURL: "https://gw.example.com", fields: read)
    let swapped = ConfirmDisplay(title: "T", summary: "S", detail: nil, baseURL: "https://gw.example.com", fields: read.reversed())
    let bare = ConfirmDisplay(title: "T", summary: "S", detail: nil, baseURL: "https://gw.example.com")

    #expect(display.textVersion == 2 && bare.textVersion == 1)
    #expect(display.textDigest != swapped.textDigest, "the order is part of the text")
    #expect(display.textDigest != bare.textDigest)
    #expect(bare.textDigest == PasskeyChallenge.textDigest(title: "T", summary: "S", detail: nil))
  }
}

/// A frame at level `passkey` with `fields`: the model reads them strictly, draws them, hashes them,
/// and answers with the request's own version.
@MainActor
@Suite("Confirm fields: the model")
struct ConfirmFieldsModelTests {
  typealias T = PasskeyModelTests

  static let amount = field(id: "cost", kind: "amount", label: "Estimated cost", value: "4.20", currency: "€")
  static let count = field(id: "tokens", kind: "count", label: "tokens", value: "1,200,000")
  static let recipient = field(id: "to", kind: "recipient", label: "To", value: "alex@example.com")

  /// The model's frame params with `fields` and `v`.
  static func params(
    _ f: T.Fixture, v: Int = 2, fields: JSONValue? = [amount, count, recipient], detail: String? = nil
  ) -> JSONObject {
    var params = T.params(ids: [f.phone.id], v: v, detail: detail)
    params["fields"] = fields
    return params
  }

  @Test("a version-2 frame is shown with its fields in order, and what is shown is what the challenge commits to")
  func shown() async throws {
    let f = await T.fixture()
    try await PasskeyModelTests().raise(f, Self.params(f))

    let shown = try #require(f.model.confirmation("srq-1"))
    #expect(shown.display.fields.map(\.id) == ["cost", "tokens", "to"])
    #expect(shown.display.fields.map(\.kind) == [.amount, .count, .recipient])
    #expect(shown.display.fields[0].value == "4.20", "never parsed or rounded")
    #expect(shown.display.fields[0].currency == "€")
    #expect(shown.display.textVersion == 2)
    #expect(
      shown.display.textDigest
        == PasskeyChallenge.textDigestV2(
          title: shown.display.title, summary: shown.display.summary, detail: shown.display.detail,
          fields: shown.display.fields))
    #expect(f.link.declines.isEmpty && f.model.notices.isEmpty)
  }

  @Test("Confirm signs the version-2 challenge over the displayed fields and the answer says v 2")
  func answersV2() async throws {
    let f = await T.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await PasskeyModelTests().raise(f, Self.params(f))
    let shown = try #require(f.model.confirmation("srq-1"))

    await f.model.confirm("srq-1")
    #expect(f.model.confirmation("srq-1")?.phase == .received)

    let call = try #require(f.link.calls("request.answer").first)
    let result = try #require(call.params["result"].flatMap(ConfirmResult.init(jsonValue:)))
    let passkey = try #require(result.passkey)
    #expect(passkey.v == 2, "the answer repeats the request's passkey.v")

    let expected = PasskeyChallenge.challenge(
      shown.display,
      PasskeyChallengeBinding(
        purpose: .confirm, gatewayID: T.gatewayID, userID: T.userID, sessionID: "sess-1", requestID: "srq-1",
        nonce: T.nonce))
    let clientData = try #require(passkey.clientDataJSON.flatMap(Base64URL.decode))
    #expect(try JSONValue(parsing: Data(clientData))["challenge"]?.stringValue == Base64URL.encode(expected))

    // Not the version-1 challenge of the same text: a signature over the text without the fields would not do.
    let plain = ConfirmDisplay(
      title: shown.display.title, summary: shown.display.summary, detail: shown.display.detail, baseURL: shown.display.baseURL)
    let withoutFields = PasskeyChallenge.challenge(
      plain,
      PasskeyChallengeBinding(
        purpose: .confirm, gatewayID: T.gatewayID, userID: T.userID, sessionID: "sess-1", requestID: "srq-1",
        nonce: T.nonce))
    #expect(withoutFields != expected)
  }

  @Test("a version-1 frame still works: no fields, the version-1 digest, and the answer says v 1")
  func versionOneStillWorks() async throws {
    let f = await T.fixture()
    f.link.respond(to: "request.answer", with: ["status": "ok"])
    try await PasskeyModelTests().raise(f, T.params(ids: [f.phone.id]))

    let shown = try #require(f.model.confirmation("srq-1"))
    #expect(shown.display.fields.isEmpty && shown.display.textVersion == 1)
    #expect(shown.display.textDigest == PasskeyChallenge.textDigest(title: shown.display.title, summary: shown.display.summary, detail: shown.display.detail))

    await f.model.confirm("srq-1")
    let call = try #require(f.link.calls("request.answer").first)
    #expect(call.params["result"].flatMap(ConfirmResult.init(jsonValue:))?.passkey?.v == 1)
  }

  @Test("a frame with fields null is a request without any")
  func nullFields() async throws {
    let f = await T.fixture()
    var params = T.params(ids: [f.phone.id])
    params["fields"] = .null
    try await PasskeyModelTests().raise(f, params)
    #expect(f.model.confirmation("srq-1")?.display.textVersion == 1)
  }

  @Test("fields that break the contract refuse the whole frame with 4040 and show none of it")
  func refusesBrokenFields() async throws {
    let broken: [(String, JSONValue?)] = [
      ("empty list", []),
      ("nine fields", .array((1...9).map { field(id: "f\($0)") })),
      ("an unknown key", .array([field(extra: ["x": 1])])),
      ("a bad id", .array([field(id: "Cost")])),
      ("a repeated id", .array([field(id: "a"), field(id: "a")])),
      ("an unknown kind", .array([field(kind: "email")])),
      ("a long label", .array([field(label: String(repeating: "x", count: 41))])),
      ("a long value", .array([field(value: String(repeating: "x", count: 201))])),
      ("a currency on a text", .array([field(kind: "text", currency: "EUR")])),
      ("a bidi override in a value", .array([field(value: "pay\u{202E}gnp")])),
      ("a line break in a label", .array([field(label: "a\nb")])),
      ("one good field and one that is not an object", .array([Self.amount, "oops"])),
      ("not a list", "fields")
    ]

    for (name, fields) in broken {
      let f = await T.fixture()
      f.link.raise(id: "srq-1", method: "confirm", params: Self.params(f, fields: fields))
      try await eventually("\(name): the refusal") { @MainActor in !f.link.declines.isEmpty }

      #expect(f.link.declines.first?.code == 4040, "\(name)")
      #expect(f.link.declineData("srq-1") == ["reason": "bad_request"], "\(name)")
      #expect(f.model.confirmation("srq-1") == nil, "\(name): nothing of it is shown")
      #expect(f.model.confirmations.isEmpty, "\(name)")
      #expect(f.model.notices.map(\.kind) == [.malformedRequest], "\(name): and the person is told")
    }
  }

  @Test("v 2 without fields, v 1 with them, and a version this build does not know are refused")
  func refusesTheWrongVersion() async throws {
    func withFields(_ v: Int) -> JSONObject {
      var params = T.params(ids: ["AQID"], v: v)
      params["fields"] = [Self.amount]
      return params
    }

    let cases: [(String, JSONObject)] = [
      ("v 2 without fields", T.params(ids: ["AQID"], v: 2)),
      ("v 1 with fields", withFields(1)),
      ("v 3 with fields", withFields(3)),
      ("v 0", T.params(ids: ["AQID"], v: 0))
    ]

    for (name, params) in cases {
      let f = await T.fixture()
      f.link.raise(id: "srq-1", method: "confirm", params: params)
      try await eventually("\(name): the refusal") { @MainActor in !f.link.declines.isEmpty }

      #expect(f.link.declines.first?.code == 4040, "\(name)")
      #expect(f.link.declineData("srq-1") == ["reason": "unsupported_version"], "\(name)")
      #expect(f.model.confirmation("srq-1") == nil, "\(name)")
      #expect(f.model.notices.map(\.kind) == [.unsupportedVersion], "\(name)")
    }
  }

  @Test("the model advertises that it shows fields: confirm_fields and passkey v 2 follow from the policy")
  func advertisesFields() async throws {
    let f = await T.fixture()
    #expect(f.model.policy.fields)
    #expect(f.source.policy.fields, "the connection decides its second call from this")

    // Without an RP there is no passkey, and the fields are still shown (a plain level uses them).
    let noRP = await T.fixture(rpID: nil)
    #expect(noRP.model.policy.passkey == nil && noRP.model.policy.fields)
  }
}
