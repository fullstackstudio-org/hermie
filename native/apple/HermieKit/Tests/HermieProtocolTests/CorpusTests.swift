import Foundation
import Testing

@testable import HermieProtocol

@Suite("Contract corpus")
struct CorpusTests {
  /// Byte-identical copies of the fork's contracts, written by its own generator.
  static let forkCopies = ["confirm-passkey/", "requests/"]

  // MARK: canonicalString() against the reference

  /// Every generated file under `contract/` was written by `prettyJson` in
  /// `scripts/golden/canonical-json.ts`: `JSON.stringify(toJson(value), null, 2)`. Taking the
  /// insignificant whitespace out of it gives node's own compact text for that value, so
  /// comparing with it checks the parser, the number formatter, the string escaper and the
  /// key order against JavaScript on the whole corpus (about 13 MB), not on a sample.
  ///
  /// The reference's text orders index-like keys (`"12"`) first, the way a JavaScript object
  /// iterates, so that comparison uses `.ecmaScriptObject`; see `CanonicalKeyOrder`.
  ///
  /// `push/contract.json` is hand-written, and `confirm-passkey/` and `requests/` are byte-identical
  /// copies of the fork's contracts, written by its own generator with their own checksums: none came
  /// out of `prettyJson`, so they are held only to the fixed-point property below.
  @Test func canonicalTextEqualsTheReferenceForEveryGeneratedFile() throws {
    let files = try contractFiles()
    var compared = 0
    var mismatched: [String] = []
    for file in files where file.path != "push/contract.json" && !Self.forkCopies.contains(where: file.path.hasPrefix) {
      let data = try Data(contentsOf: file.url)
      let reference = minifiedJSONText(data)
      let value = try JSONValue(parsing: data)
      if try value.canonicalString(keyOrder: .ecmaScriptObject) != reference { mismatched.append(file.path) }
      compared += 1
    }
    print("canonical vs reference: \(compared) files compared, \(mismatched.count) mismatched")
    #expect(compared >= 40)
    #expect(mismatched.isEmpty, "\(mismatched)")
  }

  /// The hand-written push contract is not pretty-printed by the reference, so it is held to
  /// the weaker property every file must have: its canonical text is a fixed point.
  @Test func canonicalTextIsAFixedPointForEveryFile() throws {
    for file in try contractFiles() {
      let value = try JSONValue(parsing: Data(contentsOf: file.url))
      let text = try value.canonicalString()
      #expect(try JSONValue(parsing: text) == value, "\(file.path)")
      #expect(try JSONValue(parsing: text).canonicalString() == text, "\(file.path)")
    }
  }

  // MARK: Stream frames

  @Test func everyStreamFrameDecodesTypedAndReencodesUnchanged() throws {
    var frames = 0
    var events = 0
    var replayed = 0
    var unknownEvents: [String] = []
    var responses = 0
    var serverRequests = 0
    var restBodies = 0
    var problems: [String] = []

    let streams = try contractFiles().filter { $0.path.hasPrefix("transcript/streams/") }
    #expect(streams.count == 14)

    for stream in streams {
      let scenario = try JSONValue(parsing: Data(contentsOf: stream.url))
      for (index, entry) in (scenario["frames"]?.arrayValue ?? []).enumerated() {
        frames += 1
        let place = "\(stream.path) frame \(index)"
        guard let raw = entry["frame"] else {
          problems.append("\(place): no frame")
          continue
        }
        let original = try canonical(raw)

        if entry["connection"] == "rest" {
          restBodies += 1
          guard let body = SessionMessagesResponse(jsonValue: raw) else {
            problems.append("\(place): REST body is not an object")
            continue
          }
          if try canonical(body) != original { problems.append("\(place): REST body re-encodes differently") }
          if try canonical(TypedCopy.sessionMessages(body)) != original {
            problems.append("\(place): REST body loses keys through its typed properties")
          }
          continue
        }

        guard let frame = InboundFrame(jsonValue: raw) else {
          problems.append("\(place): not an object")
          continue
        }
        if try canonical(frame) != original { problems.append("\(place): re-encodes differently") }

        switch frame {
        case .event(let notification):
          events += 1
          let event = notification.event
          if event.body.isUnknown { unknownEvents.append(event.type) }
          let rebuilt = EventNotification(TypedCopy.event(event))
          if try canonical(rebuilt) != original { problems.append("\(place): \(event.type) loses keys when typed") }
        case .serverRequest(let request):
          serverRequests += 1
          if case .unknown = request.body { problems.append("\(place): server request \(request.method ?? "") untyped") }
          if try canonical(TypedCopy.serverRequest(request)) != original {
            problems.append("\(place): server request loses keys when typed")
          }
        case .response(let response):
          responses += 1
          guard let id = response.id, case .success(let result) = response.outcome else {
            problems.append("\(place): response without id or with an error")
            continue
          }
          guard let typed = try typedResult(result) else {
            problems.append("\(place): response result matches no typed result")
            continue
          }
          if case .eventsSince(let since) = typed {
            for event in since.events ?? [] {
              replayed += 1
              if event.body.isUnknown { unknownEvents.append(event.type) }
            }
          }
          if try canonical(JSONRPCResponse(id: id, result: typed.copied)) != original {
            problems.append("\(place): \(typed.name) result loses keys when typed")
          }
        case .other:
          problems.append("\(place): unclassified frame")
        }
      }
    }

    print(
      "streams: \(frames) frames: \(events) events (+\(replayed) replayed), \(responses) responses, "
        + "\(serverRequests) server requests, \(restBodies) REST bodies; unknown events: \(unknownEvents.count)")
    #expect(frames == events + responses + serverRequests + restBodies)
    #expect(events > 0 && responses > 0 && serverRequests > 0 && restBodies > 0)
    #expect(unknownEvents.isEmpty, "\(unknownEvents)")
    #expect(problems.isEmpty, "\(problems)")
  }

