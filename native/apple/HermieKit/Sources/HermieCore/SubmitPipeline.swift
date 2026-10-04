import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

// What the reader does to a chat: send, queue, steer, stop, answer. The
// `send` / `queue` / `steerQueued` / `stopTurn` / `respondApproval` /
// `respondClarify` / `lockClarify` / `acknowledgeApproval` / `openApprovals`
// half of `chat-controller.ts`, with its order of operations kept:
//
// - A send paints first (`beginLocalTurn`) and settles against
//   `prompt.submit`'s answer (`confirmSubmit`); a refused or dropped submit
//   keeps the bubble (the words are the reader's) and stops claiming a turn
//   runs (`markInterrupted`).
// - While a turn runs, a send is parked HERE, not on the gateway, because the
//   three things a reader does with a parked message are Steer, Edit and
//   Delete, and the gateway's queue can do none of them. One parked message
//   goes out per completed turn.
// - Attachments arrive already staged (`AttachmentTray`): a file is uploaded
//   and named in the prompt by its `@file:` reference, an image's bytes go over
//   the socket (`image.attach_bytes`) before the submit, as the web client does.
//   A parked message keeps them until it leaves the queue.
//
// Answers to a live request go out on its own JSON-RPC reply, and the card is
// marked answered only once that reply went out. A reply whose socket is gone
// answers `false` (`ServerRequestDelivery.respond`): the card stays open, and
// the copy the gateway re-delivers after the reconnect folds onto it with a
// live handle of its own. Nothing is answered into the void.

extension TranscriptStore {
  // MARK: - Sending

  enum SendStart: Sendable {
    case queued(String)
    case painted(itemID: String?, runtimeID: String)
  }

  /// `send`: answers the id of the item the prompt was painted as, or `nil`
  /// when it was parked behind the running turn.
  ///
  /// `display` is for one caller, a slash command's `send` or `skill` directive: its `text` is the
  /// expansion the model is meant to read, not what the reader typed, and the bubble shows
  /// `display` (`/docx`) while the gateway is sent the expansion.
  @discardableResult
  public func send(
    _ key: String,
    text: String,
    attachments: [String]? = nil,
    outgoing: [OutgoingAttachment] = [],
    display: String? = nil
  ) async throws -> String? {
    switch try await submit(key, text: text, attachments: attachments, outgoing: outgoing, display: display) {
    case .submitted(let itemID): itemID
    case .parked: nil
    }
  }

  /**
   `send` for a caller that has to know what became of the prompt (a Shortcut's "Send to" and
   "Ask"): taken by the gateway, as the item it was painted as, or parked behind the running turn
   under a queue id that `followedPrompt(_:)` then follows until `unfollow(_:)`.
   */
  public func sendFollowing(_ key: String, text: String) async throws -> SendReceipt {
    try await submit(key, text: text, attachments: nil, follow: true)
  }

  /// What became of a parked prompt `sendFollowing` handed out, or nil when nobody follows it.
  public func followedPrompt(_ queueID: String) -> FollowedPrompt? {
    followedPrompts[queueID]
  }

  /// Stop following a parked prompt; what becomes of it is no longer recorded.
  public func unfollow(_ queueID: String) {
    followedPrompts[queueID] = nil
  }

