import HermieProtocol

// `subagent.*` payload → `Subagent` projection (`subagent-progress.ts`).
//
// Ported from `toProgress` / `streamFromPayload` in
// `apps/desktop/src/store/subagents.ts`. The gateway sends the same payload
// shape for all six subagent events; the event name only decides which stream
// lines are derived and whether an unknown status is fatal.

private let previewMax = 220
private let toolPreviewMax = 96

/// `TERMINAL_SUBAGENT_STATUS`.
public let terminalSubagentStatus: Set<Subagent.Status> = [.completed, .failed, .interrupted]

/// `str`: the value when it is a string, else `''`.
private func str(_ value: JSONValue?) -> String {
  value?.stringValue ?? ""
}

/// `num`: a finite number, else `undefined`.
private func num(_ value: JSONValue?) -> Double? {
  guard case .number(let number)? = value, number.isFinite else { return nil }
  return number
}

/// `strList`: the string elements of an array, else `[]`.
private func strList(_ value: JSONValue?) -> [String] {
  guard case .array(let values)? = value else { return [] }
  return values.compactMap(\.stringValue)
}

/// A `subagent.complete` frame is terminal by definition, so an unrecognised (or
/// still-active) status there must read as a failure rather than leave a dead row
/// spinning forever. Live events keep the lenient fallback.
public func asSubagentStatus(_ value: JSONValue?, _ terminalEvent: Bool = false) -> Subagent.Status {
  let raw = value?.stringValue

  if raw == "completed" || raw == "failed" || raw == "interrupted" {
    return Subagent.Status.named(raw!)
  }

  if raw == "timeout" || raw == "error" {
    return .failed
  }

  if raw == "cancelled" || raw == "canceled" {
    return .interrupted
  }

  if terminalEvent {
    return .failed
  }

  return raw == "queued" ? .queued : .running
}

/// `compact`: whitespace runs to one space, trimmed, cut to `max` code units with
/// an ellipsis.
private func compact(_ text: String, _ max: Int = previewMax) -> String {
  let line = JS.trim(SubagentPatterns.whitespaceRun.replaceAll(in: text, with: " "))

  if line.isEmpty {
    return ""
  }

  return JS.length(line) > max ? "\(JS.slice(line, 0, max - 1))…" : line
}

enum SubagentPatterns {
  /// `/\s+/gu`
  static let whitespaceRun = JSRegExp(JSPattern.s + "+")
}

private func capitalize(_ word: String) -> String {
  word.isEmpty ? word : JS.capitaliseFirstUnit(word)
}

private func toolLabel(_ name: String) -> String {
  let label = JS.split(name, "_").filter { !$0.isEmpty }.map(capitalize).joined(separator: " ")
  return label.isEmpty ? name : label
}

private func formatTool(_ name: String, _ preview: String = "") -> String {
  let snippet = compact(preview, toolPreviewMax)

  return snippet.isEmpty ? toolLabel(name) : "\(toolLabel(name))(\"\(snippet)\")"
}

private struct TailEntry {
  var isError: Bool
  var preview: String?
  var tool: String?
}

/// `asTail`: every element that is an object (an array counts, as `typeof` says),
/// read loosely.
private func asTail(_ value: JSONValue?) -> [TailEntry] {
  guard case .array(let values)? = value else { return [] }

  return values.compactMap { element in
    switch element {
    case .object(let item):
      let preview = str(item["preview"])
      let tool = str(item["tool"])
      return TailEntry(
        isError: item["is_error"] == .bool(true),
        preview: preview.isEmpty ? nil : preview,
        tool: tool.isEmpty ? nil : tool
      )
    case .array:
      return TailEntry(isError: false)
    default:
      return nil
    }
  }
}

/// Identity, with the same fallback the desktop uses when the emitter omits an id.
/// `subagentIdOf`.
public func subagentIDOf(_ payload: JSONObject) -> String {
  let id = str(payload["subagent_id"])

  if !id.isEmpty {
    return id
  }

  let parent = str(payload["parent_id"])
  return "\(parent.isEmpty ? "root" : parent):\(JS.string(num(payload["task_index"]) ?? 0)):\(str(payload["goal"]))"
}

private func appendStream(_ stream: [SubagentStreamEntry], _ entry: SubagentStreamEntry) -> [SubagentStreamEntry] {
  if let last = stream.last, last.kind == entry.kind, JS.same(last.text, entry.text), last.isError == entry.isError {
    return stream
  }

  return Array((stream + [entry]).suffix(subagentStreamCap))
}

/// The backend sends no summary on a hard child timeout (only a preview and a
/// duration), so synthesize one rather than render a bare failure.
private func timeoutSummary(_ payload: JSONObject) -> String {
  let seconds = num(payload["duration_seconds"])

  return str(payload["status"]) == "timeout" ? "Timed out after \(seconds.map(JS.string) ?? "?")s" : ""
}

