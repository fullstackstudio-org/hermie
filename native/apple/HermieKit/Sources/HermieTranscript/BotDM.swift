import HermieProtocol

// Bot-to-bot wire conventions (`bot-dm.ts`).
//
// Hermes has no dedicated DM event: agent-to-agent traffic is recognised from
// transcript conventions. Everything in this module is a parser for one of
// them, and each one cites the upstream file that writes the string.
//
// The patterns are the TypeScript ones rewritten for ICU (see `JSRegExp`); each
// quotes its original.

enum BotDMPatterns {
  /// Inbound delivery signature, copied verbatim from
  /// `apps/desktop/src/components/assistant-ui/thread/user-message.tsx`.
  ///
  /// Groups: 1 = sender display name, 2 = sender handle, 3 = legacy sender name,
  /// 4 = the message body. The row arrives on the `user` role because the
  /// recipient's turn runs on it — it is NOT the human speaking.
  ///
  /// `AGENT_MESSAGE_RE`:
  /// `/^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u`
  static let agentMessage = JSRegExp(
    "^(?:Message from (?:🤖" + JSPattern.s + #"*)?([^:\n\(]{1,64}?)(?:"# + JSPattern.s
      + #"*\(@([a-z0-9][a-z0-9_\-]{0,63})\))?:"# + JSPattern.s + #"*|\[Message from agent '([^']{1,64})'\]"#
      + JSPattern.s + #"*)([\s\S]*)"# + JSPattern.end
  )

  /// Sender-side legacy delivery: `hermes -p <profile> chat … -q "Message from …"`
  /// run through the terminal tool. Copied from
  /// `apps/desktop/src/components/assistant-ui/thread/agent-delivery.tsx`.
  ///
  /// `/(?:^|[;&|]\s*|\bhermes\s+)-p\s+("?)([a-z0-9][a-z0-9_-]{0,63})\1\s+chat\b[\s\S]*?-q\s+["']Message from/iu`
  static let deliveryCommand = JSRegExp(
    "(?:^|[;\\&|]" + JSPattern.s + "*|" + JSPattern.b + "hermes" + JSPattern.s + "+)-p" + JSPattern.s
      + #"+("?)([a-z0-9][a-z0-9_\-]{0,63})\1"# + JSPattern.s + "+chat" + JSPattern.b + #"[\s\S]*?-q"#
      + JSPattern.s + #"+["']Message from"#,
    ignoreCase: true
  )

