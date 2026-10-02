import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

/// The fake-gateway conversations of `contract/transcript/streams/`, driven
/// through the store over a scripted link: every frame the recorded client got
/// arrives at the wire index of its place in the recording, the store makes its
/// own calls (resume, history, replay, submit, the answers) and is answered
/// with the recorded results, and it has to reach the recorded checkpoints and
/// the recorded final state, as canonical JSON.
///
/// Time is the recording's: the store's engine clock hands out the `now` of
/// each recorded engine call in order, so a store that makes the calls in
/// another order stamps its items differently and fails the comparison.
@Suite(.timeLimit(.minutes(1))) struct StreamScenarioTests {
  static let scenarios = ["plain-turn", "tool-turn", "approval", "clarify", "subagents", "reconnect-replay"]

  @Test(arguments: scenarios)
  func reachesTheRecordedStates(_ name: String) async throws {
    let scenario = try StreamScenario.load(name)
    let mismatches = try await scenario.drive()

    #expect(mismatches.isEmpty, "\(name):\n\(mismatches.joined(separator: "\n"))")
  }
}

struct StreamScenario {
  let name: String
  let profile: String
  let frames: [(connection: String, frame: JSONValue)]
  let steps: [JSONValue]
  let checkpoints: [(label: String, visible: JSONObject)]
  let final: JSONValue

