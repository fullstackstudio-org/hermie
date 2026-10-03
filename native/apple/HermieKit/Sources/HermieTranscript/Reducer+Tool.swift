import HermieProtocol

// `tool.*` events of `applyEvent`.

extension TranscriptReducer {
  /// `case 'tool.start'`.
  static func toolStart(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    // A call the stream's turn already holds as a row: the frame is a replay.
    if let toolID = JS.nonEmpty(str(payload["tool_id"])), claimReplayedCall(&next, toolID) {
      next.turn.draftingTool = nil

      return
    }

    sealAssistantForTool(&next)
    next.turn.draftingTool = nil

    let toolID = JS.nonEmpty(str(payload["tool_id"])) ?? "gen-\(next.turn.nextSeq)"
    let name = JS.nonEmpty(str(payload["name"])) ?? "tool"
    let args = rec(payload["args"])
    let ts = now / 1000

    if name == "message_agent" {
      let target = str(args["target"])

      addItem(&next, id: "t:\(toolID)", ts: ts) { base in
        .botDmOut(
          BotDmOutItem(
            base: base,
            toolID: toolID,
            target: target,
            targetHandle: normalizeAgentTarget(target),
            message: str(args["message"]),
            dispatch: BotDmDispatch(status: .sending)
          )
        )
      }

      return
    }

    if name == "delegate_task" {
      addItem(&next, id: "t:\(toolID)", ts: ts) { base in
        .subagentGroup(
          SubagentGroupItem(base: base, toolID: toolID, goals: goalsFromArgs(args), rootIDs: [], status: .dispatched)
        )
      }

      return
    }

    let context = str(payload["context"])
    let argsText = str(payload["args_text"])

    addItem(&next, id: "t:\(toolID)", ts: ts) { base in
      .tool(
        ToolItem(
          base: base,
          toolID: toolID,
          name: name,
          context: JS.nonEmpty(context),
          args: args.isEmpty ? nil : args,
          argsText: JS.nonEmpty(argsText),
          status: .running,
          resultKnown: false,
          summary: JS.nonEmpty(context)
        )
      )
    }
  }

  /// `case 'tool.complete'`.
  static func toolComplete(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let toolID = str(payload["tool_id"])
    let name = JS.nonEmpty(str(payload["name"])) ?? "tool"
    var id = toolID.isEmpty ? nil : next.byToolID[toolID]

    if JS.nonEmpty(id) == nil {
      // A tool whose start we missed (late attach, replay gap): materialise it
      // now so the result is never dropped.
      let lateID = JS.nonEmpty(toolID) ?? "late-\(next.turn.nextSeq)"

      id = addItem(&next, id: "t:\(lateID)", ts: now / 1000) { base in
        .tool(ToolItem(base: base, toolID: lateID, name: name, status: .running, resultKnown: false))
      }
    }

    let itemID = id!
    let durationS = num(payload["duration_s"])
    let summary = str(payload["summary"])
    let resultText = str(payload["result_text"])
    let inlineDiff = str(payload["inline_diff"])
    let failed = JS.truthy(payload["error"])

    switch next.items[itemID] {
    case .botDmOut?:
      // `payload.result ?? resultText`
      let raw = payload["result"].flatMap { $0 == .null ? nil : $0 } ?? .string(resultText)
      let dispatch = parseMessageAgentResult(raw)

      patchBotDmOut(&next, itemID) { draft in
        draft.dispatch = dispatch
      }

      if let processID = JS.nonEmpty(dispatch.processID) {
        next.byProcessID[processID] = itemID
      }

    case .subagentGroup?:
      let subagents = next.subagents

      patchSubagentGroup(&next, itemID) { draft in
        let active = draft.rootIDs.contains { child in
          let status = subagents[child]?.status

          return status == .running || status == .queued
        }

        draft.status = failed ? .failed : active ? .running : .done

        if let completion = JS.nonEmpty(summary) ?? JS.nonEmpty(resultText) {
          draft.completion = completion
        }
      }

    default:
      patchTool(&next, itemID) { draft in
        draft.status = failed ? .error : .complete
        draft.resultKnown = true
        draft.result = payload["result"]
        draft.isError = failed

        if !resultText.isEmpty {
          draft.resultText = resultText
        }

        if !summary.isEmpty {
          draft.summary = summary
        }

        if !JS.trim(inlineDiff).isEmpty {
          draft.inlineDiff = inlineDiff
        }

        if let durationS {
          draft.durationS = durationS
        }
      }
    }

    if case .array(let todos)? = payload["todos"] {
      next.todo = TodoSnapshot(todos: todos, revision: num(payload["revision"]) ?? 0)
    }
  }

  /// `case 'tool.output_risk'`.
  ///
  /// `byToolId` also holds dispatches and delegation groups, and the TypeScript
  /// patches whatever it finds there (`patchItem<ToolItem>` is a cast), so a
  /// dispatch or a group would carry an `outputRisk` too. Those kinds have no such
  /// field here; it is written into their `extra`, which encodes to the same JSON.
  static func toolOutputRisk(_ next: inout ChatState, _ payload: JSONObject) {
    guard let id = JS.nonEmpty(next.byToolID[str(payload["tool_id"])]) else { return }

    let findings: [String] =
      if case .array(let values)? = payload["findings"] { values.compactMap(\.stringValue) } else { [] }
    let risk = ToolOutputRisk(risk: str(payload["risk"]), findings: findings, redacted: isTrue(payload["redacted"]))

    switch next.items[id] {
    case .tool?, nil:
      patchTool(&next, id) { draft in
        draft.outputRisk = risk
      }
    case .botDmOut?:
      patchBotDmOut(&next, id) { draft in
        draft.extra["outputRisk"] = risk.jsonValue
      }
    case .subagentGroup?:
      patchSubagentGroup(&next, id) { draft in
        draft.extra["outputRisk"] = risk.jsonValue
      }
    default:
      patchTool(&next, id) { draft in
        draft.outputRisk = risk
      }
    }
  }

  /// `goalsFromArgs`.
  static func goalsFromArgs(_ args: JSONObject) -> [String] {
    if case .string(let goal)? = args["goal"], !JS.trim(goal).isEmpty {
      return [JS.trim(goal)]
    }

    guard case .array(let tasks)? = args["tasks"] else {
      return []
    }

    return tasks.compactMap { task in
      guard case .string(let goal)? = rec(task)["goal"], !JS.trim(goal).isEmpty else { return nil }

      return JS.trim(goal)
    }
  }
}