  /// One send. `parkAs` parks it under an id it already had (a drained prompt that met a new turn);
  /// `follow` records what becomes of it when it is parked, from the moment it is.
  func submit(
    _ key: String,
    text: String,
    attachments: [String]?,
    parkAs: String? = nil,
    follow: Bool = false,
    outgoing: [OutgoingAttachment] = [],
    display: String? = nil
  ) async throws -> SendReceipt {
    let author = options.ownAuthor()
    // What the bubble records: the references the gateway's own row will carry. A file is also named
    // in the prompt, which is what is painted AND submitted (the two have to be byte-identical, or
    // the gateway echoes the turn back as a message the reconciler does not recognise).
    let references = outgoing.isEmpty ? attachments : outgoing.map(\.reference)
    let body = AttachmentRules.withFileReferences(text, paths: outgoing.compactMap(\.filePath))
    let images: [(filename: String, base64: String)] = outgoing.compactMap {
      if case .image(let filename, let base64) = $0 { (filename, base64) } else { nil }
    }
    let ticket = generation(of: key)

    guard !retiring.contains(key) else {
      throw ChatRuntimeError.startingNewConversation(key)
    }

    // The decision and the paint in one step: nothing may land between reading
    // `turn.active` and claiming the turn.
    let start = try await local(key, generation: ticket) { () throws -> SendStart in
      guard !self.retiring.contains(key) else {
        throw ChatRuntimeError.startingNewConversation(key)
      }

      guard let state = self.chats[key]?.state, let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty else {
        throw ChatRuntimeError.notAttached(key)
      }

      if state.turn.active {
        let id = self.enqueue(key, text: text, attachments: references, id: parkAs)

        if !outgoing.isEmpty {
          self.queuedOutgoing[id] = outgoing
        }

        if follow {
          self.followedPrompts[id] = .parked
        }

        return .queued(id)
      }

      let now = self.now()
      self.mutateState(key) { beginLocalTurn(into: &$0, display ?? body, references, now, author) }
      self.chats[key]?.sending += 1

      return .painted(itemID: self.chats[key]?.state.order.last, runtimeID: runtimeID)
    }

    let painted: String?
    let runtimeID: String

    switch start {
    case .queued(let id):
      return .parked(queueID: id)
    case .painted(let itemID, let runtime):
      painted = itemID
      runtimeID = runtime
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key), "text": .string(body)]

