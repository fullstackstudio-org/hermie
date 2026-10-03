import Foundation
import HermieProtocol

// History projection: transcript rows → transcript items (`rows-to-items.ts`).
//
// The same function serves the RPC `session.history` shape and the REST
// `GET /api/sessions/{id}/messages` shape, so a chat painted from cache, from
// history and from live events is one item model with one renderer.
//
// Ported from `apps/desktop/src/lib/chat-messages/hydration.ts` and the
// gateway's own projection in `tui_gateway/session_history.py`.
//
// A row is read off its raw JSON (`TranscriptRow.json`) rather than through the
// typed accessors, because the TypeScript's `??` chains and `typeof` checks decide
// on the raw value: `row.row_id ?? row.id` picks a `row_id` of the wrong type over
// a good `id`, and `null` falls through where a wrong type does not.
//
// The matching keys reconciliation pairs on (`normalizeMatchText`, `itemMatchKey`,
// …) are in `RowsToItemsMatching.swift`.

/// `RowShape`: which alias of the same field a transport prefers.
public enum RowShape: String, Sendable, Hashable {
  case rpc, rest
}

/// `RowsToItemsOptions`.
public struct RowsToItemsOptions: Sendable, Hashable {
  /// The origin every projected item carries; `history` when absent.
  public var origin: ItemOrigin?

  public init(origin: ItemOrigin? = nil) {
    self.origin = origin
  }
}

// MARK: - Row patterns

