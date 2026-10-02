import HermieProtocol

// What the bot is doing right now, in one word (`turn-activity.ts`).
//
// The header used to say `Working…` for the whole of a turn, which is true and
// says nothing: a turn is the model thinking, then writing, then running a
// command, then waiting on the reader, and the one line under the bot's name is
// the only place a reader can see which. So this reads the same `ChatState` the
// transcript renders and answers with the narrowest thing it can prove.
//
// It is derived from STATE, not from the event that just arrived. A selector
// that latched on events would have to be told when to let go, and the thing it
// would have to let go on — `message.complete` — is exactly the event a dropped
// socket loses. Reading the state back means a chat that reconnects mid-turn
// says the right thing without anything having to remember.

public enum TurnActivity: TranscriptJSONCodable, Hashable {
  /// Nothing running: the header falls back to the connection's own label.
  case idle
  /// A turn is running and has not yet said what it is.
  case working
  /// Reasoning is arriving and no words have.
  case thinking
  /// Words are arriving, or a preview of them has.
  case typing
  /// A tool call is running, or one has been announced by name.
  case tool(String)
  /// An approval or a clarify is open: the turn is blocked on a person.
  case waiting
  /// A `delegate_task` fan-out has children still going.
  case delegating

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "TurnActivity")
    let kind: String = try reader.required("kind")
    switch kind {
    case "idle": self = .idle
    case "working": self = .working
    case "thinking": self = .thinking
    case "typing": self = .typing
    case "tool": self = .tool(try reader.required("tool"))
    case "waiting": self = .waiting
    case "delegating": self = .delegating
    default: throw TranscriptDecodingError(path: JSONPath.member(path, "kind"), message: "unknown turn activity \"\(kind)\"")
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .idle: ["kind": "idle"]
    case .working: ["kind": "working"]
    case .thinking: ["kind": "thinking"]
    case .typing: ["kind": "typing"]
    case .tool(let tool): ["kind": "tool", "tool": .string(tool)]
    case .waiting: ["kind": "waiting"]
    case .delegating: ["kind": "delegating"]
    }
  }
}

/// The one thing this chat's turn is doing, by the order of how badly each
/// answer wants the reader.
///
/// `waiting` is first and is the only one that survives an inactive turn. An
/// approval parked with "Later" leaves the agent blocked while the turn itself is
/// over, and a header that goes back to `Online` over a question nobody has
/// answered is the app forgetting on the reader's behalf. Everything below it is
/// a statement about a RUNNING turn and is read newest-first, because what the
/// bot is doing is whatever it started most recently.
public func turnActivity(_ chat: ChatState) -> TurnActivity {
  for id in chat.order {
    switch chat.items[id] {
    case .approval(let item)? where item.state == .open: return .waiting
    case .clarify(let item)? where item.state == .open: return .waiting
    default: continue
    }
  }

  if !chat.turn.active {
    return .idle
  }

  // Announced by `tool.generating` before the call has an id — so before there
  // is a row to find below. It is the earliest moment the name is knowable.
  if let draftingTool = chat.turn.draftingTool, !draftingTool.isEmpty {
    return .tool(draftingTool)
  }

  if chat.subagents.values.contains(where: { $0.status == .queued || $0.status == .running }) {
    return .delegating
  }

  for id in chat.order.reversed() {
    switch chat.items[id] {
    case .tool(let item)? where item.status == .running || item.status == .generating:
      return .tool(item.name)
    case .assistant(let item)? where item.streaming || item.interim:
      // An interim counts as typing: the preview is the reply so far, and the
      // rest of it is still coming.
      return JS.trim(item.text).isEmpty ? .thinking : .typing
    default:
      continue
    }
  }

  // `message.start` has landed and nothing else has. Honest rather than a guess
  // at which of the two comes next.
  return .working
}
