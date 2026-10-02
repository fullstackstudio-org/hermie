import HermieProtocol

// The client's own actions on a turn: `beginLocalTurn`, `beginSteer`,
// `dropSteer`, `confirmSubmit`, `markInterrupted`, and the `process_complete`
// join `applyProcessCompletion`.

extension TranscriptReducer {
  /// Every attachment a locally submitted turn carries, once.
  ///
  /// Two sources, because a prompt can only name one of the two kinds. A file
  /// reaches the agent BY being named in the text (`@file:<path>`), so the
  /// projection has it, byte for byte what the persisted row will repeat. An image
  /// goes over `image.attach_bytes` and is never in the prompt at all, so only the
  /// caller can say it is there. Projected first: those are the ones the row agrees
  /// with exactly, and neither source may swallow the other — a send with a file and
  /// an image carries both.
  ///
  /// `mergeAttachmentRefs`.
  static func mergeAttachmentRefs(_ projected: [String]?, _ supplied: [String]?) -> [String]? {
    var keys: [String] = []
    var refs: [String] = []

    for ref in (projected ?? []) + (supplied ?? []) {
      let key = attachmentsMatchKey([ref])

      if !keys.contains(where: { JS.same($0, key) }) {
        keys.append(key)
        refs.append(ref)
      }
    }

    return refs.isEmpty ? nil : refs
  }

  /// `lastOptimisticUserId`.
  static func lastOptimisticUserID(_ state: ChatState) -> String? {
    for id in state.order.reversed() where !id.isEmpty {
      if case .user(let item)? = state.items[id], item.origin == .optimistic {
        return item.id
      }
    }

    return nil
  }
}

/// Paint the user's own message before the gateway has echoed it.
///
/// `text` is the body as submitted, and the body is not what the row will look
/// like: the gateway stores the prompt verbatim — `@file:` and `@image:`
/// directives included — and `stripUserText` lifts those directives out of the
/// text into `attachments` on the way back. Painting the raw body left the bubble
/// holding a different string from its own row, and since the two are paired on
/// what they say, every send carrying a file came back as a second bubble. So the
/// optimistic item goes through the SAME projection a persisted row does.
///
/// `attachments` are REFERENCE strings, the same contract `UserItem.attachments`
/// holds everywhere (`@file:…` / `@image:…`), not display names — and a turn that
/// carries one is paired on it as well as on its text, which is the only thing
/// left when the send had no words at all. A caller that passed a friendlier name
/// here instead left the bubble and its row with nothing in common, which is how a
/// file sent with no text came back as a second bubble.
///
/// `author` is the reader's own identity, when the caller has one to give — the
/// same shape the persisted row will eventually carry (`MessageAuthor`). Passing
/// it here means the bubble does not change silhouette the moment its row lands:
/// `mergeWithLive` prefers the fresh row's author, but until that arrives the
/// optimistic item should already say what the row will say. No caller wires
/// this through yet; it is here so the one that does needs no reducer change.
///
/// `beginLocalTurn`.
public func beginLocalTurn(
  _ state: ChatState,
  _ text: String,
  _ attachments: [String]?,
  _ now: Double,
  _ author: MessageAuthor? = nil
) -> ChatState {
  var next = state
  beginLocalTurn(into: &next, text, attachments, now, author)
  return next
}

/// `beginLocalTurn`, in place.
public func beginLocalTurn(
  into next: inout ChatState,
  _ text: String,
  _ attachments: [String]?,
  _ now: Double,
  _ author: MessageAuthor? = nil
) {
  typealias R = TranscriptReducer

  let projected = stripUserText(text)
  let refs = R.mergeAttachmentRefs(projected.attachments, attachments)

  R.addItem(&next, id: "o:\(next.turn.nextSeq)", ts: now / 1000, origin: .optimistic) { base in
    .user(UserItem(base: base, text: projected.text, attachments: refs, pending: true, author: author))
  }

  next.turn.local = true
  next.turn.active = true
  next.turn.startedAt = now
  next.turn.interrupted = false
  next.draft = ""
}

/// Paint a steer as the user turn it is, into the turn already running.
///
/// `session.steer` is not `prompt.submit` and the difference is the whole reason
/// this is its own function. A steer hands text to the agent with its next tool
/// result; it starts no turn, so nothing here may touch `turn.active`,
/// `turn.local` or `turn.startedAt` — the running turn owns all three, and
/// claiming them made the steer look like the turn it was folded into.
///
/// What it does owe the reader is the bubble. The message was taken out of the
/// queue strip to send it, so with no bubble painted the words leave the screen
/// and nothing arrives: on build 176 that read as "the message vanished".
///
/// `pending` is deliberately NOT set. A pending bubble means "parked behind the
/// running turn", which is what the queue strip already said and what this
/// message stopped being. `displayKind: 'steer'` is the same value the gateway
/// projects on a persisted steer row, so if this gateway does write one, the
/// reconcile pairs the two on text (`matchKeyOf`) and the row simply adopts this
/// item's id — and if it does not, the bubble stands on its own.
///
/// `beginSteer`.
public func beginSteer(_ state: ChatState, _ text: String, _ attachments: [String]?, _ now: Double) -> ChatState {
  var next = state
  beginSteer(into: &next, text, attachments, now)
  return next
}

