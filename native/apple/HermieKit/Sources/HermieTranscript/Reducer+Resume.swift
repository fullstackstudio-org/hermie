import HermieProtocol

// `applyResumeSnapshot`: the in-flight tail rebuilt from `session.resume`.

extension TranscriptReducer {
  /// The empty bubble a foreign `message.start` stands up while we wait to be told
  /// who spoke.
  ///
  /// It is a PROMISE of a prompt, not a prompt. `message.start` carries no author,
  /// so the reducer adds a blank `unknownAuthor` user item and schedules a tail
  /// fetch to fill it. Until that lands the item holds no text at all, which makes
  /// it indistinguishable from a real prompt only if you ask "is there a user item
  /// here" and not "does it say anything".
  ///
  /// `isForeignPlaceholder`.
  static func isForeignPlaceholder(_ item: TranscriptItem?) -> Bool {
    guard case .user(let user)? = item else { return false }

    return user.unknownAuthor == true && JS.trim(user.text).isEmpty
  }

  /// `shownTurn`'s answer.
  struct ShownTurn {
    var authored: String?
    var carried: String?
    var settledReply: String?
    var settledReplyTs: Double?
  }

  /// The tail of the transcript as a resume has to read it: the newest turn's
  /// prompt, and the persisted reply to it if there already is one.
  ///
  /// `authored` is the last user or inbound-DM item, whatever origin it has;
  /// `settledReply` is the durable assistant row after it. Nothing else is needed,
  /// because `session.resume`'s `inflight` describes exactly one turn — the newest.
  ///
  /// A foreign-author placeholder is walked PAST rather than returned. It used to
  /// be returned, and that was the one hole `duplicate-cron-turns.test.ts` pinned
  /// and could not close: a cron delivery already in history, then a
  /// `message.start` for the turn the scheduler triggered, puts a blank bubble
  /// between the card and its reply — so `authored` came back as the empty string,
  /// the comparison against `inflight.user` missed, and the resume stood a SECOND
  /// card beside the first. A placeholder must neither count as the shown prompt
  /// nor hide the item that really is it; skipping it is both halves of that.
  ///
  /// A STEER is walked past for the same reason and a second one of its own.
  /// `session.steer` hands words to the turn already running; it starts no turn,
  /// and the gateway's `inflight.user` for that turn goes on being the ORIGINAL
  /// prompt. So a steer is never a turn's prompt — and while it was the newest
  /// authored item, every resume compared the original prompt against the steer's
  /// words, missed, and projected the prompt a second time. On the device: the
  /// prompt at 21:21, the steer at 21:24, and the same prompt again at 21:24, with
  /// exactly one row for it in the gateway's database.
  ///
  /// A gateway-injected notice IS returned. A fan-out's report or a background
  /// process's completion arrives on the `user` role and the gateway runs a turn on
  /// it, so it opens a turn exactly as a cron delivery does — and, like a cron
  /// delivery, it is drawn as a card rather than as speech, which is why this
  /// comparison has to know about it here and not only in `rows-to-items`.
  ///
  /// `shownTurn`.
  static func shownTurn(_ state: ChatState) -> ShownTurn {
    var settledReply: String?
    var settledReplyTs: Double?

    for id in state.order.reversed() {
      let item = state.items[id]

      if case .assistant(let assistant)? = item, assistant.rowID != nil, settledReply == nil {
        settledReply = normalizedItemText(.assistant(assistant))
        settledReplyTs = assistant.ts

        continue
      }

      if isForeignPlaceholder(item) {
        continue
      }

      if case .user(let user)? = item, user.displayKind == .steer {
        continue
      }

      // One spread for both returns and the empty tail, so the reply and its
      // stamp can never come back one without the other.
      if let item, isInjectedNotice(item) {
        return ShownTurn(
          authored: normalizedItemText(item),
          carried: "",
          settledReply: settledReply,
          settledReplyTs: settledReply == nil ? nil : settledReplyTs
        )
      }

      switch item {
      case .user(let user)?:
        return ShownTurn(
          authored: normalizedItemText(.user(user)),
          carried: attachmentsMatchKey(user.attachments),
          settledReply: settledReply,
          settledReplyTs: settledReply == nil ? nil : settledReplyTs
        )
      case .botDmIn?, .cronDelivery?:
        return ShownTurn(
          authored: normalizedItemText(item!),
          carried: "",
          settledReply: settledReply,
          settledReplyTs: settledReply == nil ? nil : settledReplyTs
        )
      default:
        continue
      }
    }

    return ShownTurn(settledReply: settledReply, settledReplyTs: settledReply == nil ? nil : settledReplyTs)
  }