  static let directory: URL = {
    var url = URL(fileURLWithPath: #filePath)

    while url.path != "/" {
      url.deleteLastPathComponent()
      let candidate = url.appendingPathComponent("contract/transcript/streams", isDirectory: true)

      if FileManager.default.fileExists(atPath: candidate.path) {
        return candidate
      }
    }

    return url
  }()

  static func load(_ name: String) throws -> StreamScenario {
    let data = try Data(contentsOf: directory.appendingPathComponent("\(name).json"))
    let json = try JSONValue(parsing: data)

    return StreamScenario(
      name: name,
      profile: json["profile"]?.stringValue ?? "",
      frames: (json["frames"]?.arrayValue ?? []).map { entry in
        let connection =
          switch entry["connection"] {
          case .number(let number)?: String(Int(number))
          case .string(let text)?: text
          default: ""
          }
        return (connection, entry["frame"] ?? .null)
      },
      steps: json["steps"]?.arrayValue ?? [],
      checkpoints: (json["checkpoints"]?.arrayValue ?? []).map {
        ($0["label"]?.stringValue ?? "", $0["visible"]?.objectValue ?? [:])
      },
      final: json["final"] ?? .null
    )
  }

  /// The `now` of every recorded engine call that takes one, in order.
  var engineNows: [Double] {
    let timed: Set<String> = [
      "applyEvent", "applyServerRequest", "applyResumeSnapshot", "beginLocalTurn", "confirmSubmit",
      "markInterrupted", "beginSteer", "applySubagentSnapshot"
    ]

    return steps.compactMap { step in
      guard let op = step["op"]?.stringValue, timed.contains(op) else {
        return nil
      }

      return step["args"]?.arrayValue?.last?.doubleValue
    }
  }

  /// The text of the recorded submit, and the recorded answers.
  func argument(of op: String) -> [JSONValue]? {
    steps.first { $0["op"]?.stringValue == op }?["args"]?.arrayValue
  }

  /// The wire index a recorded frame arrives at: room is left between frames
  /// for the calls the recorder did not make (`subagent.list`, `approval.received`).
  static func index(_ position: Int) -> UInt64 { UInt64(position + 1) * 100 }

  static func method(ofResult result: JSONValue) -> String {
    if result["profiles"] != nil { return RPC.ProfilesList.name }
    if result["latest_seq"] != nil { return RPC.SessionEventsSince.name }
    if result["session_id"] != nil { return RPC.SessionResume.name }
    if result["messages"] != nil { return RPC.SessionHistory.name }
    return RPC.PromptSubmit.name
  }

  func drive() async throws -> [String] {
    let sequence = SequenceNow(engineNows)
    let harness = StoreHarness(now: { sequence.next() })
    let link = harness.link
    let store = harness.store
    var mismatches: [String] = []
    var checkpoints = self.checkpoints[...]
    var tasks: [Task<Void, any Error>] = []
    var opened: Task<Void, any Error>?
    var connection = "1"
    var compared = 0

    await harness.attach()
    await store.connectionChanged(ConnectionStatus(.ready))

    // The REST tail the recovery reads, whenever it asks for it.
    if let rest = frames.first(where: { $0.connection == "rest" }) {
      let rows = (rest.frame["messages"]?.arrayValue ?? []).map { TranscriptRow(json: $0.objectValue ?? [:]) }
      link.setREST { _, _ in rows }
    } else {
      link.setREST { _, _ in nil }
    }

    func check(_ label: String) async {
      guard let checkpoint = checkpoints.first, checkpoint.label == label else {
        return
      }

      checkpoints = checkpoints.dropFirst()
      compared += 1
      let state = await harness.state(profile)

      for level in ["quiet", "normal", "verbose"] {
        let options = VisibilityOptions(level: Verbosity(rawValue: level), showBotToBot: true, showThinking: true)
        let actual = JSONValue.array(visibleItems(state, options).map(\.jsonValue))
        let expected = checkpoint.visible[level] ?? .null

        for line in jsonDifferences(expected, actual, path: "\(label).\(level)") {
          mismatches.append(line)
        }
      }
    }

    for (position, entry) in frames.enumerated() {
      let frame = entry.frame
      let index = Self.index(position)

      if entry.connection != connection, entry.connection != "rest" {
        // The recorded client dropped its socket while idle and dialled again.
        await check("settled live")
        await store.connectionChanged(ConnectionStatus(.disconnected))
        connection = entry.connection
      }

      if entry.connection == "rest" {
        continue
      }

      if frame["method"]?.stringValue == "event" {
        let event = GatewayEvent(json: frame["params"]?.objectValue ?? [:])
        link.emit(event, index: index)

        if event.type == GatewayEventType.gatewayReady, connection != "1" {
          await store.connectionChanged(ConnectionStatus(.ready))
        }

        await harness.settle()
        continue
      }

      if let method = frame["method"]?.stringValue, let id = frame["id"]?.stringValue {
        link.raise(id: id, method: method, params: frame["params"]?.objectValue ?? [:], index: index)
        try await eventually("the \(method) card") {
          await store.state(of: self.profile)?.byRequestID[id] != nil
        }

        // The reader answers, as the recorded client did at once.
        if let answer = argument(of: "answerRequest"), answer.count == 2 {
          if method == "approval" {
            try await store.respondApproval(profile, requestID: id, choice: answer[1].stringValue ?? "")
          } else if case .object(let answers) = answer[1] {
            let record = JSRecord(answers.compactMap { key, value in value.stringValue.map { (key, $0) } }.sorted { $0.0 < $1.0 })
            try await store.respondClarify(profile, requestID: id, answers: record)
          }
        }

        await harness.settle()
        continue
      }

      guard let result = frame["result"] else {
        continue
      }

      let method = Self.method(ofResult: result)

      switch method {
      case RPC.ProfilesList.name where connection == "1":
        tasks.append(Task { _ = try await harness.roster.refresh() })
      case RPC.SessionResume.name where connection == "1":
        try await eventually("the roster") { await harness.roster.bot(named: self.profile) != nil }
        let bot = await harness.roster.bot(named: profile)!
        opened = Task { try await store.open(bot) }
      case RPC.PromptSubmit.name:
        let text = argument(of: "beginLocalTurn")?.first?.stringValue ?? ""
        tasks.append(Task { _ = try await store.send(profile, text: text) })
      default:
        break
      }

      try await link.answerNext(method, result, index: index)
      await harness.settle()

      if method == RPC.SessionEventsSince.name, connection == "1", let opening = opened {
        try await opening.value
        await harness.settle()
        await check("hydrated")
      }
    }

    try await opened?.value

    for task in tasks {
      try await task.value
    }

    // A recovery runs on its own; it is done when its task is and the chat is live again.
    try await eventually("the chat to be live") {
      let idle = await store.liveTaskCount == 0
      let hydration = await store.state(of: self.profile)?.hydration
      return idle && hydration == .live
    }

    await harness.settle()
    await check("hydrated")

    for label in checkpoints.map(\.label) {
      await check(label)
    }

    let state = await harness.state(profile)

    for line in jsonDifferences(final, state.jsonValue, path: "final") {
      mismatches.append(line)
    }

    if compared != self.checkpoints.count {
      mismatches.append("checkpoints compared: \(compared) of \(self.checkpoints.count)")
    }

    if sequence.used != engineNows.count {
      mismatches.append("engine calls with a clock: \(sequence.used), recorded \(engineNows.count)")
    }

    await harness.shutdown()
    return mismatches
  }
}

/// Where two JSON values differ, as `path: expected ≠ actual` lines (at most a few).
func jsonDifferences(_ expected: JSONValue, _ actual: JSONValue, path: String, limit: Int = 12) -> [String] {
  var lines: [String] = []

  func walk(_ expected: JSONValue, _ actual: JSONValue, _ path: String) {
    guard lines.count < limit else {
      return
    }

    switch (expected, actual) {
    case (.object(let lhs), .object(let rhs)):
      for key in Set(lhs.keys).union(rhs.keys).sorted() {
        walk(lhs[key] ?? .null, rhs[key] ?? .null, "\(path).\(key)")
      }
    case (.array(let lhs), .array(let rhs)):
      if lhs.count != rhs.count {
        lines.append("\(path): \(lhs.count) elements ≠ \(rhs.count)")
      }

      for (offset, pair) in zip(lhs, rhs).enumerated() {
        walk(pair.0, pair.1, "\(path)[\(offset)]")
      }
    default:
      if expected != actual {
        let show = { (value: JSONValue) in String(((try? value.canonicalString()) ?? "?").prefix(160)) }
        lines.append("\(path): \(show(expected)) ≠ \(show(actual))")
      }
    }
  }

  walk(expected, actual, path)
  return lines
}