  /// The current delivery runner (`tools/bot_mode_dm.py::_delivery_command`).
  ///
  /// `/bot_mode_dm\.py["']?\s+--run-delivery\b/u`
  static let runDelivery = JSRegExp(#"bot_mode_dm\.py["']?"# + JSPattern.s + "+--run-delivery" + JSPattern.b)

  /// The recipient-naming fragment both forms share.
  ///
  /// `/\bhermes(?:\.exe)?["']?\s+-p\s+("?)([a-z0-9][a-z0-9_-]{0,63})\1\s+chat\b/iu`
  static let deliveryProfile = JSRegExp(
    JSPattern.b + #"hermes(?:\.exe)?["']?"# + JSPattern.s + "+-p" + JSPattern.s
      + #"+("?)([a-z0-9][a-z0-9_\-]{0,63})\1"# + JSPattern.s + "+chat" + JSPattern.b,
    ignoreCase: true
  )

  /// `/^\[IMPORTANT:\s*Background process (\S+)\b[\s\S]*?\nCommand:\s*([^\n]*)\n(?:Matched output|Output):\n([\s\S]*?)\]\s*$/u`
  static let processBlock = JSRegExp(
    #"^\[IMPORTANT:"# + JSPattern.s + "*Background process (" + JSPattern.S + "+)" + JSPattern.b
      + #"[\s\S]*?\nCommand:"# + JSPattern.s + #"*([^\n]*)\n(?:Matched output|Output):\n([\s\S]*?)\]"#
      + JSPattern.s + "*" + JSPattern.end
  )

  /// `/\n\n(?=\[IMPORTANT: )/u`
  static let processBlockSeparator = JSRegExp(#"\n\n(?=\[IMPORTANT: )"#)

  /// `/^@/` and `/@[^@]*$/`
  static let leadingAt = JSRegExp("^@")
  static let connectionSuffix = JSRegExp("@[^@]*" + JSPattern.end)

  /// `/^session_id:\s/u`
  static let sessionIDLine = JSRegExp("^session_id:" + JSPattern.s)
}

/// `IncomingBotMessage`.
public struct IncomingBotMessage: TranscriptJSONCodable, Hashable {
  public var senderName: String
  public var senderHandle: String?
  public var body: String

  public init(senderName: String, senderHandle: String? = nil, body: String) {
    self.senderName = senderName
    self.senderHandle = senderHandle
    self.body = body
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "IncomingBotMessage")
    senderName = try reader.required("senderName")
    senderHandle = reader.optional("senderHandle")
    body = try reader.required("body")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("senderName", senderName)
    writer.set("senderHandle", senderHandle)
    writer.set("body", body)
    return writer.json
  }
}

/// Parse an inbound `Message from 🤖 <name> (@<handle>): <body>` row.
public func parseIncomingBotMessage(_ text: String) -> IncomingBotMessage? {
  guard let match = BotDMPatterns.agentMessage.exec(text) else {
    return nil
  }

  let senderName = JS.trim(match[1] ?? match[3] ?? "")

  if senderName.isEmpty {
    return nil
  }

  let handle = match[2].map(JS.trim)

  return IncomingBotMessage(
    senderName: senderName,
    senderHandle: handle.flatMap { $0.isEmpty ? nil : JS.lower($0) },
    body: match[4] ?? ""
  )
}

/// `@Dr. Foo`, `scribe@laptop`, `peer/scribe` → `dr. foo` / `scribe`: the routing
/// alias a `message_agent` target and a "Message from" signature share. Ported
/// from `agentKey` in `agent-delivery.tsx`.
///
/// The TypeScript takes `unknown`; a value that is not a string is `nil` here and
/// gives `''` in both.
public func normalizeAgentTarget(_ target: String?) -> String {
  guard let target else {
    return ""
  }

  let stripped = BotDMPatterns.connectionSuffix.replaceFirst(
    in: BotDMPatterns.leadingAt.replaceFirst(in: JS.trim(target), with: ""),
    with: ""
  )

  return JS.lower(JS.split(stripped, "/").last ?? "")
}

/// `asRecord`: an object, or a string holding a JSON object, as a record.
private func asRecord(_ value: JSONValue?) -> JSONObject? {
  switch value {
  case .string(let text)?:
    let trimmed = JS.trim(text)

    if !JS.hasPrefix(trimmed, "{") {
      return nil
    }

    return asRecord(JS.parseJSON(trimmed))
  case .object(let object)?:
    return object
  default:
    return nil
  }
}

/// `asText`: the value when it is a string, else `''`.
private func asText(_ value: JSONValue?) -> String {
  value?.stringValue ?? ""
}

/// The `message_agent` tool result (`tools/bot_mode_dm.py`): a JSON ack
/// `{status:'queued', delivery_id, to, process_id}`, the live-owner variant
/// (`status` from the delivery record), `{status:'ambiguous', …}`, or the
/// `_err` shape `{error, reason}`. Fire-and-forget: a `queued` ack is a hand-off
/// to a background delivery process, never a delivery receipt.
public func parseMessageAgentResult(_ result: JSONValue?) -> ParsedDispatch {
  let outer = asRecord(result)
  let record: JSONObject?

  if let outer, case .string(let output)? = outer["output"] {
    record = asRecord(.string(output)) ?? outer
  } else {
    record = outer
  }

  guard let record else {
    let text = JS.trim(asText(result))

    return text.isEmpty ? ParsedDispatch(status: .unknown) : ParsedDispatch(status: .unknown, error: text)
  }

  let raw = asText(record["status"])
  let error = JS.trim(asText(record["error"]))
  let reason = JS.trim(asText(record["reason"]))
  let deliveryID = JS.trim(asText(record["delivery_id"]))
  let processID = JS.trim(asText(record["process_id"]))
  let to = JS.trim(asText(record["to"]))

  let status: DispatchStatus =
    raw == "queued" || raw == "claimed" || raw == "settled"
    ? .queued
    : raw == "ambiguous"
      ? .ambiguous
      : !error.isEmpty
        ? .failed
        : .unknown

  return ParsedDispatch(
    status: status,
    deliveryID: deliveryID.isEmpty ? nil : deliveryID,
    processID: processID.isEmpty ? nil : processID,
    to: to.isEmpty ? nil : to,
    error: error.isEmpty ? nil : error,
    reason: reason.isEmpty ? nil : reason
  )
}

/// Split a `process_complete` row into its `[IMPORTANT: Background process <sid>
/// …]` blocks. The writer is `tools/process_registry_notifications.py`; a batch
/// puts one block per process behind an "N background processes completed."
/// header, blocks separated by a blank line.
public func parseProcessCompleteText(_ text: String) -> [ProcessCompletion] {
  var out: [ProcessCompletion] = []

  for block in BotDMPatterns.processBlockSeparator.split(text) {
    let trimmed = JS.trim(block)

    guard let match = BotDMPatterns.processBlock.exec(trimmed) else {
      continue
    }

    out.append(ProcessCompletion(sid: match[1] ?? "", command: JS.trim(match[2] ?? ""), output: match[3] ?? ""))
  }

  return out
}

/// Is this background command one of our own DM deliveries? Either the current
/// runner (`bot_mode_dm.py --run-delivery …`) or the legacy terminal form
/// (`hermes -p <profile> chat … -q "Message from …"`).
public func isBotDmDeliveryCommand(_ command: String) -> Bool {
  BotDMPatterns.runDelivery.test(command) || BotDMPatterns.deliveryCommand.test(command)
}

/// Is this row the delivery runner handing a teammate's ANSWER back?
///
/// The answer to a dispatch does not arrive as a message. It arrives as a
/// background process reporting its exit — `[IMPORTANT: Background process <sid>
/// completed …]`, with the command that ran and the reply in its output — on the
/// `user` role, because the gateway runs a turn on it.
///
/// So the row is bot-to-bot traffic wearing a process report's clothes, and
/// recognising it is what keeps it out of the owner's bubble. It was not
/// recognised on either of the two paths that see the text alone: a persisted row
/// whose `display_kind` never arrived, and a resume's `inflight.user`. Both fell
/// through every parser to the last one and painted the teammate's reply as a
/// message the owner typed — headers, command line and all.
///
/// True when ANY block is one of ours: a batch can mix a delivery with an
/// unrelated process, and one delivery block is enough to make the row traffic
/// the reader must not be shown as speech.
public func isBotDmDeliveryReport(_ text: String?) -> Bool {
  guard let text, !text.isEmpty else {
    return false
  }

  return parseProcessCompleteText(text).contains { isBotDmDeliveryCommand($0.command) }
}

/// Does this item stand for bot-to-bot traffic?
///
/// The one predicate every surface asks, so "which kinds are bot-to-bot" is
/// written once. Both directions, because the reader's rule is about the traffic
/// and not about who started it: neither side of a conversation between two agents
/// is the conversation the reader is in.
public func isBotToBotItem(_ item: TranscriptItem) -> Bool {
  switch item {
  case .botDmIn, .botDmOut: true
  default: false
  }
}

/// Both delivery forms run `hermes -p <profile> chat …` for the recipient, so the
/// routing alias is recoverable from the command even when the legacy
/// `-q "Message from` marker is absent (the runner passes a query file instead).
public func deliveryTargetFromCommand(_ command: String) -> String? {
  let match = BotDMPatterns.deliveryCommand.exec(command) ?? BotDMPatterns.deliveryProfile.exec(command)

  guard let target = match?[2], !target.isEmpty else {
    return nil
  }

  return JS.lower(target)
}

/// `DeliveryOutcome`.
public struct DeliveryOutcome: TranscriptJSONCodable, Hashable {
  public var text: String?
  public var error: String?
  public var reason: String?