  /// The newest placeholder still waiting for an author, if the turn left one.
  ///
  /// `foreignPlaceholderId`.
  static func foreignPlaceholderID(_ state: ChatState) -> String? {
    for id in state.order.reversed() where !id.isEmpty && isForeignPlaceholder(state.items[id]) {
      return id
    }

    return nil
  }

  /// `inflight.user`, read the way the transcript shows it.
  ///
  /// The raw text of a turn's opening row is NOT what the transcript draws. A
  /// scheduled job's report is a card keyed on the job's name and body
  /// (ADR-0013), and a teammate's message is a tinted bubble holding only the body
  /// under its `Message from 🤖 <name> (@<handle>):` signature (ADR-0009). So both
  /// the comparison key and the item a resume projects are derived here, by the
  /// same parsers `rows-to-items` uses on the persisted row — otherwise the two
  /// describe one turn in two different shapes, the comparison misses, and the
  /// turn is painted twice.
  ///
  /// `raw` is kept because "was there a prompt at all" is a question about the
  /// payload, not about the parse.
  ///
  /// `InflightPrompt`.
  struct InflightPrompt {
    enum Kind {
      case cronDelivery(ParsedCronDelivery)
      case botDmIn(IncomingBotMessage)
      case botDmReply
      case notice(InjectedRow)
      /// The words a bubble would show (the prompt with every wrapper taken off),
      /// and the references the prompt itself names.
      case user(speech: String, refs: [String]?)
    }

    var raw: String
    /// `normalizedItemText` of the item this prompt would become.
    var key: String
    /// `attachmentsMatchKey` of the references the prompt itself names, and empty
    /// when it names none — which is not the same as carrying none. An image is
    /// attached out of band, so a turn can carry one the prompt says nothing about;
    /// see `resumeOverlap` for why that makes this a one-sided check.
    var carried: String
    var kind: Kind
  }

  /// Read `inflight.user` through the SAME classifier the persisted row goes
  /// through.
  ///
  /// Anything that is not a real message must not be drawn as one, and LIVE is where
  /// that used to fail. The persisted row carries a `display_kind` and
  /// `rows-to-items` has always read it; `inflight.user` carries the text and
  /// nothing else, so this side had a second copy of the chain — and the copies
  /// disagreed. A fan-out's report reached the screen as a blue bubble opening
  /// `[ASYNC DELEGATION BATCH COMPLETE — …]`, signed by the owner; a teammate's
  /// answer, which arrives as a background-process report, did the same for longer.
  /// `classifyUserRow` is now the only chain, so a shape recognised on one path
  /// cannot be missed on the other.
  ///
  /// What is left here is what only this side knows: the comparison key, which is
  /// `normalizedItemText` of the item the prompt would become.
  ///
  /// `readInflightPrompt`.
  static func readInflightPrompt(_ userText: String) -> InflightPrompt {
    switch classifyUserRow(userText) {
    case .cronDelivery(let cron):
      return InflightPrompt(
        raw: userText,
        key: normalizeMatchText("\(cron.jobName)\n\(cron.body)"),
        carried: "",
        kind: .cronDelivery(cron)
      )

    case .botDmIn(let incoming):
      return InflightPrompt(
        raw: userText,
        key: normalizeMatchText(incoming.body),
        carried: "",
        kind: .botDmIn(incoming)
      )

    case .botDmReply:
      // The key is the raw report, which nothing on screen can match: a delivery
      // report projects no item at all, so there is nothing for it to pair with.
      return InflightPrompt(
        raw: userText,
        key: normalizeMatchText(userText),
        carried: "",
        kind: .botDmReply
      )

    case .notice(let injected):
      return InflightPrompt(
        raw: userText,
        key: normalizeMatchText(injected.body),
        carried: "",
        kind: .notice(injected)
      )

    case .user(let text, let attachments, _):
      return InflightPrompt(
        raw: userText,
        key: normalizeMatchText(text),
        carried: attachmentsMatchKey(attachments),
        kind: .user(speech: text, refs: attachments)
      )
    }
  }

