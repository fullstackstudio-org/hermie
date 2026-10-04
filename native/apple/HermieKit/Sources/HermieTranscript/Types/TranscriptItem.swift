import HermieProtocol

/// `TranscriptItem`: one of the item kinds, discriminated by `kind`.
///
/// `indirect`, so every payload lives in its own immutable box and the enum is one
/// pointer wide. That keeps `ChatState.items` small and makes copying it — which the
/// first mutation after a snapshot was published does — one retain per item rather
/// than a field-by-field copy of every struct.
///
/// Mutating an item in place: read the payload, mutate it, write it back
/// (`if case .assistant(var item) = state.items[id] { …; state.items[id] = .assistant(item) }`)
/// mirrors the TypeScript spread directly, and is fine for anything but text that
/// grows. For that, use the `update…` methods (`state.items[id]?.updateAssistant { $0.text += delta }`):
/// they take the payload out of the box before handing it over, so a string being
/// appended to is uniquely referenced and grows in place instead of being copied.
public indirect enum TranscriptItem: TranscriptJSONCodable, Hashable {
  case approval(ApprovalItem)
  case assistant(AssistantItem)
  case botDmIn(BotDmInItem)
  case botDmOut(BotDmOutItem)
  case clarify(ClarifyItem)
  case cronDelivery(CronDeliveryItem)
  case notice(NoticeItem)
  case request(RequestItem)
  case status(StatusItem)
  case subagentGroup(SubagentGroupItem)
  case tool(ToolItem)
  case user(UserItem)
  /// A kind this build does not know; kept whole.
  case unknown(UnknownItem)

  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    guard case .object(let object) = json else {
      throw TranscriptDecodingError(path: path, message: "expected a transcript item object, found \(JSONKind.of(json))")
    }
    guard case .string(let kind)? = object["kind"] else {
      throw TranscriptDecodingError(path: JSONPath.member(path, "kind"), message: "missing the item's kind")
    }
    switch TranscriptItemKind.named(kind) {
    case .approval: self = .approval(try ApprovalItem(decoding: json, at: path))
    case .assistant: self = .assistant(try AssistantItem(decoding: json, at: path))
    case .botDmIn: self = .botDmIn(try BotDmInItem(decoding: json, at: path))
    case .botDmOut: self = .botDmOut(try BotDmOutItem(decoding: json, at: path))
    case .clarify: self = .clarify(try ClarifyItem(decoding: json, at: path))
    case .cronDelivery: self = .cronDelivery(try CronDeliveryItem(decoding: json, at: path))
    case .notice: self = .notice(try NoticeItem(decoding: json, at: path))
    case .request: self = .request(try RequestItem(decoding: json, at: path))
    case .status: self = .status(try StatusItem(decoding: json, at: path))
    case .subagentGroup: self = .subagentGroup(try SubagentGroupItem(decoding: json, at: path))
    case .tool: self = .tool(try ToolItem(decoding: json, at: path))
    case .user: self = .user(try UserItem(decoding: json, at: path))
    case .other(let raw): self = .unknown(try UnknownItem(decoding: json, kind: raw, at: path))
    }
  }

  public var jsonValue: JSONValue {
    switch self {
    case .approval(let item): item.jsonValue
    case .assistant(let item): item.jsonValue
    case .botDmIn(let item): item.jsonValue
    case .botDmOut(let item): item.jsonValue
    case .clarify(let item): item.jsonValue
    case .cronDelivery(let item): item.jsonValue
    case .notice(let item): item.jsonValue
    case .request(let item): item.jsonValue
    case .status(let item): item.jsonValue
    case .subagentGroup(let item): item.jsonValue
    case .tool(let item): item.jsonValue
    case .user(let item): item.jsonValue
    case .unknown(let item): item.jsonValue
    }
  }

  /// `item.kind`.
  public var kind: TranscriptItemKind {
    switch self {
    case .approval: .approval
    case .assistant: .assistant
    case .botDmIn: .botDmIn
    case .botDmOut: .botDmOut
    case .clarify: .clarify
    case .cronDelivery: .cronDelivery
    case .notice: .notice
    case .request: .request
    case .status: .status
    case .subagentGroup: .subagentGroup
    case .tool: .tool
    case .user: .user
    case .unknown(let item): .other(item.kindName)
    }
  }

  /// The shared fields, whatever the kind.
  public var base: ItemBase {
    get {
      switch self {
      case .approval(let item): item.base
      case .assistant(let item): item.base
      case .botDmIn(let item): item.base
      case .botDmOut(let item): item.base
      case .clarify(let item): item.base
      case .cronDelivery(let item): item.base
      case .notice(let item): item.base
      case .request(let item): item.base
      case .status(let item): item.base
      case .subagentGroup(let item): item.base
      case .tool(let item): item.base
      case .user(let item): item.base
      case .unknown(let item): item.base
      }
    }
    set {
      switch self {
      case .approval(var item): item.base = newValue; self = .approval(item)
      case .assistant(var item): item.base = newValue; self = .assistant(item)
      case .botDmIn(var item): item.base = newValue; self = .botDmIn(item)
      case .botDmOut(var item): item.base = newValue; self = .botDmOut(item)
      case .clarify(var item): item.base = newValue; self = .clarify(item)
      case .cronDelivery(var item): item.base = newValue; self = .cronDelivery(item)
      case .notice(var item): item.base = newValue; self = .notice(item)
      case .request(var item): item.base = newValue; self = .request(item)
      case .status(var item): item.base = newValue; self = .status(item)
      case .subagentGroup(var item): item.base = newValue; self = .subagentGroup(item)
      case .tool(var item): item.base = newValue; self = .tool(item)
      case .user(var item): item.base = newValue; self = .user(item)
      case .unknown(var item): item.base = newValue; self = .unknown(item)
      }
    }
  }

  public var id: String {
    get { base.id }
    set { base.id = newValue }
  }

  public var seq: Int {
    get { base.seq }
    set { base.seq = newValue }
  }

  public var ts: Double? {
    get { base.ts }
    set { base.ts = newValue }
  }

  public var rowID: Int? {
    get { base.rowID }
    set { base.rowID = newValue }
  }

  public var origin: ItemOrigin {
    get { base.origin }
    set { base.origin = newValue }
  }

  public var version: Int {
    get { base.version }
    set { base.version = newValue }
  }

  public var reactions: [ItemReaction]? {
    get { base.reactions }
    set { base.reactions = newValue }
  }

  public var turnID: String? {
    get { base.turnID }
    set { base.turnID = newValue }
  }

  /// `callKey` of a kind that can carry one (`tool`, `bot_dm_out`, `subagent_group`);
  /// `nil` for every other kind, and ignored when set on one.
  public var callKey: String? {
    get {
      switch self {
      case .tool(let item): item.callKey
      case .botDmOut(let item): item.callKey
      case .subagentGroup(let item): item.callKey
      default: nil
      }
    }
    set {
      switch self {
      case .tool(var item): item.callKey = newValue; self = .tool(item)
      case .botDmOut(var item): item.callKey = newValue; self = .botDmOut(item)
      case .subagentGroup(var item): item.callKey = newValue; self = .subagentGroup(item)
      default: break
      }
    }
  }

  // MARK: Typed access

  public var asApproval: ApprovalItem? { if case .approval(let item) = self { item } else { nil } }
  public var asAssistant: AssistantItem? { if case .assistant(let item) = self { item } else { nil } }
  public var asBotDmIn: BotDmInItem? { if case .botDmIn(let item) = self { item } else { nil } }
  public var asBotDmOut: BotDmOutItem? { if case .botDmOut(let item) = self { item } else { nil } }
  public var asClarify: ClarifyItem? { if case .clarify(let item) = self { item } else { nil } }
  public var asCronDelivery: CronDeliveryItem? { if case .cronDelivery(let item) = self { item } else { nil } }
  public var asNotice: NoticeItem? { if case .notice(let item) = self { item } else { nil } }
  public var asRequest: RequestItem? { if case .request(let item) = self { item } else { nil } }
  public var asStatus: StatusItem? { if case .status(let item) = self { item } else { nil } }
  public var asSubagentGroup: SubagentGroupItem? { if case .subagentGroup(let item) = self { item } else { nil } }
  public var asTool: ToolItem? { if case .tool(let item) = self { item } else { nil } }
  public var asUser: UserItem? { if case .user(let item) = self { item } else { nil } }

  // MARK: In-place updates

  /// A one-pointer stand-in, assigned while a payload is out of its box.
  private static let placeholder = TranscriptItem.unknown(
    UnknownItem(kindName: "", base: ItemBase(id: "", seq: 0, origin: .live, version: 0))
  )

  /// Runs `body` on the assistant payload in place; `nil` (and nothing runs) for
  /// another kind.
  @discardableResult
  public mutating func updateAssistant<R>(_ body: (inout AssistantItem) throws -> R) rethrows -> R? {
    guard case .assistant(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .assistant(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateTool<R>(_ body: (inout ToolItem) throws -> R) rethrows -> R? {
    guard case .tool(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .tool(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateUser<R>(_ body: (inout UserItem) throws -> R) rethrows -> R? {
    guard case .user(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .user(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateBotDmIn<R>(_ body: (inout BotDmInItem) throws -> R) rethrows -> R? {
    guard case .botDmIn(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .botDmIn(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateBotDmOut<R>(_ body: (inout BotDmOutItem) throws -> R) rethrows -> R? {
    guard case .botDmOut(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .botDmOut(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateSubagentGroup<R>(_ body: (inout SubagentGroupItem) throws -> R) rethrows -> R? {
    guard case .subagentGroup(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .subagentGroup(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateNotice<R>(_ body: (inout NoticeItem) throws -> R) rethrows -> R? {
    guard case .notice(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .notice(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateStatus<R>(_ body: (inout StatusItem) throws -> R) rethrows -> R? {
    guard case .status(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .status(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateCronDelivery<R>(_ body: (inout CronDeliveryItem) throws -> R) rethrows -> R? {
    guard case .cronDelivery(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .cronDelivery(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateApproval<R>(_ body: (inout ApprovalItem) throws -> R) rethrows -> R? {
    guard case .approval(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .approval(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateRequest<R>(_ body: (inout RequestItem) throws -> R) rethrows -> R? {
    guard case .request(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .request(item) }
    return try body(&item)
  }

  @discardableResult
  public mutating func updateClarify<R>(_ body: (inout ClarifyItem) throws -> R) rethrows -> R? {
    guard case .clarify(var item) = self else { return nil }
    self = Self.placeholder
    defer { self = .clarify(item) }
    return try body(&item)
  }
}

extension TranscriptItem: JSONField {}