  public init(text: String? = nil, error: String? = nil, reason: String? = nil) {
    self.text = text
    self.error = error
    self.reason = reason
  }

  public init(decoding json: JSONValue, at path: String) throws(TranscriptDecodingError) {
    var reader = try ObjectReader(json, at: path, type: "DeliveryOutcome")
    text = reader.optional("text")
    error = reader.optional("error")
    reason = reader.optional("reason")
  }

  public var jsonValue: JSONValue {
    var writer = ObjectWriter(extra: [:])
    writer.set("text", text)
    writer.set("error", error)
    writer.set("reason", reason)
    return writer.json
  }
}

/// The delivery runner's stdout: the recipient's reply as plain text (possibly
/// echoing the `Message from …:` prefix back), or the JSON record the live-owner
/// branch prints (`{status:'settled', reply}` / `{error, reason}`) — see
/// `_wait_live_dm` and `_run_delivery` in `tools/bot_mode_dm.py`.
public func replyFromDeliveryOutput(_ output: String) -> DeliveryOutcome {
  let raw = JS.trim(output)

  if raw.isEmpty {
    return DeliveryOutcome()
  }

  if let record = asRecord(.string(raw)) {
    let error = JS.trim(asText(record["error"]))
    let reason = JS.trim(asText(record["reason"]))
    let reply = JS.trim(asText(record["reply"]))

    return DeliveryOutcome(
      text: reply.isEmpty ? nil : stripDeliveryPrefix(reply),
      error: error.isEmpty ? nil : error,
      reason: reason.isEmpty ? nil : reason
    )
  }

  let text = stripDeliveryPrefix(
    JS.trim(
      JS.split(raw, "\n")
        .filter { !BotDMPatterns.sessionIDLine.test(JS.trim($0)) }
        .joined(separator: "\n")
    )
  )

  return text.isEmpty ? DeliveryOutcome() : DeliveryOutcome(text: text)
}

private func stripDeliveryPrefix(_ text: String) -> String {
  JS.trim(BotDMPatterns.agentMessage.exec(text)?[4] ?? text)
}

/// Did THIS chat dispatch a `message_agent` to `sender` in the CURRENT exchange?
/// True means the inbound row that follows is the teammate's answer to our
/// dispatch, so the next assistant reply addresses the human again.
///
/// Ported from `dispatchedTo` in `agent-delivery.tsx`: the scan stops at the
/// nearest earlier human turn or at an inbound row from the same sender, so one
/// dispatch exempts only the answer that follows it.
public func dispatchedTo(_ earlier: [TranscriptItem], _ sender: [String?]) -> Bool {
  dispatchedTo(earlier[...], sender)
}

/// `dispatchedTo(items.slice(0, index), sender)` over a slice, so a caller that
/// scans every prefix of a transcript (`attributeBotReplies`) copies none of them.
func dispatchedTo(_ earlier: ArraySlice<TranscriptItem>, _ sender: [String?]) -> Bool {
  let keys = Set(sender.map(normalizeAgentTarget).filter { !$0.isEmpty })

  if keys.isEmpty {
    return false
  }

  for item in earlier.reversed() {
    switch item {
    case .user:
      return false
    case .botDmIn(let inbound):
      if [inbound.senderName, inbound.senderHandle].contains(where: { keys.contains(normalizeAgentTarget($0)) }) {
        return false
      }
    case .botDmOut(let outbound):
      if keys.contains(outbound.targetHandle) {
        return true
      }
    default:
      continue
    }
  }

  return false
}

extension IncomingBotMessage: JSONField {}
extension DeliveryOutcome: JSONField {}
