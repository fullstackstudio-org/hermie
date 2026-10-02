import HermieProtocol

// `message.*`, reasoning, `status.update`, notices, `error` and the session-level
// events of `applyEvent`.

extension TranscriptReducer {
  /// `case 'message.start'`.
  static func messageStart(_ next: inout ChatState, _ now: Double) {
    next.compacting = false

    if !next.turn.local {
      // A prompt of ours the gateway parked starts its turn right here, and
      // nothing in the frame says so: `prompt.submit` answered `queued`
      // minutes ago and `message.start` carries no author. `ChatState.queued`
      // only ever remembered the most recent one, so the SECOND prompt of a
      // parked burst used to start as a foreign turn and put an empty
      // placeholder in front of the user's own message. A bubble still marked
      // `pending` is a prompt of ours waiting for exactly this frame.
      if let parked = nonEmpty(firstParkedPromptID(next)) {
        patchUser(&next, parked) { draft in
          draft.pending = false
        }
        next.turn.local = true
      } else {
        // Nobody local submitted, so this turn belongs to a teammate bot or
        // another surface. Stand a placeholder in for the author until a tail
        // reconcile tells us who spoke.
        addItem(&next, id: "f:\(next.turn.nextSeq)", ts: now / 1000, origin: .foreign) { base in
          .user(UserItem(base: base, text: "", unknownAuthor: true))
        }
        next.turn.foreignReconcilePending = true
      }
    }

    next.turn.active = true
    next.turn.startedAt = now
    next.turn.assistantID = nil
    next.turn.interrupted = false
    next.turn.draftingTool = nil
  }

  /// `case 'message.delta'`: the hot path. One lookup, one in-place append, one
  /// re-index of the item's row id — nothing proportional to the transcript.
  static func messageDelta(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let text = str(payload["text"])

    if text.isEmpty {
      return
    }

    let id = currentAssistantID(&next, now)

    patchAssistant(&next, id) { draft in
      draft.text += text
      draft.streaming = true
    }
  }

  /// `case 'reasoning.delta' | 'thinking.delta' | 'reasoning.available'`.
  static func reasoning(_ next: inout ChatState, _ payload: JSONObject, replace: Bool, _ now: Double) {
    let text = str(payload["text"])

    if text.isEmpty {
      return
    }

    let id = reasoningTargetID(&next, now)
    let verbose = isTrue(payload["verbose"])

    patchAssistant(&next, id) { draft in
      if replace || draft.reasoning == nil {
        draft.reasoning = text
      } else {
        // `(draft.reasoning ?? '') + text`, appended in place.
        draft.reasoning! += text
      }

      if verbose {
        draft.reasoningVerbose = true
      }
    }
  }

  /// `case 'message.interim'`.
  static func messageInterim(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let text = str(payload["text"])

    if let id = nonEmpty(next.turn.assistantID), case .assistant? = next.items[id] {
      patchAssistant(&next, id) { draft in
        if !text.isEmpty {
          draft.text = text
        }

        draft.streaming = false
        draft.interim = true
      }
      next.turn.assistantID = nil

      return
    }

    if text.isEmpty {
      return
    }

    // No live bubble: this preview either REPLACES the one standing at the end
    // of the transcript, or starts the first note of a new stretch.
    if let open = openInterimID(next) {
      patchAssistant(&next, open) { draft in
        draft.text = text
      }

      return
    }

    addItem(&next, id: "a:\(next.turn.nextSeq)", ts: now / 1000) { base in
      .assistant(AssistantItem(base: base, text: text, streaming: false, interim: true))
    }
  }

  /// `case 'status.update'`.
  static func statusUpdate(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let kind = str(payload["kind"])
    let text = str(payload["text"])

    if kind == "compacting" {
      next.compacting = true
    } else if kind == "compacted" {
      next.compacting = false
    }

    if text.isEmpty {
      return
    }

    if case .status(let tail)? = lastItem(next) {
      patchStatus(&next, tail.id) { draft in
        draft.statusKind = kind
        draft.text = text
        draft.ts = now / 1000
      }

      return
    }

    addItem(&next, id: "s:\(next.turn.nextSeq)", ts: now / 1000) { base in
      .status(StatusItem(base: base, statusKind: kind, text: text))
    }
  }