  /// How much of a resume's `inflight` the transcript is already showing.
  ///
  /// A resume answers with two overlapping truths: the gateway's live view of a
  /// turn, and the rows it has already written. The user's prompt is normally in
  /// BOTH, because the gateway persists that row at submit time
  /// (`_persist_submit_user_row`) rather than when the turn ends — so projecting it
  /// on top of the bubble standing for it is how one sent message came back as two,
  /// one stamped when it was typed and one when the chat was resumed.
  ///
  /// Matching the newest prompt is not enough on its own: the user may deliberately
  /// send the same words again, and another client may have sent them while we were
  /// away. What tells those apart is the reply between them — a durable reply after
  /// the matching prompt means that turn is finished, so the `inflight` is a NEW
  /// turn and gets its own bubble — unless the reply is the `inflight`'s own
  /// assistant text, which is the gateway holding a finished turn replayable (a
  /// retained failure) and describing what the transcript already shows.
  ///
  /// ## Unless the turn WROTE that reply
  ///
  /// "A reply after the prompt ends the turn" is true of a turn that answers once.
  /// A session with interim assistant messages on does not: `_interim_assistant_cb`
  /// seals a mid-turn note, the gateway persists it as its own assistant row, and
  /// the turn goes on working. Refresh at that moment and the tail reads prompt,
  /// reply — which the rule above called a finished turn, so the still-running
  /// turn's `inflight.user` was projected a SECOND time, below the note. That is
  /// the report: a pasted terminal command in the chat twice, minutes apart, with
  /// one row for it in the gateway's database.
  ///
  /// `turnStartedAt` is what tells the two shapes apart, and it is a fact rather
  /// than a guess: a reply stamped at or after the running turn began was written
  /// BY that turn, so it says nothing about the turn being over. A reply stamped
  /// before it belongs to the turn that ended, and the `inflight` really is new.
  /// Both numbers are Unix seconds off the same gateway clock — the row's
  /// `timestamp` and `SessionLiveInfo.turn_started_at` — so the comparison needs no
  /// tolerance and no local clock.
  ///
  /// When the gateway names no start (an older one, or a turn it does not call
  /// running) the old rule stands unchanged. That is deliberate: without a start
  /// there is nothing to place the reply against, and guessing "still the same
  /// turn" would swallow the case the cron suite pins down — an hourly job whose
  /// body has not changed, delivered again after the previous run was answered.
  ///
  /// `replyPersisted` stays the narrow claim it was. A note sealed mid-turn is not
  /// the retained failure that flag means, so the turn's live text gets its own
  /// bubble under the note rather than settling onto it.
  ///
  /// The attachments are compared only when BOTH sides name one, which is the one
  /// place in reconciliation where that tolerance is needed. `inflight.user` is the
  /// submitted BODY rather than the persisted row: a file is in it, so a file-only
  /// prompt — which has no words to be told apart by — is compared properly, while
  /// an image never is, and insisting on a set the body cannot carry would paint
  /// every image send twice on resume.
  ///
  /// `resumeOverlap`.
  static func resumeOverlap(
    _ state: ChatState,
    _ prompt: InflightPrompt,
    _ assistantText: String,
    _ turnStartedAt: Double?
  ) -> (promptShown: Bool, replyPersisted: Bool) {
    let shown = shownTurn(state)
    let shownCarried = shown.carried ?? ""
    let sameAttachments = prompt.carried.isEmpty || shownCarried.isEmpty || JS.same(prompt.carried, shownCarried)
    let promptShown =
      !prompt.raw.isEmpty && shown.authored.map { JS.same($0, prompt.key) } == true && sameAttachments

    if !promptShown {
      return (false, false)
    }

    guard let settledReply = shown.settledReply else {
      return (true, false)
    }

    if JS.same(settledReply, normalizeMatchText(assistantText)) {
      return (true, true)
    }

    let wroteItself = turnStartedAt != nil && shown.settledReplyTs != nil && shown.settledReplyTs! >= turnStartedAt!

    return (wroteItself, false)
  }

  /// The un-persisted assistant bubble this turn is filling, if it has one.
  ///
  /// `liveAssistantOfCurrentTurn`.
  static func liveAssistantOfCurrentTurn(_ state: ChatState) -> AssistantItem? {
    for id in state.order.reversed() {
      guard case .assistant(let item)? = state.items[id] else {
        continue
      }

      return item.rowID == nil ? item : nil
    }

    return nil
  }

  /// The item a projectable prompt becomes, built on the `ItemBase` it is handed.
  static func inflightPromptItem(_ prompt: InflightPrompt, _ base: ItemBase) -> TranscriptItem {
    switch prompt.kind {
    case .cronDelivery(let cron):
      return .cronDelivery(
        CronDeliveryItem(
          base: base,
          jobName: cron.jobName,
          nameRedacted: cron.nameRedacted ? true : nil,
          body: cron.body,
          shape: cron.shape
        )
      )

    case .botDmIn(let incoming):
      return .botDmIn(
        BotDmInItem(
          base: base,
          senderName: incoming.senderName,
          senderHandle: JS.nonEmpty(incoming.senderHandle),
          text: incoming.body
        )
      )

    case .notice(let injected):
      return .notice(NoticeItem(base: base, noticeKind: injected.noticeKind, title: injected.title, body: injected.body))

    case .user(let speech, let refs):
      // The references too, for the same reason the projection lifts them out of
      // the text: without them a prompt that was nothing but a file resumes as an
      // empty bubble, and the row that lands for it has nothing to pair with and
      // becomes a second one.
      return .user(UserItem(base: base, text: speech, attachments: refs))

    case .botDmReply:
      // Never projected (see `projectable`); the TypeScript's draft would fall
      // through to an empty user bubble.
      return .user(UserItem(base: base, text: ""))
    }
  }
}