    do {
      // Images first: the gateway queues them onto the next turn, so the order matters.
      for image in images {
        _ = try await link.requestReply(
          RPC.ImageAttachBytes.name,
          params: [
            "session_id": .string(runtimeID), "profile": .string(key), "content_base64": .string(image.base64),
            "filename": .string(image.filename)
          ])
      }

      // `claimTurn`: when the plugin reads claims, tell it whose turn this is,
      // right before the submit that names the same runtime session. A courtesy
      // that never fails the send (`GatewayLink.claimTurn`).
      if await roster.offers(PluginCapabilities.contextTurnClaim) {
        await link.claimTurn(runtimeID)
      }

      try await ordered(key, generation: ticket, { [link] in
        try await link.requestReply(RPC.PromptSubmit.name, params: params)
      }) { reply in
        self.doneSending(key)

        // Only on the conversation it was sent in.
        guard self.chats[key]?.state.runtimeSessionID == runtimeID else {
          return
        }

        let status = reply.result["status"].flatMap { $0.isNull ? nil : $0 } ?? .null
        let now = self.now()
        self.mutateState(key) { confirmSubmit(into: &$0, PromptSubmitResult(json: ["status": status]), now) }
        self.syncApprovalPoll()
      }

      return .submitted(itemID: painted)
    } catch {
      // Only the conversation this was sent in counts it: a successor under the
      // key started its own count at zero.
      if generation(of: key) == ticket {
        doneSending(key)
      }

      // The optimistic bubble stays — the text is the reader's — but the turn
      // is not running, so the composer comes back.
      _ = try? await local(key, generation: ticket) {
        guard self.chats[key]?.state.runtimeSessionID == runtimeID else {
          return
        }

        let now = self.now()
        self.mutateState(key) { markInterrupted(into: &$0, now) }
      }

      throw error
    }
  }

  func doneSending(_ key: String) {
    if let sending = chats[key]?.sending, sending > 0 {
      chats[key]?.sending = sending - 1
    }
  }

  /// `stopTurn`: stop the running turn. The partial reply is kept; it was really said.
  public func stopTurn(_ key: String) async throws {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]
    let interrupt = {
      let now = self.now()
      self.mutateState(key) { markInterrupted(into: &$0, now) }
      self.syncApprovalPoll()
    }

    do {
      try await ordered(key, { [link] in try await link.requestReply(RPC.SessionInterrupt.name, params: params) }) {
        _ in interrupt()
      }
    } catch {
      _ = try? await local(key) { interrupt() }
      throw error
    }
  }

  // MARK: - The queue behind a running turn

  /// `queue`: park a message and give the strip a row for it. Answers its queue id.
  @discardableResult
  func enqueue(_ key: String, text: String, attachments: [String]?, id: String? = nil) -> String {
    let id = id ?? {
      queueSeq += 1
      return "q:\(queueSeq)"
    }()

    chats[key]?.queue.append(QueuedMessage(id: id, text: text, attachments: attachments))
    markDirty(key)
    return id
  }

  /// A followed prompt came to something; nothing is recorded for one nobody follows any more.
  func settleFollowed(_ id: String, _ fate: FollowedPrompt) {
    if followedPrompts[id] != nil {
      followedPrompts[id] = fate
    }
  }

  func takeQueued(_ key: String, _ id: String) -> QueuedMessage? {
    guard let index = chats[key]?.queue.firstIndex(where: { $0.id == id }) else {
      return nil
    }

    let entry = chats[key]?.queue.remove(at: index)
    markDirty(key)
    return entry
  }

  /// `drainQueue`: the turn ended; submit the oldest parked message. One per
  /// completion, so a queue of three goes out in the order it was written.
  func drainQueue(_ key: String) async {
    guard let next = chats[key]?.queue.first, let taken = takeQueued(key, next.id) else {
      return
    }

    let outgoing = queuedOutgoing.removeValue(forKey: taken.id) ?? []

    // A failed send painted its own failure; putting the message back would
    // start a loop against a gateway that is refusing it. One that met a new
    // turn is parked again under the id it had.
    do {
      let receipt = try await submit(
        key, text: taken.text, attachments: taken.attachments, parkAs: taken.id, outgoing: outgoing)

      if case .submitted(let itemID) = receipt {
        settleFollowed(taken.id, .submitted(itemID: itemID))
      }
    } catch {
      settleFollowed(taken.id, .failed(ChatResolver.describe(error)))
    }
  }

  /// `editQueued`: take a parked message back; answers the text for the composer.
  public func editQueued(_ key: String, _ id: String) -> String? {
    guard let taken = takeQueued(key, id) else {
      return nil
    }

    queuedOutgoing[id] = nil
    settleFollowed(id, .withdrawn)
    return taken.text
  }

  public func deleteQueued(_ key: String, _ id: String) {
    if takeQueued(key, id) != nil {
      queuedOutgoing[id] = nil
      settleFollowed(id, .withdrawn)
    }
  }

  /// `steerQueued`: hand a parked message to the running turn now.
  ///
  /// Painted before the round trip (taking it out of the strip alone reads as
  /// the message being deleted); a refusal un-paints it and parks it again.
  ///
  /// A steer in the air counts as work in progress: `/new` waits for nothing
  /// and refuses while one is out. It belongs to the conversation it started
  /// in; a refusal that comes back after `/new` replaced it is put back nowhere.
  public func steerQueued(_ key: String, _ id: String) async throws -> CorrectionStatus {
    let ticket = generation(of: key)

    guard !retiring.contains(key) else {
      throw ChatRuntimeError.startingNewConversation(key)
    }

    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      throw ChatRuntimeError.notAttached(key)
    }

    // A steer folds text into the running turn; an image cannot ride along, and a file's reference
    // is composed at send time. A message with attachments waits for its own turn.
    guard queuedOutgoing[id] == nil, let taken = takeQueued(key, id) else {
      return .rejected
    }

    steering[key, default: 0] += 1

    defer {
      if generation(of: key) == ticket, let count = steering[key] {
        steering[key] = count > 1 ? count - 1 : nil
      }
    }

    let steer = try await local(key, generation: ticket) { () -> String? in
      let now = self.now()
      self.mutateState(key) { beginSteer(into: &$0, taken.text, taken.attachments, now) }
      return self.chats[key]?.state.order.last
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key), "text": .string(taken.text)]

    do {
      return try await ordered(key, generation: ticket, { [link] in
        try await link.requestReply(RPC.SessionSteer.name, params: params)
      }) { reply in
        let status = reply.result["status"]?.stringValue.map(CorrectionStatus.init(rawValue:)) ?? .queued

        if status == .rejected {
          self.unwindSteer(key, taken)
        } else {
          self.settleFollowed(taken.id, .submitted(itemID: steer))
        }

        return status
      }
    } catch {
      _ = try? await local(key, generation: ticket) { self.unwindSteer(key, taken) }
      throw error
    }
  }

  /// `assertIdle`: nothing under this key would be lost by moving it — no send
  /// waiting for its answer, no steer in the air, nothing in the queue.
  func isIdle(_ key: String) -> Bool {
    (chats[key]?.sending ?? 0) == 0 && (steering[key] ?? 0) == 0 && (chats[key]?.queue.isEmpty ?? true)
  }

  /// `unwindSteer`: a steer the gateway did not take comes off and goes back in the strip.
  func unwindSteer(_ key: String, _ taken: QueuedMessage) {
    mutateState(key) { dropSteer(into: &$0, taken.text) }
    chats[key]?.queue.append(taken)
    markDirty(key)
  }

  // MARK: - Answering

  /// The card is still open and no answer to it is on its way: an answer that
  /// came back `false` did not go out (not a second tap on one that did).
  func answerDidNotGoOut(_ key: String, _ requestID: String) -> Bool {
    isOpenCard(key, requestID) && !answering.contains(requestID)
  }

  /// Whether the card for this request is up and still waiting for an answer.
  func isOpenCard(_ key: String, _ requestID: String) -> Bool {
    guard let state = chats[key]?.state, let itemID = state.byRequestID[requestID] else {
      return false
    }

    switch state.items[itemID] {
    case .approval(let item)?: return item.state == .open
    case .clarify(let item)?: return item.state == .open
    default: return false
    }
  }

  /// `respondApproval`. Answers whether an answer went out: `false` when the
  /// card is no longer open or an answer to it is already on its way (a second
  /// tap), or when the socket that delivered it is gone (the card then stays
  /// open for its re-delivered copy). The card is marked answered only once
  /// the answer went out; a call that fails leaves it open and throws.
  @discardableResult
  public func respondApproval(_ key: String, requestID: String, choice: String, all: Bool = false) async throws -> Bool {
    guard isOpenCard(key, requestID), !answering.contains(requestID), let state = chats[key]?.state else {
      return false
    }

    answering.insert(requestID)

    defer {
      answering.remove(requestID)
      syncApprovalPoll()
    }

    let item = state.byRequestID[requestID].flatMap { state.items[$0] }
    let approvalID = item?.asApproval.map(\.approvalID) ?? requestID
    var result: JSONObject = ["choice": .string(choice)]

    if all {
      result["all"] = true
    }

    if let live = deliveries[requestID] {
      deliveries[requestID] = nil
      acknowledged.remove(requestID)
      return try await answerLive(key, live, requestID: requestID, answer: .text(choice), result: result)
    }

    acknowledged.remove(requestID)

    if let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty, !approvalID.isEmpty {
      var params: JSONObject = [
        "session_id": .string(runtimeID),
        "profile": .string(key),
        "choice": .string(choice),
        "request_id": .string(approvalID)
      ]

      if all {
        params["all"] = true
      }

      try await answerByCall(key, requestID: requestID, answer: .text(choice), RPC.ApprovalRespond.name, .object(params))
    } else {
      // No queue id and no reply frame: `request.answer` settles the open
      // request by its own id with the result the reply would have carried.
      let params: JSONObject = ["id": .string(requestID), "result": .object(result), "profile": .string(key)]
      try await answerByCall(key, requestID: requestID, answer: .text(choice), RPC.RequestAnswer.name, .object(params))
    }

    return true
  }

  /// `respondClarify`: a batch answers `answers` by qid, a single question the
  /// bare `answer`. A partial batch with a live handle locks each answer.
  /// Answers whether an answer went out, as `respondApproval` does.
  @discardableResult
  public func respondClarify(_ key: String, requestID: String, answers: JSRecord<String>) async throws -> Bool {
    guard isOpenCard(key, requestID), !answering.contains(requestID), let state = chats[key]?.state else {
      return false
    }

    answering.insert(requestID)

    defer {
      answering.remove(requestID)
    }

    let clarify = state.byRequestID[requestID].flatMap { state.items[$0] }?.asClarify
    let complete = clarify.map { item in item.questions.allSatisfy { answers[$0.qid] != nil } } ?? true
    let answerValues: JSONObject = answers.dictionary.mapValues { JSONValue.string($0) }
    let result: JSONObject =
      clarify?.batch == true ? ["answers": .object(answerValues)] : ["answer": .string(answers.values.first ?? "")]
    let answer = RequestAnswer.byQuestion(answers)
    let live = deliveries[requestID]

    if let live, complete {
      deliveries[requestID] = nil
      acknowledged.remove(requestID)
      return try await answerLive(key, live, requestID: requestID, answer: answer, result: result)
    }

    if live == nil, complete || clarify?.batch != true {
      let params: JSONObject = ["id": .string(requestID), "result": .object(result), "profile": .string(key)]
      try await answerByCall(key, requestID: requestID, answer: answer, RPC.RequestAnswer.name, .object(params))
      return true
    }

    for (qid, value) in answers.entries {
      try await lockClarify(key, requestID: requestID, questionID: qid, answer: value)
    }

    return true
  }

  /// `lockClarify`: lock one answer of a batch without resolving the request.
  /// The answer shows once the lock went through.
  public func lockClarify(_ key: String, requestID: String, questionID: String, answer: String) async throws {
    let params: JSONObject = [
      "request_id": .string(requestID),
      "question_id": .string(questionID),
      "answer": .string(answer),
      "profile": .string(key)
    ]

    try await answerByCall(key, requestID: requestID, answer: .byQuestion([questionID: answer]), RPC.ClarifyLock.name, .object(params))
  }

  /// Answer through a call (no live reply to answer on) and mark the card only
  /// once the call succeeded, at the place the answer went out.
  func answerByCall(
    _ key: String,
    requestID: String,
    answer: RequestAnswer,
    _ method: String,
    _ params: JSONValue
  ) async throws {
    let link = self.link

    try await afterSending(key, { try await link.requestReply(method, params: params) }) { _ in
      self.mutateState(key) { answerRequest(into: &$0, requestID, answer) }
    }
  }

  /// Answer on the live reply; mark the card answered at the place the answer
  /// went out, among the chat's frames, and only if it did.
  func answerLive(
    _ key: String,
    _ live: Delivery,
    requestID: String,
    answer: RequestAnswer,
    result: JSONObject
  ) async throws -> Bool {
    let inbound = live.inbound

    return try await afterSending(key, { await inbound.respond(result) }) { sent in
      if sent {
        self.mutateState(key) { answerRequest(into: &$0, requestID, answer) }
      }

      return sent
    }
  }

  /// Hold the chat's lane while `perform` sends something, then apply `apply`
  /// after every frame taken in before the send and before any taken in after.
  /// A `perform` that throws applies nothing; neither does one whose chat was
  /// forgotten meanwhile.
  func afterSending<R: Sendable, T: Sendable>(
    _ key: String,
    _ perform: @escaping @Sendable () async throws -> R,
    apply: @escaping (R) -> T
  ) async throws -> T {
    let ticket = generation(of: key)

    // What came in before the send is placed before the answer.
    await catchUp([chats[key]?.state.runtimeSessionID])

    let id = nextCallID
    nextCallID += 1
    let issue = highestIngested
    outstanding[id] = OrderedCall(lane: key, binding: false, issueIndex: issue)

    let value: R

    do {
      value = try await perform()
    } catch {
      outstanding[id] = nil
      scheduleFlush()
      throw error
    }

    guard !isShutDown else {
      outstanding[id] = nil
      throw CancellationError()
    }

    outstanding[id]?.answered = true

    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, any Error>) in
      let step = Step(
        run: {
          self.outstanding[id] = nil

          guard self.generation(of: key) == ticket else {
            continuation.resume(throwing: CancellationError())
            return
          }

          continuation.resume(returning: apply(value))
        },
        abandon: {
          self.outstanding[id] = nil
          continuation.resume(throwing: CancellationError())
        }
      )

      insert(LaneItem(index: issue, rank: .local, arrival: arrival(), payload: .step(step)), into: key)
      scheduleFlush()
    }
  }

  /// `acknowledgeApproval`: tell the queue a person is looking at this approval.
  /// A courtesy to its timeout, sent once per request, never a precondition.
  public func acknowledgeApproval(_ key: String, _ requestID: String) async {
    guard !acknowledged.contains(requestID), let state = chats[key]?.state,
      let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty
    else {
      return
    }

    let item = state.byRequestID[requestID].flatMap { state.items[$0] }?.asApproval
    let approvalID = item.flatMap { $0.approvalID.isEmpty ? nil : $0.approvalID } ?? requestID

    acknowledged.insert(requestID)

    _ = try? await link.requestReply(
      RPC.ApprovalReceived.name,
      params: ["session_id": .string(runtimeID), "request_id": .string(approvalID)]
    )
  }

  /// `openApprovals`: what the GATEWAY says is still open for this bot, right
  /// now, straight off `approval.pending`. A notification action re-validates
  /// against it before answering; nothing the device believes counts.
  public func openApprovals(_ key: String) async -> [PendingApproval] {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return []
    }

    let reply = try? await link.requestReply(
      RPC.ApprovalPending.name,
      params: ["session_id": .string(runtimeID), "profile": .string(key)]
    )

    return (reply?.result["approvals"]?.arrayValue ?? []).compactMap { $0.objectValue.map(PendingApproval.init(json:)) }
  }

  /// Whether the gateway still waits on the approval behind this card, asked of
  /// `approval.pending` right before an answer goes out.
  ///
  /// `unknown` when the question cannot be put: no attached session, a card
  /// with no queue id, or a gateway that did not answer the call. An unknown
  /// standing never blocks an answer — only a list that leaves the entry out
  /// does — so a gateway without the method can still be answered.
  public func approvalStanding(_ key: String, requestID: String) async -> ApprovalStanding {
    guard let state = chats[key]?.state, let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty,
      let approvalID = state.byRequestID[requestID].flatMap({ state.items[$0] })?.asApproval?.approvalID,
      // A request that carried no queue id has its transport id here instead,
      // which no queue lists.
      !approvalID.isEmpty, approvalID != requestID
    else {
      return .unknown
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]

    guard let reply = try? await link.requestReply(RPC.ApprovalPending.name, params: params),
      let approvals = reply.result["approvals"]?.arrayValue
    else {
      return .unknown
    }

    return approvals.contains { $0["request_id"]?.stringValue == approvalID } ? .pending : .gone
  }

  /// Close a card the gateway no longer holds open, as its own `request.cancel`
  /// would: placed among the chat's frames, remembered so a late copy of the
  /// request does not reopen it, and its reply handle forgotten.
  public func withdrawRequest(_ key: String, requestID: String, reason: String) async {
    _ = try? await local(key) {
      guard self.isOpenCard(key, requestID), let runtimeID = self.chats[key]?.state.runtimeSessionID else {
        return
      }

      let event = GatewayEvent(json: [
        "type": .string(GatewayEventType.requestCancel),
        "session_id": .string(runtimeID),
        "payload": ["id": .string(requestID), "reason": .string(reason)]
      ])
      let now = self.now()
      self.closedRequests[key, default: []].insert(requestID)
      self.mutateState(key) { applyEvent(into: &$0, event, now) }
      self.pruneRequests(key)
    }
  }

  // MARK: - A new conversation

  /// `startNewConversation` for the shared Bot Chat (`/new`, `/reset`, `/clear`).
  ///
  /// Retire-then-create, because the title is the registry key: un-hide the
  /// old session (upstream refuses to rename a hidden `Bot Chat`), rename it on
  /// its RUNTIME id, mint the successor under it, title that one `Bot Chat` at
  /// once so it exists before the first prompt, close the old one, and switch.
  /// Every step that can fail rolls back towards "nothing happened". The
  /// outcome lands as a command row in the transcript the reader is left in.
  ///
  /// While it runs, nothing is sent or steered into the chat (those calls throw
  /// `ChatRuntimeError` with `isNotAttached`, so the draft stays): a message
  /// written now would otherwise go to the session being put away.
  public func startNewConversation(_ key: String, argument: String = "", command: String = "/new") async throws {
    // A hydration in flight first: its answers belong to the conversation it opens.
    await waitForOpening(key)

    guard !retiring.contains(key) else {
      throw ConversationBusyError(botName: key)
    }

    guard let state = chats[key]?.state, let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty,
      !state.storedSessionID.isEmpty, let bot = await roster.bot(named: key)
    else {
      throw ChatRuntimeError.notAttached(key)
    }

    let resolver = roster.resolver

    if state.turn.active {
      commandRow(
        key,
        runtimeID,
        command,
        "This bot is still working on the last turn. Let it finish, or stop it, and run this again — a conversation cannot be put away mid-answer."
      )
      return
    }

    // `assertIdle`: a send not yet at the gateway, or messages waiting in the
    // queue, would be lost with the conversation they belong to.
    guard isIdle(key) else {
      throw ConversationBusyError(botName: key)
    }

    // From here until the successor is open nothing new starts under the key,
    // so it stays as idle as it is now.
    retiring.insert(key)

    defer {
      retiring.remove(key)
    }

    let storedID = state.storedSessionID
    let stamped = "\(ChatResolver.canonicalTitle) · \(Self.localStamp(now()))"
    let asked = argument.trimmingCharacters(in: .whitespacesAndNewlines)
    var retired = asked.isEmpty ? stamped : asked
    var refusedName = ""

    try? await resolver.setHidden(key, runtimeID: runtimeID, hidden: false)

    do {
      try await resolver.titleSession(key, runtimeID: runtimeID, title: retired)
    } catch {
      guard !asked.isEmpty else {
        await undoRetire(resolver, key, runtimeID, renamed: false)
        commandRow(key, runtimeID, command, Self.retireFailed(ChatResolver.describe(error)))
        return
      }

      // A refused title is nearly always the argument; the owner asked for a new
      // conversation, not that name.
      refusedName = ChatResolver.describe(error)
      retired = stamped

      do {
        try await resolver.titleSession(key, runtimeID: runtimeID, title: retired)
      } catch {
        await undoRetire(resolver, key, runtimeID, renamed: false)
        commandRow(key, runtimeID, command, Self.retireFailed(ChatResolver.describe(error)))
        return
      }
    }

    let created: ChatResolver.Created

    do {
      created = try await resolver.createCanonicalSession(key, parentSessionID: storedID)
    } catch {
      // Nothing was created, so the conversation under the retired name IS
      // still this bot's chat. Its name goes back.
      await undoRetire(resolver, key, runtimeID, renamed: true)
      commandRow(
        key,
        runtimeID,
        command,
        "The gateway would not start a new conversation (\(ChatResolver.describe(error))). You are still in the one you were in."
      )
      return
    }

    if !created.runtimeSessionID.isEmpty {
      _ = try? await resolver.titleSession(key, runtimeID: created.runtimeSessionID, title: ChatResolver.canonicalTitle)
    }

    try? await resolver.closeSession(key, runtimeID: runtimeID)

    await switchCanonical(bot, created.canonical)

    let notice = Self.newConversationNotice(retired: retired, asked: asked, refusedName: refusedName)
    commandRow(key, chats[key]?.state.runtimeSessionID ?? "", command, notice)
  }

  func undoRetire(_ resolver: ChatResolver, _ key: String, _ runtimeID: String, renamed: Bool) async {
    if renamed {
      _ = try? await resolver.titleSession(key, runtimeID: runtimeID, title: ChatResolver.canonicalTitle)
    }

    try? await resolver.setHidden(key, runtimeID: runtimeID, hidden: true)
  }

  /// `switchCanonical`: point this bot at another canonical chat and open it,
  /// through the ordinary open path. The cache on disk holds the conversation
  /// just put away, so it goes.
  func switchCanonical(_ bot: Bot, _ canonical: CanonicalSession) async {
    await roster.setCanonical(bot.name, canonical)

    if let cache {
      try? await cache.forget(bot: bot.name)
    }

    let observedOptions = observed[bot.name]
    forget(bot.name)

    if let observedOptions {
      observed[bot.name] = observedOptions
    }

    var moved = bot
    moved.canonical = canonical
    try? await open(moved)
  }

  /// `commandRow`: a command's answer as the notice row a reader cannot miss.
  func commandRow(_ key: String, _ runtimeID: String, _ command: String, _ body: String) {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    let event = GatewayEvent(json: [
      "type": "notice",
      "session_id": .string(runtimeID),
      "payload": [
        "message": .string(trimmed.isEmpty ? "/" : trimmed),
        "detail": .string(body),
        "noticeKind": "command"
      ]
    ])
    let now = now()
    mutateState(key) { applyEvent(into: &$0, event, now) }
  }

  /// `localStamp`: `2026-09-21 23:16`, in the reader's own zone.
  static func localStamp(_ now: Double) -> String {
    let date = Date(timeIntervalSince1970: now / 1000)
    let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    let pad = { (value: Int?) in String(format: "%02d", value ?? 0) }

    return "\(parts.year ?? 0)-\(pad(parts.month))-\(pad(parts.day)) \(pad(parts.hour)):\(pad(parts.minute))"
  }

  static func retireFailed(_ reason: String) -> String {
    "The gateway would not put this conversation away (\(reason)), so nothing was changed."
  }

  static func newConversationNotice(retired: String, asked: String, refusedName: String) -> String {
    let kept = "New conversation started. The previous one is kept as “\(retired)”."

    if !refusedName.isEmpty {
      return "\(kept) The gateway would not take “\(asked)” (\(refusedName)), so it was filed under its own name instead."
    }

    if !asked.isEmpty {
      return
        "\(kept) A name given to this command goes on the conversation being put away, not on the new one — a bot's chat is always called “\(ChatResolver.canonicalTitle)”."
    }

    return kept
  }
}