  /// `case 'message.complete'`.
  static func messageComplete(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let finalText = nonEmpty(str(payload["text"])) ?? str(payload["rendered"])
    let wasInterrupted = next.turn.interrupted == true
    let rawStatus = str(payload["status"])
    let status: AssistantStatus =
      rawStatus == "error" ? .error : rawStatus == "interrupted" || wasInterrupted ? .interrupted : .complete
    let durationS = truthy(next.turn.startedAt) ? (now - next.turn.startedAt!) / 1000 : nil
    let failure: AssistantFailure? =
      rawStatus == "error"
      ? AssistantFailure(
        message: nonEmpty(JS.trim(str(payload["error"]))) ?? nonEmpty(finalText) ?? "The gateway reported an error",
        partial: isTrue(payload["partial"]),
        recoverable: isTrue(payload["recoverable"]) ? true : nil,
        surface: truthy(payload["error_surface"]) ? ErrorSurface(json: rec(payload["error_surface"])) : nil
      )
      : nil
    let previewedFlag = isTrue(payload["response_previewed"])

    // `response_previewed` means the reply already landed as a sealed interim
    // bubble; promote that one instead of painting the same text twice.
    let previewed = previewedFlag ? lastAssistantID(next) : nil
    // Without that flag, a tool call in the middle of the turn has the same
    // effect: it sealed the bubble, so this completion has nowhere to land.
    let continued = nonEmpty(next.turn.assistantID) != nil ? nil : interimContinuedBy(next, finalText)
    var id = next.turn.assistantID ?? previewed ?? continued

    if id == nil && (!finalText.isEmpty || failure != nil) {
      id = currentAssistantID(&next, now)
    }

    let usage = truthy(payload["usage"]) ? Usage(json: rec(payload["usage"])) : nil

    if let id = nonEmpty(id) {
      patchAssistant(&next, id) { draft in
        if !finalText.isEmpty && !previewedFlag {
          draft.text = finalText
        }

        draft.streaming = false
        draft.interim = false
        draft.status = status

        if let failure {
          draft.error = failure
        }

        if let usage {
          draft.usage = usage
        }

        if let durationS {
          draft.durationS = durationS
        }
      }
    }

    if let usage {
      next.usage = usage
    }

    cancelOpenRequests(&next, "turn_ended")
    clearTurn(&next)
  }

  /// `case 'session.info'`.
  static func sessionInfo(_ next: inout ChatState, _ payload: JSONObject) {
    next.info = SessionLiveInfo(json: payload)

    if let stored = nonEmpty(str(payload["stored_session_id"])) {
      next.storedSessionID = stored
    }

    if isFalse(payload["running"]) {
      next.turn.active = false
    }
  }

  /// `case 'error'`.
  static func errorEvent(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let message = nonEmpty(str(payload["message"])) ?? "The gateway reported an error"
    var id = next.turn.assistantID

    if id == nil {
      id = currentAssistantID(&next, now)
    }

    patchAssistant(&next, id!) { draft in
      draft.streaming = false
      draft.interim = false
      draft.status = .error
      draft.error = AssistantFailure(message: message, partial: !draft.text.isEmpty)
    }
    cancelOpenRequests(&next, "turn_failed")
    clearTurn(&next)
  }

  /// `case 'notice'`.
  static func notice(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let message = str(payload["message"])

    if !message.isEmpty {
      /*
        `detail` is ours, not the gateway's: upstream's notice event carries a
        single `message` and nothing else. It exists because a slash command's
        answer arrives here, and `/status` is nine lines and `/help` is five
        kilobytes of ASCII table — all of which used to be flattened into the
        TITLE with an empty body, which `NoticePill` then drew as one run of
        text with no way to fold it away. An event without it behaves exactly
        as it did.

        `noticeKind` is ours too, and exactly ONE value is accepted from it:
        `command`, the answer to a slash command the owner typed. Everything
        else — including a kind this client has never heard of — lands as a
        plain `notice`, so a gateway that starts sending the field cannot
        promote its own narration into the family that survives `quiet` and
        opens itself.
      */
      pushNotice(&next, commandKind(payload["noticeKind"]), message, str(payload["detail"]), now)
    }
  }

  /// `case 'message.reaction'`.
  static func messageReaction(_ next: inout ChatState, _ payload: JSONObject) {
    let rowID = num(payload["row_id"])
    let id = rowID.flatMap { next.byRowID[JS.string($0)] }

    if let id = nonEmpty(id), case .array(let entries)? = payload["reactions"] {
      let reactions = asReactions(entries)

      patchAnyItem(&next, id) { draft in
        draft.reactions = reactions
      }
    }
  }

  /// `asReactions`: the entries whose `emoji` is a string, each kept whole.
  static func asReactions(_ entries: [JSONValue]) -> [ItemReaction] {
    entries.compactMap { entry in
      let record = rec(entry)

      guard record["emoji"]?.stringValue != nil else { return nil }

      return try? ItemReaction(decoding: .object(record))
    }
  }

  /// `case 'btw.complete' | 'background.complete'`.
  static func sideAgentComplete(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let text = JS.trim(str(payload["text"]))

    if !text.isEmpty {
      let question = JS.trim(str(payload["question"]))

      pushNotice(&next, .notice, question.isEmpty ? "Background task finished" : "Side question: \(question)", text, now)
    }
  }
}