  /// The stream files do not record the client's requests, so a result is matched to its
  /// method by the keys only that method's result carries.
  private enum TypedResult {
    case profilesList(ProfilesListResult)
    case resume(SessionResumeResult)
    case history(SessionHistoryResult)
    case eventsSince(SessionEventsSinceResult)
    case promptSubmit(PromptSubmitResult)
    case clientCapabilities(ClientCapabilitiesResult)

    var name: String {
      switch self {
      case .profilesList: RPC.ProfilesList.name
      case .resume: RPC.SessionResume.name
      case .history: RPC.SessionHistory.name
      case .eventsSince: RPC.SessionEventsSince.name
      case .promptSubmit: RPC.PromptSubmit.name
      case .clientCapabilities: RPC.ClientCapabilities.name
      }
    }

    var copied: JSONValue {
      switch self {
      case .profilesList(let r): TypedCopy.profilesList(r).jsonValue
      case .resume(let r): TypedCopy.resume(r).jsonValue
      case .history(let r): TypedCopy.history(r).jsonValue
      case .eventsSince(let r): TypedCopy.eventsSince(r).jsonValue
      case .promptSubmit(let r): TypedCopy.promptSubmit(r).jsonValue
      case .clientCapabilities(let r): TypedCopy.clientCapabilities(r).jsonValue
      }
    }
  }

  private func typedResult(_ result: JSONValue) throws -> TypedResult? {
    guard let keys = result.objectValue.map({ Set($0.keys) }) else { return nil }
    if keys.contains("profiles") { return ProfilesListResult(jsonValue: result).map(TypedResult.profilesList) }
    if keys.contains("info") { return SessionResumeResult(jsonValue: result).map(TypedResult.resume) }
    if keys.contains("events") { return SessionEventsSinceResult(jsonValue: result).map(TypedResult.eventsSince) }
    if keys.contains("messages") { return SessionHistoryResult(jsonValue: result).map(TypedResult.history) }
    if keys == ["status"] { return PromptSubmitResult(jsonValue: result).map(TypedResult.promptSubmit) }
    if keys.contains("server_requests") {
      return ClientCapabilitiesResult(jsonValue: result).map(TypedResult.clientCapabilities)
    }
    return nil
  }

  // MARK: Fixtures

  @Test func everyFixtureEventDecodesTypedAndReencodesUnchanged() throws {
    let fixtures = try loadContract("transcript/fixtures/events.json")
    var count = 0
    var unknown: [String] = []
    var problems: [String] = []
    for (name, value) in fixtures.objectValue ?? [:] {
      guard let list = value.arrayValue else { continue }
      for (index, raw) in list.enumerated() {
        count += 1
        guard let event = GatewayEvent(jsonValue: raw) else {
          problems.append("\(name)[\(index)]: not an object")
          continue
        }
        if event.body.isUnknown { unknown.append(event.type) }
        if try canonical(event) != canonical(raw) { problems.append("\(name)[\(index)]: re-encodes differently") }
        if try canonical(TypedCopy.event(event)) != canonical(raw) {
          problems.append("\(name)[\(index)]: \(event.type) loses keys when typed")
        }
      }
    }
    // The two server requests the fixture file also carries.
    for name in ["approvalRequest", "clarifyRequest"] {
      let raw = try #require(fixtures[name])
      let request = try #require(ServerRequest(jsonValue: raw))
      if case .unknown = request.body { problems.append("\(name): untyped") }
      var copy = TypedCopy.serverRequest(request)
      copy.json["jsonrpc"] = nil  // the fixture is the bare `{id, method, params}`
      if try canonical(copy) != canonical(raw) { problems.append("\(name): loses keys when typed") }
    }
    print("fixtures/events.json: \(count) events, unknown: \(unknown.count)")
    #expect(count > 40)
    #expect(unknown.isEmpty, "\(unknown)")
    #expect(problems.isEmpty, "\(problems)")
  }

  @Test func everyFixtureRowRoundTripsThroughTheHistoryRow() throws {
    var rows: [(String, JSONValue)] = []
    func collect(_ value: JSONValue, at path: String) {
      switch value {
      case .object(let object) where object["role"] != nil:
        rows.append((path, value))
      case .object(let object):
        for (key, child) in object { collect(child, at: "\(path).\(key)") }
      case .array(let array):
        for (index, child) in array.enumerated() { collect(child, at: "\(path)[\(index)]") }
      default:
        break
      }
    }
    collect(try loadContract("transcript/fixtures/rows.json"), at: "$")

    var problems: [String] = []
    for (path, raw) in rows {
      guard let row = TranscriptRow(jsonValue: raw) else {
        problems.append("\(path): not an object")
        continue
      }
      if try canonical(row) != canonical(raw) { problems.append("\(path): re-encodes differently") }
      if try canonical(TypedCopy.row(row)) != canonical(raw) { problems.append("\(path): loses keys when typed") }
    }
    print("fixtures/rows.json: \(rows.count) rows")
    #expect(rows.count >= 30)
    #expect(problems.isEmpty, "\(problems)")
  }
}