/// What became of one send (`TranscriptStore.sendFollowing`).
public enum SendReceipt: Sendable, Equatable {
  /// The gateway took it; the id of the item it was painted as.
  case submitted(itemID: String?)
  /// Parked behind the running turn, under this queue id: nothing reached the gateway yet.
  case parked(queueID: String)
}

/// What became of a parked prompt somebody follows (`TranscriptStore.followedPrompt`).
public enum FollowedPrompt: Sendable, Equatable {
  /// Still waiting for the running turn to end.
  case parked
  /// The gateway took it (after the turn, or as a steer into it); the item it was painted as.
  case submitted(itemID: String?)
  /// Its submit was refused or dropped; the gateway's error, for a sentence.
  case failed(String)
  /// Taken back out of the queue (edited or deleted), or gone with its conversation.
  case withdrawn
}

/// What `approval.pending` says about one approval card (`approvalStanding`).
public enum ApprovalStanding: Sendable, Equatable {
  /// Listed: the gateway still waits for an answer.
  case pending
  /// Left out: answered elsewhere, timed out or withdrawn.
  case gone
  /// The question could not be put; the answer goes out and the gateway decides.
  case unknown
}

/// Moving a bot's chat to another conversation was refused because it would
/// lose something: a send not yet at the gateway, or messages waiting in the
/// queue (`ConversationBusyError`).
public struct ConversationBusyError: Error, Sendable, Equatable, CustomStringConvertible {
  public var botName: String

  public init(botName: String) {
    self.botName = botName
  }

  public var description: String {
    "\(botName) is still replying or has messages queued. Wait until the reply is finished or clear the queue first."
  }
}