/// `beginSteer`, in place.
public func beginSteer(into next: inout ChatState, _ text: String, _ attachments: [String]?, _ now: Double) {
  typealias R = TranscriptReducer

  let projected = stripUserText(text)
  let refs = R.mergeAttachmentRefs(projected.attachments, attachments)

  R.addItem(&next, id: "o:\(next.turn.nextSeq)", ts: now / 1000, origin: .optimistic) { base in
    .user(UserItem(base: base, text: projected.text, attachments: refs, displayKind: .steer))
  }
}

/// Take a steer's bubble back off the screen.
///
/// The gateway refused it — `rejected`, or the RPC threw — and the message is
/// going back into the queue strip, which is where the reader will look for it.
/// Leaving the bubble would show the same words in two places and claim a
/// correction the agent never heard.
///
/// It removes the NEWEST optimistic steer whose text matches, and nothing else:
/// a steer that the tail reconcile has already paired with a persisted row is no
/// longer `optimistic`, and a row the gateway wrote is not ours to delete.
///
/// `dropSteer`.
public func dropSteer(_ state: ChatState, _ text: String) -> ChatState {
  var next = state
  dropSteer(into: &next, text)
  return next
}

/// `dropSteer`, in place.
public func dropSteer(into next: inout ChatState, _ text: String) {
  let wanted = stripUserText(text).text

  for id in next.order.reversed() where !id.isEmpty {
    if case .user(let item)? = next.items[id], item.origin == .optimistic, item.displayKind == .steer,
      JS.same(item.text, wanted)
    {
      TranscriptReducer.dropItem(&next, item.id)

      return
    }
  }
}

/// Settle the optimistic turn against `prompt.submit`'s answer.
///
/// `confirmSubmit`.
public func confirmSubmit(_ state: ChatState, _ result: PromptSubmitResult, _ now: Double) -> ChatState {
  var next = state
  confirmSubmit(into: &next, result, now)
  return next
}

/// `confirmSubmit`, in place.
public func confirmSubmit(into next: inout ChatState, _ result: PromptSubmitResult, _ now: Double) {
  typealias R = TranscriptReducer

  guard let id = JS.nonEmpty(R.lastOptimisticUserID(next)) else { return }

  let status = R.str(result.json["status"])

  R.patchUser(&next, id) { draft in
    draft.pending = status == "queued"

    if status == "steered" {
      draft.displayKind = .steer
    }
  }

  if status == "queued" {
    let text = next.items[id]?.asUser?.text ?? ""

    next.queued = QueuedPrompt(text: text, local: true)
    // A queued prompt does not start a turn of its own; the running one owns it.
    // (`next.turn.active = state.turn.active`: nothing above changed it.)
  } else if status == "steered" || status == "redirected" {
    // Steer / redirect fold into the turn already running.
    next.turn.startedAt = next.turn.startedAt ?? now
  }
}

/// The user pressed Stop: keep the partial reply, stop claiming the turn runs.
///
/// `markInterrupted`.
public func markInterrupted(_ state: ChatState, _ now: Double) -> ChatState {
  var next = state
  markInterrupted(into: &next, now)
  return next
}

/// `markInterrupted`, in place.
public func markInterrupted(into next: inout ChatState, _ now: Double) {
  typealias R = TranscriptReducer

  if let id = JS.nonEmpty(next.turn.assistantID), case .assistant? = next.items[id] {
    let startedAt = next.turn.startedAt

    R.patchAssistant(&next, id) { draft in
      draft.streaming = false
      draft.status = .interrupted

      if JS.truthy(startedAt) {
        draft.durationS = (now - startedAt!) / 1000
      }
    }
  }

  // Stop bumps the gateway's queue generation, and a submit that threw never
  // reached the queue at all — so nothing of ours is parked any more. A bubble
  // left marked `pending` would make the next turn a teammate starts read as
  // that prompt's, and the reader would never be told who really spoke.
  for id in next.order {
    if case .user(let item)? = next.items[id], item.pending == true {
      R.patchUser(&next, id) { draft in
        draft.pending = false
      }
    }
  }

  next.queued = nil
  next.turn.local = false
  next.turn.active = false
  next.turn.interrupted = true
  next.turn.assistantID = nil
  next.turn.draftingTool = nil
}

/// Join a `process_complete` payload onto the dispatch that spawned it.
///
/// `applyProcessCompletion`.
public func applyProcessCompletion(_ state: ChatState, _ text: String, _ now: Double) -> ChatState {
  var next = state
  applyProcessCompletion(into: &next, text, now)
  return next
}

/// `applyProcessCompletion`, in place.
public func applyProcessCompletion(into next: inout ChatState, _ text: String, _ now: Double) {
  typealias R = TranscriptReducer

  for block in parseProcessCompleteText(text) {
    guard let id = JS.nonEmpty(next.byProcessID[block.sid]) else {
      continue
    }

    let outcome = replyFromDeliveryOutput(block.output)

    R.patchBotDmOut(&next, id) { draft in
      draft.reply = BotDmReply(
        text: outcome.text ?? "",
        ts: now / 1000,
        error: JS.nonEmpty(outcome.error),
        reason: JS.nonEmpty(outcome.reason)
      )

      if let error = JS.nonEmpty(outcome.error) {
        draft.dispatch.status = .failed
        draft.dispatch.error = error
      }
    }
  }
}