enum RowPatterns {
  /// `ATTACHED_CONTEXT_MARKER_RE`: `/(?:^|\n)--- Attached Context ---\s*\n/u`
  static let attachedContextMarker = JSRegExp(#"(?:^|\n)--- Attached Context ---"# + JSPattern.s + #"*\n"#)

  /// `CONTEXT_WARNINGS_MARKER_RE`: `/(?:^|\n)--- Context Warnings ---[\s\S]*$/u`
  static let contextWarningsMarker = JSRegExp(#"(?:^|\n)--- Context Warnings ---[\s\S]*"# + JSPattern.end)

  /// `CONTEXT_REF_RE`: ``/@(?:file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/gu``
  static let contextRef = JSRegExp(
    #"@(?:file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|"# + JSPattern.S + "+)"
  )

  /// `ATTACHMENT_REF_RE`: ``/@(?:file|image):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/gu``
  static let attachmentRef = JSRegExp(#"@(?:file|image):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|"# + JSPattern.S + "+)")

  /// `ATTACHMENT_SCHEME_RE`: `/^@(file|image):/u`
  static let attachmentScheme = JSRegExp("^@(file|image):")

  /// Gateway routing note for Discord turns (`gateway/run_inbound.py`); current
  /// gateways persist the authored text, this heals rows written before that fix.
  ///
  /// `DISCORD_TRIGGERING_NOTE_RE`:
  /// ``/(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply\/react\/pin via the discord tools\.\]\n*/u``
  static let discordTriggeringNote = JSRegExp(
    #"(^|\n)\[Triggering message id: `[^`\n]*` — use as `message_id` for reply/react/pin via the discord tools\.\]\n*"#
  )

  /// `/[ \t]{2,}/gu`
  static let blankRun = JSRegExp(#"[ \t]{2,}"#)

  /// ``/^[`"']|[`"']$/gu``
  static let refQuotes = JSRegExp(#"^[`"']|[`"']"# + JSPattern.end)

  /// `/[/\\]/u`
  static let pathSeparator = JSRegExp(#"[/\\]"#)
}

// MARK: - Reading a row's raw values

/// `a ?? b ?? c` over raw JSON: the first value that is neither absent nor `null`.
private func coalesce(_ values: JSONValue?...) -> JSONValue? {
  for value in values {
    if let value, value != .null { return value }
  }
  return nil
}

/// `asText`: a string as itself, an array of content parts joined by newlines,
/// anything else `''`.
private func asText(_ value: JSONValue?) -> String {
  switch value {
  case .string(let text)?:
    return text
  case .array(let parts)?:
    return parts.map { part -> String in
      switch part {
      case .object(let object): asText(object["text"])
      // An array is an object in JavaScript: `part.text` is `undefined`.
      case .array: ""
      default: asText(part)
      }
    }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
  default:
    return ""
  }
}

/// `asNumber`: a finite number, else `undefined`.
private func asNumber(_ value: JSONValue?) -> Double? {
  guard case .number(let number)? = value, number.isFinite else { return nil }
  return number
}

/// `asObject`: an object, or a string holding (a string holding …) a JSON object.
private func asObject(_ value: JSONValue?) -> JSONObject? {
  switch value {
  case .string(let text)?:
    guard let parsed = JS.parseJSON(text) else { return nil }
    return asObject(parsed)
  case .object(let object)?:
    return object
  default:
    return nil
  }
}

/// The non-empty string at `value`, else `nil` (`typeof v === 'string' && v`).
private func nonEmptyString(_ value: JSONValue?) -> String? {
  guard case .string(let text)? = value, !text.isEmpty else { return nil }
  return text
}

/// Reply text from a Responses-API `codex_message_items` sidecar, for rows whose
/// content persisted empty. `commentary` / `analysis` phases are mid-turn
/// narration routed to the reasoning channel, not the reply.
private func codexMessageItemText(_ value: JSONValue?) -> String {
  var items = value

  if case .string(let text)? = items {
    guard let parsed = JS.parseJSON(text) else { return "" }
    items = parsed
  }

  guard case .array(let list)? = items else {
    return ""
  }

  var texts: [String] = []

  for item in list {
    guard let record = asObject(item), record["type"] == "message", record["role"] == "assistant" else {
      continue
    }

    if record["phase"] == "commentary" || record["phase"] == "analysis" {
      continue
    }

    guard case .array(let content)? = record["content"] else {
      continue
    }

    for part in content {
      let partRecord = asObject(part)
      let partType = partRecord?["type"]

      if partType != "output_text" && partType != "text" {
        continue
      }

      if let text = nonEmptyString(partRecord?["text"]) {
        texts.append(text)
      }
    }
  }

  return texts.joined()
}

// MARK: - stripUserText

/// `StrippedUserText`.
public struct StrippedUserText: TranscriptJSONCodable, Hashable {
  public var text: String
  public var attachments: [String]?

  public init(text: String, attachments: [String]? = nil) {
    self.text = text
    self.attachments = attachments
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "StrippedUserText")
    text = try reader.required("text")
    attachments = reader.optional("attachments")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("text", text)
    writer.set("attachments", attachments)
    return writer.json
  }
}

/// Drop the model-facing scaffolding from a persisted user turn: the attached
/// context block, the context-warnings tail, and the `@image:` / `@file:`
/// directive lines the gateway rewrites in at persist time.
public func stripUserText(_ raw: String) -> StrippedUserText {
  // `raw.replace(DISCORD_TRIGGERING_NOTE_RE, '$1')`
  var textContent = raw
  if let note = RowPatterns.discordTriggeringNote.exec(raw) {
    textContent = JS.substring(raw, 0, note.index) + (note[1] ?? "") + JS.substring(raw, note.index + note.length)
  }

  var visible: String

  if let marker = RowPatterns.attachedContextMarker.exec(textContent) {
    visible = JS.trim(
      RowPatterns.contextWarningsMarker.replaceFirst(in: JS.substring(textContent, 0, marker.index), with: "")
    )

    let attachedContext = JS.substring(textContent, marker.index + marker.length)
    let refs = JS.unique(RowPatterns.contextRef.allMatches(in: attachedContext))
    // The prose keeps the `@file:` token the user typed, so it already chips in
    // place. Only hoist a ref the prose is missing.
    let missing = refs.filter { !JS.includes(visible, $0) }

    let joined = [missing.joined(separator: "\n"), visible].filter { !$0.isEmpty }.joined(separator: "\n\n")
    visible = joined.isEmpty ? visible : joined
  } else {
    visible = JS.trim(RowPatterns.contextWarningsMarker.replaceFirst(in: textContent, with: ""))
  }

  let attachments = JS.unique(RowPatterns.attachmentRef.allMatches(in: visible))

  if attachments.isEmpty {
    return StrippedUserText(text: visible)
  }

  let lines = JS.split(RowPatterns.attachmentRef.replaceAll(in: visible, with: ""), "\n")
    .map { JS.trim(RowPatterns.blankRun.replaceAll(in: $0, with: " ")) }
  let cleaned = JS.trim(
    lines.enumerated()
      // A directive line that held nothing but refs leaves a hole; collapse runs
      // of blank lines rather than opening a gap in the bubble.
      .filter { index, line in !line.isEmpty || (index > 0 && !JS.trim(lines[index - 1]).isEmpty) }
      .map(\.element)
      .joined(separator: "\n")
  )

  return StrippedUserText(text: cleaned, attachments: attachments)
}

// MARK: - classifyUserRow

/// What a `role: "user"` row turns out to be (`UserRowClass`).
///
/// `bot_dm_reply` is the delivery runner handing a teammate's answer back. It is
/// bot-to-bot traffic, so it never becomes speech; what it becomes is decided by
/// the caller, because the answer belongs on the dispatch that asked for it and
/// only a caller holding the transcript can find that dispatch.
public enum UserRowClass: TranscriptJSONCodable, Hashable {
  case cronDelivery(ParsedCronDelivery)
  case botDmIn(IncomingBotMessage)
  case botDmReply
  case notice(InjectedRow)
  case user(text: String, attachments: [String]?, steered: Bool)

  // Spelled out: the synthesised `Codable` of an enum with payloads is not this shape.
  public init(from decoder: any Decoder) throws { self = try Self.decoded(from: decoder) }
  public func encode(to encoder: any Encoder) throws { try jsonValue.encode(to: encoder) }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "UserRowClass")
    let kind: String = try reader.required("kind")
    switch kind {
    case "cron_delivery": self = .cronDelivery(try reader.requiredNested("cron"))
    case "bot_dm_in": self = .botDmIn(try reader.requiredNested("incoming"))
    case "bot_dm_reply": self = .botDmReply
    case "notice": self = .notice(try reader.requiredNested("injected"))
    case "user":
      self = .user(
        text: try reader.required("text"),
        attachments: reader.optional("attachments"),
        steered: try reader.required("steered")
      )
    default:
      throw TranscriptDecodingError(path: JSONPath.member(path, "kind"), message: "unknown user row class \"\(kind)\"")
    }
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    switch self {
    case .cronDelivery(let cron):
      writer.set("kind", "cron_delivery")
      writer.set("cron", cron)
    case .botDmIn(let incoming):
      writer.set("kind", "bot_dm_in")
      writer.set("incoming", incoming)
    case .botDmReply:
      writer.set("kind", "bot_dm_reply")
    case .notice(let injected):
      writer.set("kind", "notice")
      writer.set("injected", injected)
    case .user(let text, let attachments, let steered):
      writer.set("kind", "user")
      writer.set("text", text)
      writer.set("attachments", attachments)
      writer.set("steered", steered)
    }
    return writer.json
  }
}

/// The ONE place a `role: "user"` row is classified.
///
/// Hermes starts a turn by writing a `user` row and running the agent on it, and
/// only some of those rows are the owner typing. Which one this is, is a question
/// about the text — so it has exactly one answer, and this is where it is given.
///
/// It exists because there used to be two answers. This module read a persisted
/// row and `readInflightPrompt` read a resume's `inflight.user`, each with its own
/// copy of the same chain, and the copies drifted: a teammate's answer, which
/// arrives as a background-process report, was recognised by neither and painted
/// as the owner's own bubble on both. A single chain is what makes the invariant
/// testable — no bot-to-bot row is ever speech — rather than a promise every new
/// caller has to remember.
///
/// The order is the order of certainty, narrowest convention first. Nothing here
/// touches the wire: every branch is a parser named after the upstream file that
/// writes the string it reads.
///
/// `labelled` (`ClassifyUserRowOptions.labelled`): the gateway labelled this row
/// with a `display_kind` this projection recognised, and the label is a stronger
/// signal than any header heuristic. A labelled row is only ever read for the one
/// convention a label cannot carry: the delivery signature, which rides inside the
/// text of a `steer` or a `skill_invocation` as much as anywhere else.
public func classifyUserRow(_ text: String, labelled: Bool = false) -> UserRowClass {
  if !labelled, let cron = parseCronDelivery(text) {
    return .cronDelivery(cron)
  }

  if let incoming = parseIncomingBotMessage(text) {
    return .botDmIn(incoming)
  }

  // Before the injected-notice parser, which refuses a text carrying a delivery
  // block rather than guessing at its body — and, refusing, used to hand the row
  // on to the speech branch below.
  if !labelled && isBotDmDeliveryReport(text) {
    return .botDmReply
  }

  if !labelled, let injected = parseInjectedRow(text) {
    return .notice(injected)
  }

  // A steer IS the user speaking, so it keeps its bubble — but the wrapper the
  // gateway delivers it in is addressed to the model, not to the reader.
  let unwrapped = stripSteerWrapper(text)
  let stripped = stripUserText(unwrapped ?? text)

  return .user(text: stripped.text, attachments: stripped.attachments, steered: unwrapped != nil)
}

// MARK: - rowsToItems

/// `NOTICE_TITLES`.
private let noticeTitles: [String: String] = [
  "model_switch": "Model changed",
  "personality_switch": "Personality changed",
  "auto_continue": "Resumed interrupted turn",
  "process_complete": "Background process finished",
  "async_delegation_complete": "Background agent work finished",
  "internal_notification": "Internal notification"
]

private func displayText(_ metadata: JSONValue?) -> String? {
  guard case .string(let text)? = asObject(metadata)?["display_text"], !JS.trim(text).isEmpty else {
    return nil
  }
  return text
}

/// `display_metadata.author`, read the same defensive way as every other key
/// this file pulls out of that free-form dict.
///
/// Accepts only a non-empty string `id` and, when present, a string `name` —
/// anything else (a string instead of an object, a missing or non-string id, a
/// `name` of the wrong type) drops the whole author rather than keeping half of
/// it. A partial author is worse than none: it would name someone by an id the
/// gateway never actually stamped this way.
private func authorFromMetadata(_ metadata: JSONValue?) -> MessageAuthor? {
  guard let author = asObject(asObject(metadata)?["author"]) else {
    return nil
  }

  guard case .string(let id)? = author["id"], !id.isEmpty else {
    return nil
  }

  let name = author["name"]

  // `name !== undefined && typeof name !== 'string'`: a `null` name is not undefined.
  if let name, name.stringValue == nil {
    return nil
  }

  return MessageAuthor(id: id, name: name?.stringValue.flatMap { $0.isEmpty ? nil : $0 })
}

private func goalsFromArgs(_ args: JSONObject?) -> [String] {
  guard let args else {
    return []
  }

  if case .string(let goal)? = args["goal"], !JS.trim(goal).isEmpty {
    return [JS.trim(goal)]
  }

  guard case .array(let tasks)? = args["tasks"] else {
    return []
  }

  return tasks.compactMap { task -> String? in
    guard case .string(let goal)? = asObject(task)?["goal"], !JS.trim(goal).isEmpty else { return nil }
    return JS.trim(goal)
  }
}

/// Project rows onto items. `shape` only decides which alias of the same field
/// is preferred — both transports resolve to identical items and identical ids,
/// which is what keeps `reconcile` stable across a REST/RPC switch.
public func rowsToItems(
  _ rows: [TranscriptRow],
  _ shape: RowShape,
  _ options: RowsToItemsOptions = RowsToItemsOptions()
) -> [TranscriptItem] {
  var projection = RowProjection(origin: options.origin ?? .history)
  projection.items.reserveCapacity(rows.count)

  for (index, row) in rows.enumerated() {
    projection.project(row.json, shape: shape, index: index)
  }

  attributeBotReplies(&projection.items)

  return projection.items
}

/// The fields every item one row projects to shares.
private struct RowFacts {
  let content: String
  let rowID: Int?
  let ts: Double?
  let fallbackID: String
  /// The turn a `role:user` row opened, kept on whatever the row becomes: a turn
  /// the gateway started itself has no bubble of the owner's, and its placeholder
  /// is settled by this id alone.
  let turnID: String?
}

/// `rowsToItems`'s running state: the items so far, plus two indices that answer
/// the TypeScript's backward scans without walking the whole list each time.
private struct RowProjection {
  let origin: ItemOrigin
  var items: [TranscriptItem] = []
  /// `lastOpenGroup`: indices of the `subagent_group` items not yet `done` or
  /// `failed`. A group is born `dispatched` and only `closeOpenGroup` changes its
  /// status, always on the last open one, so a stack answers the scan exactly.
  var openGroups: [Int] = []
  /// `lastDmOutTo`: indices of the `bot_dm_out` items with no `reply` yet, in
  /// order. A reply is only ever set by `processComplete`, which takes the index
  /// out again.
  var openDispatches: [Int] = []

  init(origin: ItemOrigin) {
    self.origin = origin
  }

  /// `push`'s `seq` / `version` / `origin`.
  func base(_ facts: RowFacts, id: String) -> ItemBase {
    ItemBase(
      id: id, seq: items.count * seqStep, ts: facts.ts, rowID: facts.rowID, origin: origin, version: 0,
      turnID: facts.turnID
    )
  }

  /// The index of the nearest still-unanswered dispatch to `handle` (any handle
  /// when it is empty).
  func lastDmOutTo(_ handle: String) -> Int? {
    openDispatches.last { index in
      guard case .botDmOut(let item) = items[index] else { return false }
      return handle.isEmpty || JS.same(item.targetHandle, handle)
    }
  }

  mutating func project(_ row: JSONObject, shape: RowShape, index: Int) {
    let role = row["role"]?.stringValue ?? ""
    let displayKind = row["display_kind"]?.stringValue ?? ""

    if displayKind == "hidden" {
      return
    }

    let rawContent =
      shape == .rest
      ? coalesce(row["display_content"], row["content"], row["text"])
      : coalesce(row["text"], row["display_content"], row["content"])
    let rowIDValue = shape == .rest ? coalesce(row["id"], row["row_id"]) : coalesce(row["row_id"], row["id"])
    // `rowId` is a durable row number; the model holds it as an integer (see
    // `ItemBase`), so a fractional one reads as absent.
    let rowID = asNumber(rowIDValue).flatMap { Int(exactly: $0) }
    let facts = RowFacts(
      content: asText(rawContent),
      rowID: rowID,
      ts: asNumber(row["timestamp"]),
      fallbackID: rowID.map { "r:\($0)" } ?? "\(role.isEmpty ? "x" : role):\(index)",
      turnID: role == "user" ? turnIDOfMetadata(row["display_metadata"]) : nil
    )

    if role == "tool" {
      projectTool(row, facts, index: index)
      return
    }

    if role == "assistant" {
      projectAssistant(row, facts)
      return
    }

    if role != "user" && role != "system" {
      return
    }

    projectMessage(row, facts, role: role, displayKind: displayKind)
  }

  private mutating func projectTool(_ row: JSONObject, _ facts: RowFacts, index: Int) {
    let name = row["name"]?.stringValue ?? "tool"
    let callKey = callKeyOf(row)
    // RPC history names the call `tool_call_id`, the stored row (REST) `tool_id`.
    // `tool_call_id` only counts on a row that carries the call identity: the
    // provider's id (`call_0`) is reused turn after turn, so on an older gateway
    // it must not name a card, or a later turn's `tool.complete` would overwrite
    // the earlier turn's history card.
    let toolID =
      nonEmptyString(row["tool_id"])
      ?? (callKey != nil ? nonEmptyString(row["tool_call_id"]) : nil)
      ?? "row-\(index)"
    let args = coalesce(row["args"])
    let argsObject = args?.objectValue
    let context = nonEmptyString(row["context"])

    if name == "message_agent" {
      let target = argsObject?["target"]?.stringValue ?? ""
      openDispatches.append(items.count)
      items.append(
        .botDmOut(
          BotDmOutItem(
            base: base(facts, id: "t:\(toolID)"),
            toolID: toolID,
            target: target,
            targetHandle: normalizeAgentTarget(target),
            message: argsObject?["message"]?.stringValue ?? "",
            callKey: callKey,
            // History never carries the tool result, so the dispatch outcome is
            // unknown until a `process_complete` row joins the reply back in.
            dispatch: BotDmDispatch(status: .unknown)
          )
        )
      )
      return
    }

    if name == "delegate_task" {
      openGroups.append(items.count)
      items.append(
        .subagentGroup(
          SubagentGroupItem(
            base: base(facts, id: "t:\(toolID)"),
            toolID: toolID,
            callKey: callKey,
            goals: goalsFromArgs(argsObject),
            rootIDs: [],
            status: .dispatched
          )
        )
      )
      return
    }

    var tool = ToolItem(
      base: base(facts, id: "t:\(toolID)"),
      toolID: toolID,
      name: name,
      context: context,
      args: argsObject,
      callKey: callKey,
      status: .complete,
      resultKnown: false,
      summary: context
    )
    // `...(args ? { args } : {})`: truthy `args` that is not an object has no typed
    // home, so it rides in `extra` and is written back as it came.
    if argsObject == nil, let args, JS.truthy(args) {
      tool.extra["args"] = args
    }
    items.append(.tool(tool))
  }

  private mutating func projectAssistant(_ row: JSONObject, _ facts: RowFacts) {
    let reasoning =
      nonEmptyString(row["reasoning"]) ?? nonEmptyString(row["reasoning_content"])
      ?? nonEmptyString(row["reasoning_details"]) ?? ""
    let text = facts.content.isEmpty ? codexMessageItemText(row["codex_message_items"]) : facts.content

    if text.isEmpty && reasoning.isEmpty {
      return
    }

    items.append(
      .assistant(
        AssistantItem(
          base: base(facts, id: facts.fallbackID),
          text: text,
          reasoning: reasoning.isEmpty ? nil : reasoning,
          streaming: false,
          interim: false,
          status: .complete
        )
      )
    )
  }

  /*
    Every notice this projection builds goes through here, and the body loses
    its `[System: …]` wrapper on the way.

    One place rather than one per `display_kind`, because the wrapper is not a
    property of any one label: the gateway writes the same bracketed sentence
    for a model switch, a personality change and an auto-continue, older
    gateways wrote it with no label at all, and `parseInjectedRow` takes it off
    on the live path. Two descriptions of one row have to SAY the same thing —
    reconciliation pairs notices on their body — so the unwrap has to happen
    wherever the row came from or the pairing breaks and the reader gets the
    row twice.
  */
  @discardableResult
  private mutating func notice(_ facts: RowFacts, _ noticeKind: NoticeKind, _ title: String, _ body: String?) -> Int {
    let shown = body.map { unwrapSystemNote($0) ?? $0 }
    items.append(
      .notice(
        NoticeItem(
          base: base(facts, id: facts.fallbackID),
          noticeKind: noticeKind,
          title: title,
          body: shown.flatMap { $0.isEmpty ? nil : $0 }
        )
      )
    )
    return items.count - 1
  }

  /// A background process reporting back: the deliveries it carries go onto the
  /// dispatches that spawned them, and whatever is left over becomes a notice.
  ///
  /// One function for two entry points. The gateway labels this row
  /// `process_complete` where it can; where it cannot, the text is all there is
  /// and `classifyUserRow` recognises the delivery signature in it. Both have to
  /// project the SAME items or reconciliation pairs nothing and the reader gets
  /// the row twice — once as a card, once as whatever the other path made of it.
  private mutating func processComplete(_ facts: RowFacts, title: String) {
    let blocks = parseProcessCompleteText(facts.content)
    var leftovers: [String] = []
    var unattributed: [ProcessCompletionBlock] = []

    for block in blocks {
      if !isBotDmDeliveryCommand(block.command) {
        leftovers.append(JS.trim(block.output))
        unattributed.append(block)

        continue
      }

      let outcome = replyFromDeliveryOutput(block.output)
      // History carries no tool result, so there is no process id to join on:
      // fall back to the nearest still-unanswered dispatch to that handle.
      guard let target = lastDmOutTo(deliveryTargetFromCommand(block.command) ?? "") else {
        leftovers.append(outcome.text ?? outcome.error ?? JS.trim(block.output))
        unattributed.append(block)

        continue
      }

      let error = outcome.error.flatMap { $0.isEmpty ? nil : $0 }
      items[target].updateBotDmOut { dispatch in
        dispatch.reply = BotDmReply(
          text: outcome.text ?? "",
          ts: facts.ts,
          rowID: facts.rowID,
          error: error,
          reason: outcome.reason.flatMap { $0.isEmpty ? nil : $0 }
        )
        dispatch.dispatch.status =
          error != nil ? .failed : dispatch.dispatch.status == .unknown ? .queued : dispatch.dispatch.status
        dispatch.version += 1
      }
      openDispatches.removeAll { $0 == target }
    }

    let body = leftovers.filter { !$0.isEmpty }.joined(separator: "\n\n")

    if !body.isEmpty || blocks.isEmpty {
      let emitted = notice(facts, .processComplete, title, body.isEmpty ? facts.content : body)

      if !unattributed.isEmpty {
        items[emitted].updateNotice { $0.completions = unattributed }
      }
    }
  }

  /// A fan-out's report closes the group that dispatched it, wherever the row
  /// was recognised: by its `display_kind` here, or by its header below.
  private mutating func closeOpenGroup(_ facts: RowFacts) {
    guard let group = openGroups.popLast() else {
      return
    }

    items[group].updateSubagentGroup { group in
      group.status = .done
      group.completion = facts.content
      group.version += 1
    }
  }

  private mutating func projectMessage(_ row: JSONObject, _ facts: RowFacts, role: String, displayKind: String) {
    let content = facts.content

    if displayKind == "model_switch" || displayKind == "personality_switch" || displayKind == "auto_continue" {
      notice(
        facts,
        NoticeKind(rawValue: displayKind),
        displayText(row["display_metadata"]) ?? noticeTitles[displayKind] ?? displayKind,
        content
      )

      return
    }

    if displayKind == "process_complete" {
      processComplete(facts, title: displayText(row["display_metadata"]) ?? "Background process finished")

      return
    }

    if displayKind == "async_delegation_complete" {
      let title = displayText(row["display_metadata"]) ?? "Background agent work finished"

      closeOpenGroup(facts)
      notice(facts, .asyncDelegationComplete, title, content)

      return
    }

    if displayKind == "internal_notification" {
      notice(facts, .internalNotification, displayText(row["display_metadata"]) ?? "Internal notification", content)

      return
    }

    if !displayKind.isEmpty && displayKind != "skill_invocation" && displayKind != "steer" {
      notice(facts, .unknownDisplayKind, displayKind, content)

      return
    }

    /*
      Everything from here is the one classifier, and the last thing standing
      between a machine's report and the owner's own bubble.

      A row the gateway labelled has already returned above except for
      `skill_invocation` and `steer`, so `labelled` only spares those two the
      header heuristics — the label is a stronger signal than any of them. What
      reaches here unlabelled is an older gateway, a transport that drops
      `display_kind`, or a shape upstream added since. Anything that is not a real
      message must not be drawn as one.
    */
    let classified = role == "user" ? classifyUserRow(content, labelled: !displayKind.isEmpty) : nil
    var stripped: StrippedUserText
    var steered = false

    switch classified {
    case .cronDelivery(let cron):
      items.append(
        .cronDelivery(
          CronDeliveryItem(
            base: base(facts, id: facts.fallbackID),
            jobName: cron.jobName,
            nameRedacted: cron.nameRedacted ? true : nil,
            body: cron.body,
            shape: cron.shape
          )
        )
      )

      return

    case .botDmIn(let incoming):
      items.append(
        .botDmIn(
          BotDmInItem(
            base: base(facts, id: facts.fallbackID),
            senderName: incoming.senderName,
            senderHandle: incoming.senderHandle.flatMap { $0.isEmpty ? nil : $0 },
            text: incoming.body
          )
        )
      )

      return

    // The reply the gateway did not label. It takes the labelled row's branch, so
    // an unlabelled report joins its reply onto the dispatch exactly as a
    // labelled one does instead of falling through to a bubble.
    case .botDmReply:
      processComplete(facts, title: "Background process finished")

      return

    case .notice(let injected):
      if injected.noticeKind == .asyncDelegationComplete {
        closeOpenGroup(facts)
      }

      notice(facts, injected.noticeKind, injected.title, injected.body)

      return

    case .user(let text, let attachments, let wasSteered):
      stripped = StrippedUserText(text: text, attachments: attachments)
      steered = wasSteered

    case nil:
      stripped = stripUserText(content)
    }

    if stripped.text.isEmpty && (stripped.attachments ?? []).isEmpty {
      return
    }

    let speechKind: UserDisplayKind? =
      displayKind == "skill_invocation" || displayKind == "steer"
      ? UserDisplayKind(rawValue: displayKind) : steered ? .steer : nil
    // The gateway only ever stamps this on a `role:"user"` row (D1); a `system`
    // row reaching here — an older gateway, a transport that dropped
    // `display_kind` — carries no author and must not be given one.
    let author = role == "user" ? authorFromMetadata(row["display_metadata"]) : nil

    items.append(
      .user(
        UserItem(
          base: base(facts, id: facts.fallbackID),
          text: stripped.text,
          attachments: stripped.attachments,
          displayKind: speechKind,
          author: author
        )
      )
    )
  }
}

// MARK: - attributeBotReplies

/// Mark the assistant turns that answer a teammate rather than the human, and
/// the inbound rows that are themselves an answer to our own dispatch.
public func attributeBotReplies(_ items: inout [TranscriptItem]) {
  for index in items.indices {
    guard case .botDmIn(let item) = items[index] else {
      continue
    }

    let answers = dispatchedTo(items[..<index], [item.senderName, item.senderHandle])

    if answers {
      items[index].updateBotDmIn { $0.answersOurDispatch = true }
    }

    probing: for probe in (index + 1)..<max(items.count, index + 1) {
      switch items[probe] {
      case .tool, .status, .notice:
        continue probing
      case .assistant:
        if !answers {
          let handle = item.senderHandle ?? normalizeAgentTarget(item.senderName)
          items[probe].updateAssistant { $0.replyToBotHandle = handle }
        }
      default:
        break
      }

      break probing
    }
  }
}
