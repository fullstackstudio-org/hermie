import Foundation
import HermieProtocol
import HermieTranscript

/// One `contract/transcript/streams/<scenario>.json` (`contract/README.md`,
/// "Replaying `transcript/streams/`").
struct GoldenStream: Sendable {
  struct Step: Sendable {
    let index: Int
    let op: String
    /// Without the state: each step's first parameter is the state the previous one produced.
    let args: [JSONValue]
    let frame: Int?
  }

  struct Checkpoint: Sendable {
    /// Taken after this many steps.
    let after: Int
    let label: String
    /// `visibleItems(state, { level, showBotToBot: true, showThinking: true })` per level.
    let visible: JSONObject
  }

  let name: String
  let steps: [Step]
  let checkpoints: [Checkpoint]
  let final: JSONValue

  static func load(_ name: String) throws -> GoldenStream {
    let json = try GoldenCorpus.loadJSON(GoldenCorpus.streamsDirectory.appendingPathComponent("\(name).json"))
    guard let steps = json["steps"]?.arrayValue, let checkpoints = json["checkpoints"]?.arrayValue, let final = json["final"]
    else { throw GoldenHarnessError("\(name).json is not a stream scenario") }

    return GoldenStream(
      name: name,
      steps: try steps.enumerated().map { index, step in
        guard let op = step["op"]?.stringValue, let args = step["args"]?.arrayValue else {
          throw GoldenHarnessError("\(name).json: malformed step \(index)")
        }
        return Step(index: index, op: op, args: args, frame: step["frame"]?.intValue)
      },
      checkpoints: try checkpoints.map { checkpoint in
        guard let after = checkpoint["after"]?.intValue, let visible = checkpoint["visible"]?.objectValue else {
          throw GoldenHarnessError("\(name).json: malformed checkpoint")
        }
        return Checkpoint(after: after, label: checkpoint["label"]?.stringValue ?? "", visible: visible)
      },
      final: final
    )
  }
}

/// What replaying one scenario came to.
struct StreamResult: Sendable {
  enum Status: Sendable, Equatable {
    case passed
    /// Some step's operation is not registered yet; nothing was compared.
    case pending(missing: [String])
    case failed
  }

  let name: String
  var status: Status = .passed
  var steps = 0
  var checkpointsCompared = 0
  /// Checkpoints not compared because `visibleItems` is not registered yet.
  var checkpointsPending = 0
  var failures: [String] = []
}

enum GoldenStreamRunner {
  /// The store's own update, which is not an engine function: `{ ...state, ...fields }`,
  /// then every key in `remove` deleted. Run through `ChatState` so the result is a
  /// state the Swift types accept.
  static func patchState(_ state: JSONValue, _ fields: JSONValue?, _ remove: JSONValue?) throws -> JSONValue {
    guard var object = state.objectValue else { throw GoldenHarnessError("patchState: the state is not an object") }
    for (key, value) in fields?.objectValue ?? [:] { object[key] = value }
    for key in remove?.arrayValue ?? [] {
      if let key = key.stringValue { object[key] = nil }
    }
    return try ChatState(decoding: .object(object)).jsonValue
  }

  static func replay(_ name: String) -> StreamResult {
    var result = StreamResult(name: name)
    let stream: GoldenStream

    do {
      stream = try GoldenStream.load(name)
    } catch {
      result.status = .failed
      result.failures = ["could not load: \(error)"]
      return result
    }

    result.steps = stream.steps.count
    let missing = Set(stream.steps.map(\.op))
      .subtracting(["createChatState", "patchState"])
      .filter { GoldenRegistry.operations[$0] == nil }
      .union(GoldenRegistry.operations["createChatState"] == nil ? ["createChatState"] : [])

    if !missing.isEmpty {
      result.status = .pending(missing: missing.sorted())
      result.checkpointsPending = stream.checkpoints.count
      return result
    }

    let visibleItems = GoldenRegistry.operations["visibleItems"]
    var state: JSONValue = .null
    var checkpoints = stream.checkpoints[...]

    func compareCheckpoints(after count: Int) {
      while let checkpoint = checkpoints.first, checkpoint.after <= count {
        checkpoints = checkpoints.dropFirst()
        guard let visibleItems else {
          result.checkpointsPending += 1
          continue
        }
        result.checkpointsCompared += 1
        for (level, expected) in checkpoint.visible.sorted(by: { $0.key < $1.key }) {
          let options: JSONValue = ["level": .string(level), "showBotToBot": true, "showThinking": true]
          do {
            let actual = try visibleItems(GoldenArgs([state, options])) ?? .null
            if case .different(let lines) = GoldenCompare.compare(expected: expected, actual: actual) {
              let title = "checkpoint \"\(checkpoint.label)\" (after \(checkpoint.after)) level \(level)"
              result.failures.append("\(title):\n  " + lines.joined(separator: "\n  "))
            }
          } catch {
            result.failures.append("checkpoint \"\(checkpoint.label)\" level \(level): visibleItems threw \(error)")
          }
        }
      }
    }

    compareCheckpoints(after: 0)

    for step in stream.steps {
      do {
        switch step.op {
        case "createChatState":
          state = try GoldenRegistry.operations["createChatState"]!(GoldenArgs(step.args)) ?? .null
        case "patchState":
          state = try patchState(state, step.args.first, step.args.count > 1 ? step.args[1] : nil)
        default:
          state = try GoldenRegistry.operations[step.op]!(GoldenArgs([state] + step.args)) ?? .null
        }
      } catch {
        result.failures.append("step \(step.index) \(step.op) (frame \(step.frame.map(String.init) ?? "-")) threw \(error)")
        result.status = .failed
        return result
      }
      compareCheckpoints(after: step.index + 1)
    }

    if case .different(let lines) = GoldenCompare.compare(expected: stream.final, actual: state) {
      result.failures.append("final state:\n  " + lines.joined(separator: "\n  "))
    }

    result.status = result.failures.isEmpty ? .passed : .failed
    return result
  }
}
