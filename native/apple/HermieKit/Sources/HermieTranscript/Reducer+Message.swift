import HermieProtocol

// `message.*`, reasoning, `status.update`, notices, `error` and the session-level
// events of `applyEvent`.

extension TranscriptReducer {
  /// `case 'message.start'`. `turnID` is the envelope's `turn_id`, when the
  /// gateway minted one.
  static func messageStart(_ next: inout ChatState, _ turnID: String?, _ now: Double) {
    next.compacting = false

    // A turn whose prompt is already on screen under its own turn id needs no
    // stand-in and no tail fetch: the prompt is there. That is a replayed
    // `message.start` landing on the history a reopened chat just read, and
    // standing a blank "someone spoke" bubble above the prompt it started was
    // one more row of the owner's doubled transcript.
    let known = turnID != nil && !next.turn.local && turnPromptOnScreen(next, turnID!)

    if !next.turn.local && !known {
      // A prompt of ours the gateway parked starts its turn right here, and
      // nothing in the frame says so: `prompt.submit` answered `queued`
      // minutes ago and `message.start` carries no author. `ChatState.queued`
      // only ever remembered the most recent one, so the SECOND prompt of a
      // parked burst used to start as a foreign turn and put an empty
      // placeholder in front of the user's own message. A bubble still marked
      // `pending` is a prompt of ours waiting for exactly this frame.
      if let parked = JS.nonEmpty(firstParkedPromptID(next)) {
        patchUser(&next, parked) { draft in
          draft.pending = false

          if let turnID {
            draft.turnID = turnID
          }
        }
        next.turn.local = true
      } else {
        // Nobody local submitted, so this turn belongs to a teammate bot or
        // another surface. Stand a placeholder in for the author until a tail
        // reconcile tells us who spoke.
        addItem(&next, id: "f:\(next.turn.nextSeq)", ts: now / 1000, origin: .foreign) { base in
          // The placeholder knows which turn it stands for, so the tail fills it
          // with THAT turn's prompt rather than the next one along.
          .user(UserItem(base: base, text: "", unknownAuthor: true, turnID: turnID))
        }
        next.turn.foreignReconcilePending = true
      }
    }

    if let turnID, next.turn.local {
      stampLocalPrompt(&next, turnID)
    }

    // A different turn starts: the thought a cached turn was writing to is not
    // this one's (the live bubble is let go below, as it always was).
    if let current = next.turn.id, turnID.map({ !JS.same(current, $0) }) ?? true {
      next.turn.reasoningID = nil
    }

    next.turn.id = turnID
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

    if let rowID = rowIDOf(payload), interimOntoRow(&next, text, rowID, now) {
      return
    }

    if let id = JS.nonEmpty(next.turn.assistantID), case .assistant? = next.items[id] {
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
    let finalText = JS.nonEmpty(str(payload["text"])) ?? str(payload["rendered"])
    // The files this reply shares (`contract/outbox/`): absent or empty when it named none.
    let shared = OutboxAttachment.parseAll(payload["attachments"])
    let wasInterrupted = next.turn.interrupted == true
    let rawStatus = str(payload["status"])
    let status: AssistantStatus =
      rawStatus == "error" ? .error : rawStatus == "interrupted" || wasInterrupted ? .interrupted : .complete
    let durationS = JS.truthy(next.turn.startedAt) ? (now - next.turn.startedAt!) / 1000 : nil
    let failure: AssistantFailure? =
      rawStatus == "error"
      ? AssistantFailure(
        message: JS.nonEmpty(JS.trim(str(payload["error"]))) ?? JS.nonEmpty(finalText)
          ?? "The gateway reported an error",
        partial: isTrue(payload["partial"]),
        recoverable: isTrue(payload["recoverable"]) ? true : nil,
        surface: JS.truthy(payload["error_surface"]) ? ErrorSurface(json: rec(payload["error_surface"])) : nil
      )
      : nil
    let previewedFlag = isTrue(payload["response_previewed"])

    // `response_previewed` means the reply already landed as a sealed interim
    // bubble; promote that one instead of painting the same text twice.
    let previewed = previewedFlag ? lastAssistantID(next) : nil
    // Without that flag, a tool call in the middle of the turn has the same
    // effect: it sealed the bubble, so this completion has nowhere to land.
    let continued = JS.nonEmpty(next.turn.assistantID) != nil ? nil : interimContinuedBy(next, finalText)
    // The final assistant row, when the gateway names it (`row_id`, or the
    // receipt's `final_assistant_row_id` from a gateway that predates it).
    let finalRowID =
      rowIDOf(payload) ?? rec(payload["persisted_turn"])["final_assistant_row_id"].flatMap { rowIDOf(["row_id": $0]) }
    let finalRow = finalRowID.flatMap { itemAtRow(next, $0) }
    // A row id held by something that is not a reply is a renumbered store,
    // not this reply; the frame is then read as if it carried no id at all.
    let byIdentity = finalRowID != nil && (finalRow == nil || finalRow?.kind == .assistant)
    // No row named and no note left to continue: the row that holds the call may
    // already be the reply.
    let heldByCall =
      finalRowID == nil && JS.nonEmpty(next.turn.assistantID) == nil && continued == nil
      ? replyHeldByCallRow(next, payload, finalText) : nil
    let landedRow: TranscriptItem? = (byIdentity ? finalRow : nil) ?? heldByCall.map { .assistant($0) }
    let usage = JS.truthy(payload["usage"]) ? Usage(json: rec(payload["usage"])) : nil

    if let finalRow = landedRow {
      // The reply is on screen already, as its row. Whatever was standing in
      // for it settles onto that row; the row keeps its words and is given
      // only the verdict. No duration: see `settleOntoRow`.
      let target =
        unpersistedNote(next, next.turn.assistantID) ?? unpersistedNote(next, previewed)
        ?? unpersistedNote(next, continued)

      if let target {
        settleOntoRow(&next, target, finalRow.id)
      }

      patchAssistant(&next, finalRow.id) { draft in
        draft.streaming = false
        draft.interim = false
        draft.status = status

        if !shared.isEmpty {
          draft.outbox = shared
        }

        if let failure {
          draft.error = failure
        }

        if let usage {
          draft.usage = usage
        }
      }
    } else {
      if byIdentity && JS.nonEmpty(next.turn.assistantID) != nil
        && unpersistedNote(next, next.turn.assistantID) == nil
      {
        // A bubble that already stands for another row is not this reply.
        next.turn.assistantID = nil
      }

      var id: String? =
        byIdentity
        ? unpersistedNote(next, next.turn.assistantID) ?? unpersistedNote(next, previewed)
          ?? unpersistedNote(next, continued)
        : next.turn.assistantID ?? previewed ?? continued

      if id == nil && (!finalText.isEmpty || failure != nil || !shared.isEmpty) {
        id = currentAssistantID(&next, now)
      }

      if let id = JS.nonEmpty(id) {
        patchAssistant(&next, id) { draft in
          if !finalText.isEmpty && !previewedFlag {
            draft.text = finalText
          }

          draft.streaming = false
          draft.interim = false
          draft.status = status

          if !shared.isEmpty {
            draft.outbox = shared
          }

          if let failure {
            draft.error = failure
          }

          if let usage {
            draft.usage = usage
          }

          if let durationS {
            draft.durationS = durationS
          }

          // The reply is not on screen as a row yet: this bubble is that row,
          // and the history that brings it pairs with it by id.
          if byIdentity && draft.rowID == nil {
            draft.rowID = finalRowID
          }
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

    if let stored = JS.nonEmpty(str(payload["stored_session_id"])) {
      next.storedSessionID = stored
    }

    if isFalse(payload["running"]) {
      next.turn.active = false
    }
  }

  /// `case 'error'`.
  static func errorEvent(_ next: inout ChatState, _ payload: JSONObject, _ now: Double) {
    let message = JS.nonEmpty(str(payload["message"])) ?? "The gateway reported an error"
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

    if let id = JS.nonEmpty(id), case .array(let entries)? = payload["reactions"] {
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