private func streamFromPayload(
  _ payload: JSONObject,
  _ status: Subagent.Status,
  _ eventType: String,
  _ at: Double
) -> [SubagentStreamEntry] {
  var out: [SubagentStreamEntry] = []
  let tool = str(payload["tool_name"])
  let toolPreview = str(payload["tool_preview"])
  let preview = toolPreview.isEmpty ? str(payload["text"]) : toolPreview
  let payloadText = str(payload["text"])
  let text = compact(payloadText.isEmpty ? preview : payloadText)
  let isError = payload["error"]?.isTruthy ?? false

  for tail in asTail(payload["output_tail"]) {
    let line = tail.tool.map { formatTool($0, tail.preview ?? "") } ?? compact(tail.preview ?? "")

    if !line.isEmpty {
      out.append(
        SubagentStreamEntry(at: at, kind: tail.tool != nil ? .tool : .progress, text: line, isError: tail.isError ? true : nil)
      )
    }
  }

  if !tool.isEmpty {
    out.append(SubagentStreamEntry(at: at, kind: .tool, text: formatTool(tool, preview), isError: isError ? true : nil))
  }

  if eventType == "subagent.progress" && !text.isEmpty {
    out.append(SubagentStreamEntry(at: at, kind: .progress, text: text, isError: isError ? true : nil))
  }

  if eventType == "subagent.thinking" && !text.isEmpty {
    out.append(SubagentStreamEntry(at: at, kind: .thinking, text: text))
  }

  let summaryText = str(payload["summary"])
  let summary = compact(!summaryText.isEmpty ? summaryText : !payloadText.isEmpty ? payloadText : timeoutSummary(payload))

  if terminalSubagentStatus.contains(status) && !summary.isEmpty {
    out.append(SubagentStreamEntry(at: at, kind: .summary, text: summary, isError: status == .failed ? true : nil))
  }

  return out
}

/// `toSubagent`: fold one `subagent.*` payload onto the child it describes.
public func toSubagent(_ payload: JSONObject, _ prev: Subagent?, _ eventType: String, _ at: Double) -> Subagent {
  let status = asSubagentStatus(payload["status"], eventType == "subagent.complete")
  let tool = str(payload["tool_name"])
  let stream = streamFromPayload(payload, status, eventType, at).reduce(prev?.stream ?? [], appendStream)
  let filesRead = strList(payload["files_read"])
  let filesWritten = strList(payload["files_written"])
  let childSessionID = nonEmpty(str(payload["child_session_id"])) ?? prev?.childSessionID
  let delegationID = nonEmpty(str(payload["delegation_id"])) ?? prev?.delegationID
  let model = nonEmpty(str(payload["model"])) ?? prev?.model
  let depth = num(payload["depth"]) ?? prev?.depth
  let durationSeconds = num(payload["duration_seconds"]) ?? prev?.durationSeconds
  let toolCount = num(payload["tool_count"]) ?? prev?.toolCount
  let inputTokens = num(payload["input_tokens"]) ?? prev?.inputTokens
  let outputTokens = num(payload["output_tokens"]) ?? prev?.outputTokens
  let summary = nonEmpty(str(payload["summary"])) ?? nonEmpty(timeoutSummary(payload)) ?? prev?.summary
  let currentTool = terminalSubagentStatus.contains(status) ? nil : nonEmpty(tool) ?? prev?.currentTool

  return Subagent(
    id: prev?.id ?? subagentIDOf(payload),
    parentID: nonEmpty(str(payload["parent_id"])) ?? nonEmpty(prev?.parentID),
    delegationID: nonEmpty(delegationID),
    childSessionID: nonEmpty(childSessionID),
    goal: nonEmpty(str(payload["goal"])) ?? nonEmpty(prev?.goal) ?? "Subagent",
    model: nonEmpty(model),
    depth: depth,
    taskIndex: num(payload["task_index"]) ?? prev?.taskIndex ?? 0,
    taskCount: num(payload["task_count"]) ?? prev?.taskCount ?? 1,
    status: status,
    startedAt: prev?.startedAt ?? at,
    updatedAt: at,
    durationSeconds: durationSeconds,
    toolCount: toolCount,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    filesRead: filesRead.isEmpty ? (prev?.filesRead ?? []) : filesRead,
    filesWritten: filesWritten.isEmpty ? (prev?.filesWritten ?? []) : filesWritten,
    stream: stream,
    summary: nonEmpty(summary),
    currentTool: nonEmpty(currentTool),
    acceptingSteer: prev?.acceptingSteer
  )
}

/// JavaScript's `a || b` for strings: an empty string is as good as none.
private func nonEmpty(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return value
}