/// Rebuild the in-flight tail from `session.resume`. Everything it adds carries
/// `origin: 'inflight'` so a later reconcile can replace it with the persisted
/// rows without leaving a duplicate behind.
///
/// What it adds is only what the transcript does not already show. A resume lands
/// on a chat that has been streaming the very turn it describes — and on a cold
/// open whose history already carries that turn's prompt — so both halves of the
/// projection settle onto the items standing for them rather than beside them.
///
/// `applyResumeSnapshot`. The store's form is `applyResumeSnapshot(into:_:_:)`.
public func applyResumeSnapshot(_ state: ChatState, _ snapshot: SessionResumeResult, _ now: Double) -> ChatState {
  var next = state
  applyResumeSnapshot(into: &next, snapshot, now)
  return next
}

/// `applyResumeSnapshot`, in place.
public func applyResumeSnapshot(into next: inout ChatState, _ snapshot: SessionResumeResult, _ now: Double) {
  typealias R = TranscriptReducer

  let raw = snapshot.json
  let inflight = R.rec(raw["inflight"])
  let userText = JS.trim(R.str(inflight["user"]))
  let assistantText = R.str(inflight["assistant"])
  let prompt = R.readInflightPrompt(userText)
  // `running` is the one field the contract models as "is this turn still
  // going", and the same one `turn.active` is set from at the bottom of this
  // function. `inflight` carries no status a running turn ever reports —
  // `inflight.status` only speaks up to say `interrupted` — and
  // `inflight.streaming` is false between two segments of a turn that has not
  // stopped.
  let running = R.isTrue(raw["running"])
  // Only a RUNNING turn has a start worth comparing against; on a stopped one
  // the gateway's number is the last turn's and would date rows into a turn
  // that is over. `state.info` is the same `SessionLiveInfo` the resume carried,
  // dispatched as `session.info` a step before this one, which is why a caller
  // that forwards only the top-level field still gets the comparison.
  let turnStartedAt = running ? (R.num(raw["turn_started_at"]) ?? R.num(next.info?.json["turn_started_at"])) : nil
  let overlap = R.resumeOverlap(next, prompt, assistantText, turnStartedAt)

  // Either way, the resume has named the author of the newest turn, and the
  // placeholder exists only because `message.start` could not. It is filled
  // below when the prompt is new to us; when the prompt is already on screen
  // there is nothing left for it to become, and a blank bubble between a cron
  // card and its reply is a row the reader has to explain to themselves.
  let placeholder = userText.isEmpty ? nil : R.foreignPlaceholderID(next)
  /*
    A delivery report opens a turn, and projects nothing.

    The teammate's answer inside it belongs on the dispatch that asked for it, and
    a resume cannot make that join: the dispatch is a tool row this snapshot says
    nothing about, and it may not even be on screen. So this side stays quiet and
    leaves the row to the tail fetch, which has the whole transcript to join
    against. What must NOT happen is the fall-through that used to: the report
    painted as the owner's own bubble, headers, command line, teammate's reply and
    all.
  */
  let projectable: Bool = if case .botDmReply = prompt.kind { false } else { true }

  if !userText.isEmpty && projectable && !overlap.promptShown {
    // The turn a resume finds running may be a scheduled job's or a teammate's,
    // not the owner's. Projecting all three here rather than only in
    // `rows-to-items` is what keeps the invariant: a delivery renders as the
    // same card, and a teammate's message as the same tinted bubble, whether the
    // chat was open when it landed or loaded from history afterwards.
    let draftID = "i:\(next.turn.nextSeq)"

    // Filling the placeholder rather than appending is the whole point:
    // appended, the prompt would sit BELOW the reply it started, because the
    // placeholder is already above the streaming bubble.
    if let placeholder {
      R.recastItem(&next, placeholder, ts: now / 1000, origin: .inflight) { R.inflightPromptItem(prompt, $0) }
    } else {
      R.addItem(&next, id: draftID, ts: now / 1000, origin: .inflight) { R.inflightPromptItem(prompt, $0) }
    }
  } else if let placeholder {
    R.dropItem(&next, placeholder)
  }

  if placeholder != nil {
    // Nothing is waiting for an author any more. The flag is diagnostics only —
    // the tail fetch is scheduled by the caller — but a report that says "tail
    // pending" with no placeholder to fill is a report that misleads.
    next.turn.foreignReconcilePending = nil
  }

  let inflightStatus = R.str(inflight["status"])
  let inflightError = JS.trim(R.str(inflight["error"]))
  let failure: AssistantFailure? =
    inflightError.isEmpty
    ? nil
    : AssistantFailure(
      message: inflightError,
      partial: !assistantText.isEmpty,
      recoverable: R.isTrue(inflight["recoverable"]) ? true : nil
    )
  let streaming = R.isTrue(inflight["streaming"])

  // A durable row already carrying this reply needs nothing added to it; the
  // `live` branch below covers the bubble a stream is still filling.
  if (!assistantText.isEmpty || failure != nil) && !overlap.replyPersisted {
    let live = R.liveAssistantOfCurrentTurn(next)
    // `inflight.assistant` is the whole turn's deltas run together, so the notes
    // this turn already sealed (and the gateway already wrote) open it. Those are
    // on screen as their own items; only what follows them is this bubble's.
    let earlier = R.currentTurnIDs(next).compactMap { id -> AssistantItem? in
      guard let item = next.items[id]?.asAssistant, live.map({ !JS.same(item.id, $0.id) }) ?? true else { return nil }
      return item
    }
    // Only for the turn the snapshot describes: without its prompt on screen the
    // turn above is somebody else's, and its notes are not this reply's.
    let unshown = overlap.promptShown ? unshownTail(assistantText, earlier) : nil
    let replyText = unshown ?? assistantText
    // Every word of it already a note above: nothing is left to stand up.
    let nothingNew = unshown.map { JS.trim($0).isEmpty } == true && failure == nil

    if let live {
      // `inflight.assistant` is this turn's reply flattened to one string, and
      // the bubble on screen is that same reply — so it settles onto it. A
      // bubble a tool call already SEALED holds one segment of that flat
      // string, never the whole of it, so its text is left alone and only the
      // verdict lands: repainting it would show the segment twice.
      let sealed = live.interim

      R.patchAssistant(&next, live.id) { draft in
        if !sealed {
          if JS.length(replyText) > JS.length(draft.text) {
            draft.text = replyText
          }

          draft.streaming = streaming
        }

        if let failure {
          draft.status = .error
          draft.error = failure
        } else if inflightStatus == "interrupted" && !sealed {
          draft.status = .interrupted
        }
      }

      if streaming && !sealed {
        next.turn.assistantID = live.id
      }
    } else if !nothingNew {
      let id = R.addItem(&next, id: "i:\(next.turn.nextSeq)", ts: now / 1000, origin: .inflight) { base in
        .assistant(
          AssistantItem(
            base: base,
            text: replyText,
            streaming: streaming,
            interim: false,
            status: failure != nil ? .error : inflightStatus == "interrupted" ? .interrupted : nil,
            error: failure
          )
        )
      }

      if streaming {
        next.turn.assistantID = id
      }
    }
  }

  if running {
    next.turn.active = true
    next.turn.startedAt = next.turn.startedAt ?? now
  }

  let queued = JS.trim(R.str(R.rec(raw["queued"])["user"]))

  if !queued.isEmpty {
    next.queued = QueuedPrompt(text: queued)
  }

  let todoState = R.rec(raw["todo_state"])

  if case .array(let todos)? = todoState["todos"] {
    next.todo = TodoSnapshot(todos: todos, revision: R.num(todoState["revision"]) ?? 0)
  }

  let pending = R.rec(raw["pending_approval"])

  if !R.str(pending["request_id"]).isEmpty || !R.str(pending["command"]).isEmpty {
    // `pending_approval` is a queue entry, not a live server request: synthesize
    // a request id from it so the sheet can be rebuilt and later cancelled.
    let requestID = "pending:\(JS.nonEmpty(R.str(pending["request_id"])) ?? "approval")"

    applyServerRequest(
      into: &next,
      ServerRequest(json: ["id": .string(requestID), "method": "approval", "params": .object(pending), "replayed": true]),
      now
    )
  }

  if case .array(let requests)? = raw["open_requests"] {
    for request in requests {
      guard var json = request.objectValue else { continue }

      json["replayed"] = true
      applyServerRequest(into: &next, ServerRequest(json: json), now)
    }
  }

  next.hydration = .live
}
