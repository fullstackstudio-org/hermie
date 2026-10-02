import HermieProtocol

public struct SubagentStreamEntry: TranscriptJSONCodable, Hashable {
  public var at: Double
  public var kind: SubagentStreamKind
  public var text: String
  public var isError: Bool?
  public var extra: JSONObject

  public init(at: Double, kind: SubagentStreamKind, text: String, isError: Bool? = nil, extra: JSONObject = [:]) {
    self.at = at
    self.kind = kind
    self.text = text
    self.isError = isError
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "SubagentStreamEntry")
    at = try reader.required("at")
    kind = try reader.required("kind")
    text = try reader.required("text")
    isError = reader.optional("isError")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("at", at)
    writer.set("kind", kind)
    writer.set("text", text)
    writer.set("isError", isError)
    return writer.json
  }
}

/// One child of a `delegate_task` fan-out (`Subagent` in `types.ts`).
public struct Subagent: TranscriptJSONCodable, Hashable {
  /// `SubagentStatus` in `types.ts`. Nested because `HermieProtocol` already has a
  /// `SubagentStatus`: the WIRE vocabulary, which also spells `error` and `timeout`;
  /// this is the engine's, which folds those into `failed`.
  public enum Status: OpenVocabulary {
    case queued, running, completed, failed, interrupted
    case other(String)

    public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
    public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

    public static let knownCases: [Status] = [.queued, .running, .completed, .failed, .interrupted]

    public var rawValue: String {
      switch self {
      case .queued: "queued"
      case .running: "running"
      case .completed: "completed"
      case .failed: "failed"
      case .interrupted: "interrupted"
      case .other(let raw): raw
      }
    }
  }

  public var id: String
  /// Always written; `null` for a child the turn itself spawned.
  public var parentID: String?
  public var delegationID: String?
  /// The child's own stored session id, so a UI can open its transcript.
  public var childSessionID: String?
  public var goal: String
  public var model: String?
  public var depth: Double?
  public var taskIndex: Double
  public var taskCount: Double
  public var status: Status
  public var startedAt: Double
  public var updatedAt: Double
  public var durationSeconds: Double?
  public var toolCount: Double?
  public var inputTokens: Double?
  public var outputTokens: Double?
  public var filesRead: [String]
  public var filesWritten: [String]
  /// Capped at `subagentStreamCap` entries.
  public var stream: [SubagentStreamEntry]
  public var summary: String?
  public var currentTool: String?
  public var acceptingSteer: Bool?
  public var extra: JSONObject

  public init(
    id: String,
    parentID: String?,
    delegationID: String? = nil,
    childSessionID: String? = nil,
    goal: String,
    model: String? = nil,
    depth: Double? = nil,
    taskIndex: Double,
    taskCount: Double,
    status: Status,
    startedAt: Double,
    updatedAt: Double,
    durationSeconds: Double? = nil,
    toolCount: Double? = nil,
    inputTokens: Double? = nil,
    outputTokens: Double? = nil,
    filesRead: [String],
    filesWritten: [String],
    stream: [SubagentStreamEntry],
    summary: String? = nil,
    currentTool: String? = nil,
    acceptingSteer: Bool? = nil,
    extra: JSONObject = [:]
  ) {
    self.id = id
    self.parentID = parentID
    self.delegationID = delegationID
    self.childSessionID = childSessionID
    self.goal = goal
    self.model = model
    self.depth = depth
    self.taskIndex = taskIndex
    self.taskCount = taskCount
    self.status = status
    self.startedAt = startedAt
    self.updatedAt = updatedAt
    self.durationSeconds = durationSeconds
    self.toolCount = toolCount
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.filesRead = filesRead
    self.filesWritten = filesWritten
    self.stream = stream
    self.summary = summary
    self.currentTool = currentTool
    self.acceptingSteer = acceptingSteer
    self.extra = extra
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "Subagent")
    id = try reader.required("id")
    parentID = reader.nullable("parentId")
    delegationID = reader.optional("delegationId")
    childSessionID = reader.optional("childSessionId")
    goal = try reader.required("goal")
    model = reader.optional("model")
    depth = reader.optional("depth")
    taskIndex = try reader.required("taskIndex")
    taskCount = try reader.required("taskCount")
    status = try reader.required("status")
    startedAt = try reader.required("startedAt")
    updatedAt = try reader.required("updatedAt")
    durationSeconds = reader.optional("durationSeconds")
    toolCount = reader.optional("toolCount")
    inputTokens = reader.optional("inputTokens")
    outputTokens = reader.optional("outputTokens")
    filesRead = try reader.required("filesRead")
    filesWritten = try reader.required("filesWritten")
    stream = try reader.required("stream")
    summary = reader.optional("summary")
    currentTool = reader.optional("currentTool")
    acceptingSteer = reader.optional("acceptingSteer")
    extra = reader.residue
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: extra)
    writer.set("id", id)
    writer.setNullable("parentId", parentID)
    writer.set("delegationId", delegationID)
    writer.set("childSessionId", childSessionID)
    writer.set("goal", goal)
    writer.set("model", model)
    writer.set("depth", depth)
    writer.set("taskIndex", taskIndex)
    writer.set("taskCount", taskCount)
    writer.set("status", status)
    writer.set("startedAt", startedAt)
    writer.set("updatedAt", updatedAt)
    writer.set("durationSeconds", durationSeconds)
    writer.set("toolCount", toolCount)
    writer.set("inputTokens", inputTokens)
    writer.set("outputTokens", outputTokens)
    writer.set("filesRead", filesRead)
    writer.set("filesWritten", filesWritten)
    writer.set("stream", stream)
    writer.set("summary", summary)
    writer.set("currentTool", currentTool)
    writer.set("acceptingSteer", acceptingSteer)
    return writer.json
  }
}

extension Subagent.Status: JSONField {}
extension SubagentStreamEntry: JSONField {}
extension Subagent: JSONField {}
