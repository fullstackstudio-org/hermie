import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import HermieTranscript

// Opening a chat, keeping it live, and bringing it back after a reconnect:
// `hydrate`, `paintFromCache`, `loadHistory`, `replaySince`, `onEvent`,
// `recoverAfterReconnect`, the `sessions.changed` sweep, `loadOlder` and
// `reconcileTailFor` of `chat-controller.ts`, in its order.
//
// The hydration ladder is the reference's: `cold` (created), `cached` (painted
// from disk), `hydrating` (resume in flight), `live`, and `stale` (the runtime
// session was reclaimed, the socket left `ready`, or a recovery failed);
// `error` when the resume itself failed. A recovery that succeeds goes back to
// `live`.

extension TranscriptStore {
  // MARK: - Opening

  /// `openChat`: open a bot's canonical chat and leave it live.
  ///
  /// Every opened chat stays live: leaving the screen does not detach, because
  /// a teammate bot writing into a chat nobody is looking at is exactly the
  /// traffic this app exists to show. Never two hydrations of one chat at once.
  public func open(_ bot: Bot) async throws {
    if let existing = opening[bot.name] {
      return try await existing.value
    }

    let task = Task { try await self.hydrate(bot) }
    opening[bot.name] = task

    defer {
      opening[bot.name] = nil
    }

    try await task.value
  }

  /// `hydrate`: cache, resume, history, the in-flight tail, the replay.
  func hydrate(_ bot: Bot) async throws {
    let canonical = try await roster.resolveCanonical(bot)
    let key = bot.name

    ensure(key, stored: canonical.id, resolved: canonical.resolvedID)

    // 1. The cache paints first, so the thread is on screen before the socket
    //    has answered. The reconcile below keeps the item ids it painted.
    await paintFromCache(key, canonical)
    setHydration(key, .hydrating)

    let resume: ResumeOutcome

    do {
      resume = try await ordered(key, binding: true, resumeCall(key, storedID: canonical.id)) { reply in
        try self.applyResume(key, reply, canonical)
      }
    } catch let error as GatewayError where error.kind == .incompatible {
      throw error
    } catch {
      setHydration(key, .error)
      throw error
    }

    // 3. History. Either transport projects onto the same items, which is what
    //    lets the reconcile keep every id it already handed out.
    let messageCount = resume.result.messageCount ?? canonical.messageCount
    let snapshot = resumeSnapshot(of: resume.result)
    let openRequests = resume.result.json["open_requests"]?.arrayValue

    if messageCount > ChatRuntimeLimits.restHistoryThreshold,
      let rows = await link.fetchMessages(resume.resolvedID, MessageWindow(limit: ChatRuntimeLimits.restHistoryLimit))
    {
      try await local(key) {
        self.applyHistory(key, rows, .rest, snapshot: snapshot, openRequests: openRequests)
      }
    } else {
      let params: JSONValue = ["session_id": .string(resume.runtimeID), "profile": .string(key)]

      try await ordered(key, { [link] in try await link.requestReply(RPC.SessionHistory.name, params: params) }) {
        reply in
        let rows = (reply.result["messages"]?.arrayValue ?? []).map { TranscriptRow(json: $0.objectValue ?? [:]) }
        self.applyHistory(key, rows, .rpc, snapshot: snapshot, openRequests: openRequests)
      }
    }

    // 5. Anything that happened between the history read and now.
    await replaySince(key, runtimeID: resume.runtimeID)

    setHydration(key, .live)
    persistSoon(key)
    syncApprovalPoll()

    // A chat opened mid-delegation never saw its children start.
    await reconcileSubagents(key)
    syncSubagentPoll()
  }

  struct ResumeOutcome: Sendable {
    var runtimeID: String
    var resolvedID: String
    var result: SessionResumeResult
  }

  func resumeCall(_ key: String, storedID: String) -> @Sendable () async throws -> RPCReply<JSONValue> {
    let params: JSONValue = [
      "session_id": .string(storedID),
      "profile": .string(key),
      "omit_messages": true,
      "source": "hermie",
      "cols": .number(Double(ChatRuntimeLimits.resumeColumns))
    ]

    return { [link] in try await link.requestReply(RPC.SessionResume.name, params: params) }
  }

  /// Step 2 of `hydrate`, at the resume's place in the chat's frames: refuse a
  /// gateway too old to send the events this transcript is made of, bind the
  /// runtime id, and fold in the resume's own `session.info`.
  func applyResume(_ key: String, _ reply: RPCReply<JSONValue>, _ canonical: CanonicalSession) throws -> ResumeOutcome {
    let result = SessionResumeResult(json: reply.result.objectValue ?? [:])
    let info = reply.result["info"]

    rememberContract(contractIn(info))
    _ = try DesktopContract.check(desktopContractInfo(info), known: knownContract)

    let runtimeID = result.sessionID ?? ""

    guard !runtimeID.isEmpty else {
      // Every event and every server request is addressed by this id. Binding an
      // empty one routes the whole session to nobody.
      setHydration(key, .error)
      throw ChatRuntimeError(message: "The gateway resumed \(key)'s chat without a session id.")
    }

    let stored = result.storedSessionID ?? ""
    let resolvedID = stored.isEmpty ? canonical.resolvedID : stored

    ensure(key, stored: canonical.id, resolved: resolvedID)
    bindRuntime(key, runtimeID, at: reply.index)
    chats[key]?.live = true

    if let info, case .object = info {
      let event = GatewayEvent(json: ["type": "session.info", "session_id": .string(runtimeID), "payload": info])
      let now = now()
      mutateState(key) { applyEvent(into: &$0, event, now) }
    }

    return ResumeOutcome(runtimeID: runtimeID, resolvedID: resolvedID, result: result)
  }

  /// Steps 3 and 4: the history rows, then the in-flight tail they do not contain yet.
  func applyHistory(
    _ key: String,
    _ rows: [TranscriptRow],
    _ shape: RowShape,
    snapshot: SessionResumeResult,
    openRequests: [JSONValue]?
  ) {
    if !rows.isEmpty {
      let items = rowsToItems(rows, shape)
      mutateState(key) { $0 = reconcile($0, items) }
    }

    // The RPC transport reaches the start by definition: `session.history` is unpaginated.
    chats[key]?.window = HistoryWindow(
      rows: rows.count,
      reachedStart: shape == .rpc || rows.count < ChatRuntimeLimits.restHistoryLimit
    )

    let now = now()
    mutateState(key) { applyResumeSnapshot(into: &$0, snapshot, now) }
    registerOpenRequests(key, openRequests)
  }

  /// `resumeSnapshotOf`: the fields `applyResumeSnapshot` reads, `turn_started_at`
  /// from whichever half of the answer carried it.
  func resumeSnapshot(of result: SessionResumeResult) -> SessionResumeResult {
    let raw = result.json
    let record = { (value: JSONValue?) -> JSONValue in
      if case .object(let object)? = value { .object(object) } else { .null }
    }
    let running: JSONValue = raw["running"].flatMap { $0.isNull ? nil : $0 } ?? .null
    let started = raw["turn_started_at"].flatMap { $0.isNull ? nil : $0 }
      ?? raw["info"]?["turn_started_at"].flatMap { $0.isNull ? nil : $0 } ?? .null

    return SessionResumeResult(json: [
      "inflight": record(raw["inflight"]),
      "running": running,
      "turn_started_at": started,
      "queued": record(raw["queued"]),
      "pending_approval": record(raw["pending_approval"]),
      "todo_state": record(raw["todo_state"]),
      "open_requests": raw["open_requests"].flatMap { $0.isNull ? nil : $0 } ?? .null
    ])
  }

  /// `ensure`: create the chat, or refresh its durable ids.
  func ensure(_ key: String, stored: String, resolved: String) {
    guard let record = chats[key] else {
      chats[key] = ChatRecord(state: createChatState(key, stored, resolved))
      markDirty(key)
      return
    }

    if record.state.storedSessionID != stored || record.state.resolvedSessionID != resolved {
      mutateState(key) { state in
        state.storedSessionID = stored
        state.resolvedSessionID = resolved
      }
    }
  }

  /// `paintFromCache`: a chat with nothing on screen yet gets what was on disk.
  func paintFromCache(_ key: String, _ canonical: CanonicalSession) async {
    guard let cache, chats[key]?.state.order.isEmpty == true else {
      return
    }

    let snapshot: HermieTranscript.CachedTranscript

    do {
      guard let row = try await cache.read(bot: key) else {
        return
      }

      snapshot = try HermieTranscript.CachedTranscript(decoding: JSONValue(parsing: row.itemsJSON))
    } catch {
      // A cache that cannot be read is a cache that is not used.
      return
    }

    let ids = SessionIDs(storedSessionID: canonical.id, resolvedSessionID: canonical.resolvedID)

    _ = try? await local(key) {
      // Re-check after the suspension: the socket may have filled the chat meanwhile.
      guard self.chats[key]?.state.order.isEmpty == true else {
        return
      }

      self.mutateState(key) { $0 = stateFromCache(key, ids, snapshot) }
    }
  }

  /// Paint every cached chat of these bots without attaching: a cold start
  /// shows them before the socket is ready. Each stays `cached` until opened.
  public func restoreFromCache(_ bots: [Bot]) async {
    for bot in bots {
      guard let canonical = bot.canonical, chats[bot.name] == nil else {
        continue
      }

      ensure(bot.name, stored: canonical.id, resolved: canonical.resolvedID)
      await paintFromCache(bot.name, canonical)
    }
  }

  // MARK: - The replay

  /// `replaySince`: fold in the events that landed since the watermark.
  ///
  /// A cold chat (no watermark, or another epoch) adopts `latest_seq` without
  /// applying: the history read already describes it. A warm one applies them.
  /// A failure costs the events of the last few seconds, which the socket
  /// delivers anyway.
  func replaySince(_ key: String, runtimeID: String) async {
    guard let chat = chats[key]?.state else {
      return
    }

    // Read before the call, as the reference reads them.
    let knownEpoch = chat.epoch
    let lastSeq = chat.lastSeq
    let params: JSONValue = ["session_id": .string(runtimeID), "last_seen": .number(Double(lastSeq))]

    _ = try? await ordered(key, { [link] in try await link.requestReply(RPC.SessionEventsSince.name, params: params) }) {
      reply in
      self.applyReplay(key, runtimeID: runtimeID, knownEpoch: knownEpoch, lastSeq: lastSeq, reply.result)
    }
  }

  func applyReplay(_ key: String, runtimeID: String, knownEpoch: String?, lastSeq: Int, _ result: JSONValue) {
    let epoch = result["epoch"]?.stringValue
    let latest = result["latest_seq"]?.doubleValue.flatMap { Int(exactly: $0) } ?? 0
    // The epoch names the process that did the numbering; another one began at 1.
    let epochChanged = knownEpoch != nil && knownEpoch != epoch
    let cold = lastSeq == 0 || epochChanged

    if cold || result["truncated"] == .bool(true) {
      mutateState(key) { state in
        state.lastSeq = epochChanged ? latest : max(state.lastSeq, latest)
        state.lastSeqSessionID = runtimeID
        state.epoch = epoch
      }
    } else {
      for raw in result["events"]?.arrayValue ?? [] {
        guard let event = transcriptEvent(of: raw) else {
          continue
        }

        let now = now()
        mutateState(key) { applyEvent(into: &$0, event, now) }
      }

      if chats[key]?.state.epoch != epoch {
        mutateState(key) { $0.epoch = epoch }
      }
    }

    registerOpenRequests(key, result["open_requests"]?.arrayValue)
  }

  /// `transcriptEventOf`: one replayed frame, narrowed to what the reducer needs.
  func transcriptEvent(of raw: JSONValue) -> GatewayEvent? {
    guard let type = raw["type"]?.stringValue else {
      return nil
    }

    var json: JSONObject = ["type": .string(type)]

    if let sessionID = raw["session_id"]?.stringValue {
      json["session_id"] = .string(sessionID)
    }

    if case .number(let seq)? = raw["seq"] {
      json["seq"] = .number(seq)
    }

    if let payload = raw["payload"] {
      json["payload"] = payload
    }

    return GatewayEvent(json: json)
  }

  /// `registerOpenRequests`: cards for requests the agent is still waiting on.
  /// They have no live handle here; answering one goes out as a call.
  func registerOpenRequests(_ key: String, _ entries: [JSONValue]?) {
    for entry in entries ?? [] {
      guard let id = entry["id"]?.stringValue, let method = entry["method"]?.stringValue else {
        continue
      }

      let request = ServerRequest(json: [
        "id": .string(id),
        "method": .string(method),
        "params": .object(entry["params"]?.objectValue ?? [:]),
        "replayed": true
      ])
      let now = now()
      mutateState(key) { applyServerRequest(into: &$0, request, now) }
    }
  }

  // MARK: - Live frames

  /// `onEvent`, for a frame at its place in the chat's lane.
  func applyLive(_ event: GatewayEvent, in key: String) {
    // Routed when it is applied, not when it came in: a resume in between may
    // have moved the chat to another runtime session.
    guard let sessionID = event.sessionID, routes[sessionID] == key, chats[key] != nil else {
      return
    }

    let type = event.type

    if type == GatewayEventType.sessionInfo {
      rememberContract(contractIn(event.payload))
    }

    if type == GatewayEventType.sessionReclaimed {
      // Another client took the session over. The transcript is still true; the
      // attachment is not. Keep the items, drop the id, re-resume on next open.
      let now = now()
      mutateState(key) { applyEvent(into: &$0, event, now) }
      dropRuntime(key)
      setHydration(key, .stale)
      return
    }

    let now = now()
    mutateState(key) { applyEvent(into: &$0, event, now) }

    if type == GatewayEventType.requestCancel || type == GatewayEventType.messageComplete
      || type == GatewayEventType.error
    {
      pruneRequests(key)
    }

    if type == GatewayEventType.messageStart || type == GatewayEventType.messageComplete {
      syncApprovalPoll()
      syncSubagentPoll()
    }

    if type.hasPrefix("subagent.") {
      syncSubagentPoll()
    }

    if type == GatewayEventType.messageComplete {
      if chats[key]?.state.turn.foreignReconcilePending == true {
        spawn { await $0.reconcileTail(key) }
      }

      persistSoon(key)
      spawn { await $0.drainQueue(key) }
    }
  }

  /// `deliverServerRequest`: put one request on screen and file its reply handle
  /// under the card that shows it (a replayed snapshot and the live request are
  /// one question under two transport ids).
  func deliver(_ inbound: InboundRequest, to key: String) {
    guard chats[key] != nil else {
      return
    }

    // Routed when it is applied: a request for a session this chat has since
    // left waits for whoever binds that session, as one that came in unbound does.
    let sessionID = inbound.params["session_id"]?.stringValue ?? ""

    guard routes[sessionID] == key else {
      if !sessionID.isEmpty {
        park(sessionID, inbound)
      }

      return
    }

    var json: JSONObject = [
      "id": .string(inbound.id),
      "method": .string(inbound.method),
      "params": .object(inbound.params)
    ]

    if inbound.replayed {
      json["replayed"] = true
    }

    let request = ServerRequest(json: json)
    let now = now()
    mutateState(key) { applyServerRequest(into: &$0, request, now) }

    guard let state = chats[key]?.state else {
      return
    }

    let cardID =
      state.byRequestID[inbound.id] != nil
      ? inbound.id : approvalCardID(state, inbound.params["request_id"]?.stringValue ?? "")

    if let cardID {
      deliveries[cardID] = Delivery(key: key, inbound: inbound)

      if inbound.method == "approval" {
        spawn { await $0.acknowledgeApproval(key, cardID) }
      }
    }

    syncApprovalPoll()
  }

  /// `approvalCardIdFor`: the open approval card already showing this queue entry.
  func approvalCardID(_ state: ChatState, _ approvalID: String) -> String? {
    guard !approvalID.isEmpty, let itemID = state.byApprovalID[approvalID],
      case .approval(let item)? = state.items[itemID], item.state == .open
    else {
      return nil
    }

    return item.requestID
  }

  /// `pruneRequests`: forget the handles behind cards that are no longer open.
  func pruneRequests(_ key: String) {
    guard let state = chats[key]?.state else {
      return
    }

    let stillOpen = { (requestID: String) -> Bool in
      guard let itemID = state.byRequestID[requestID] else {
        return false
      }

      switch state.items[itemID] {
      case .approval(let item)?: return item.state == .open
      case .clarify(let item)?: return item.state == .open
      default: return false
      }
    }

    for (requestID, delivery) in deliveries where delivery.key == key && !stillOpen(requestID) {
      deliveries[requestID] = nil
    }

    for requestID in acknowledged where state.byRequestID[requestID] != nil && !stillOpen(requestID) {
      acknowledged.remove(requestID)
    }
  }

  // MARK: - Connection status

  /// `onStatus`. The first `ready` of the session is not a reconnect; every
  /// later one is, and the live chats are re-resumed.
  public func connectionChanged(_ status: ConnectionStatus) {
    guard status.phase == .ready else {
      switch status.phase {
      case .disconnected, .reconnecting, .paused, .offline:
        stopApprovalPoll()
        stopSubagentPoll()

        // No frames reach a chat without a socket: it is not live until the
        // recovery after the next `ready` says so.
        for key in liveKeys where chats[key]?.state.hydration == .live {
          setHydration(key, .stale)
        }
      default:
        break
      }

      return
    }

    if !sawReady {
      sawReady = true
      return
    }

    spawn { await $0.recoverAfterReconnect() }
  }

  /// `recoverAfterReconnect`: re-resume every live chat (the runtime session may
  /// have been rebuilt), replay what was missed, and re-read the tail where the
  /// roster counts more rows than the chat holds.
  func recoverAfterReconnect() async {
    let keys = liveKeys

    guard !keys.isEmpty else {
      return
    }

    let bots = (try? await roster.refresh()) ?? []
    let byName = Dictionary(bots.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })

    await withTaskGroup(of: Void.self) { group in
      for key in keys {
        let expected = byName[key]?.canonical?.messageCount ?? 0
        group.addTask { await self.recover(key, expected: expected) }
      }
    }

    syncApprovalPoll()
  }

  func recover(_ key: String, expected: Int) async {
    guard let stored = chats[key]?.state.storedSessionID else {
      return
    }

    do {
      let runtimeID = try await ordered(key, binding: true, resumeCall(key, storedID: stored)) { reply in
        let result = SessionResumeResult(json: reply.result.objectValue ?? [:])

        guard let runtimeID = result.sessionID, !runtimeID.isEmpty else {
          throw ChatRuntimeError(message: "The gateway resumed \(key)'s chat without a session id.")
        }

        self.bindRuntime(key, runtimeID, at: reply.index)

        let now = self.now()
        let snapshot = self.resumeSnapshot(of: result)
        self.mutateState(key) { applyResumeSnapshot(into: &$0, snapshot, now) }
        self.registerOpenRequests(key, reply.result["open_requests"]?.arrayValue)
        return runtimeID
      }

      await replaySince(key, runtimeID: runtimeID)

      if let state = chats[key]?.state, expected > countPersistedRows(state) {
        await reconcileTail(key)
      }

      setHydration(key, .live)
    } catch {
      setHydration(key, .stale)
    }
  }

  var liveKeys: [String] {
    chats.filter { $0.value.live }.map(\.key).sorted()
  }

  // MARK: - The sweep

  func scheduleSessionsChanged() {
    sessionsChangedTimer?.cancel()
    sessionsChangedTimer = options.clock.schedule(after: options.sessionsChangedDebounce) { [weak self] in
      await self?.sessionsChangedElapsed()
    }
  }

  func sessionsChangedElapsed() async {
    sessionsChangedTimer = nil
    await sweep()
  }

  /// One `sessions.changed` sweep: refresh the roster, and tail-reconcile every
  /// live chat that is not mid-turn — or is, but holds a foreign placeholder
  /// waiting to be told who spoke (`reconcileTail` never drops a live item).
  func sweep() async {
    let keys = liveKeys.filter { key in
      guard let turn = chats[key]?.state.turn else {
        return false
      }

      return !turn.active || turn.foreignReconcilePending == true
    }

    await withTaskGroup(of: Void.self) { group in
      group.addTask { _ = try? await self.roster.refresh() }

      for key in keys {
        group.addTask { await self.reconcileTail(key) }
      }
    }
  }

  // MARK: - History paging and the tail

  /// `loadOlder`: one page further back, placed at the front with `prependHistory`.
  public func loadOlder(_ key: String) async -> OlderHistory {
    guard let record = chats[key], !record.state.resolvedSessionID.isEmpty else {
      return .unavailable
    }

    if record.window?.reachedStart == true {
      return .start
    }

    if record.loadingOlder {
      // Two pages fetched at the same offset are the same page twice.
      return .grew
    }

    chats[key]?.loadingOlder = true

    defer {
      chats[key]?.loadingOlder = false
    }

    let held = record.window?.rows ?? 0
    let offset = record.window?.rows ?? record.state.order.count
    let window = MessageWindow(limit: ChatRuntimeLimits.restHistoryLimit, offset: offset)

    guard let rows = await link.fetchMessages(record.state.resolvedSessionID, window) else {
      chats[key]?.window = HistoryWindow(rows: held, reachedStart: true)
      markDirty(key)
      return .unavailable
    }

    // A short page is the start: the route has no `has_more` and no total.
    chats[key]?.window = HistoryWindow(
      rows: held + rows.count,
      reachedStart: rows.count < ChatRuntimeLimits.restHistoryLimit
    )
    markDirty(key)

    if rows.isEmpty {
      return .start
    }

    let items = rowsToItems(rows, .rest)
    let grew =
      (try? await local(key) { () -> Bool in
        let before = self.chats[key]?.state.order.count ?? 0
        self.mutateState(key) { $0 = prependHistory($0, items) }
        return (self.chats[key]?.state.order.count ?? 0) > before
      }) ?? false

    // A page that was entirely rows already held is not growth.
    return grew ? .grew : (rows.count < ChatRuntimeLimits.restHistoryLimit ? .start : .grew)
  }

  /// `reconcileTailFor`: fetch the newest rows and fold them in, which fills a
  /// foreign placeholder and joins DM replies.
  public func reconcileTail(_ key: String) async {
    guard let state = chats[key]?.state else {
      return
    }

    let window = MessageWindow(limit: ChatRuntimeLimits.tailRowLimit)

    if let rows = await link.fetchMessages(state.resolvedSessionID, window) {
      guard !rows.isEmpty else {
        return
      }

      let items = rowsToItems(rows, .rest)
      _ = try? await local(key) { self.mutateState(key) { $0 = HermieTranscript.reconcileTail($0, items) } }
      return
    }

    guard let runtimeID = state.runtimeSessionID, !runtimeID.isEmpty else {
      return
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]

    _ = try? await ordered(key, { [link] in try await link.requestReply(RPC.SessionHistory.name, params: params) }) {
      reply in
      let rows = (reply.result["messages"]?.arrayValue ?? []).suffix(ChatRuntimeLimits.tailRowLimit)
        .map { TranscriptRow(json: $0.objectValue ?? [:]) }

      guard !rows.isEmpty else {
        return
      }

      let items = rowsToItems(Array(rows), .rest)
      self.mutateState(key) { $0 = HermieTranscript.reconcileTail($0, items) }
    }
  }

  // MARK: - Subagents

  /// `reconcileSubagents`: `subagent.*` has no replay, so a chat opened halfway
  /// through a delegation learns its children from the roster.
  func reconcileSubagents(_ key: String) async {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]

    _ = try? await ordered(key, { [link] in try await link.requestReply(RPC.SubagentList.name, params: params) }) {
      reply in
      let rows = (reply.result["subagents"]?.arrayValue ?? []).compactMap { value -> SubagentSnapshotRow? in
        value.objectValue.map(SubagentSnapshotRow.init(json:))
      }

      guard !rows.isEmpty else {
        return
      }

      let now = self.now()
      self.mutateState(key) { applySubagentSnapshot(into: &$0, rows, now) }
    }
  }

  /// `syncSubagentPoll`: poll while anything is delegating, and only in front.
  func syncSubagentPoll() {
    let busy = liveKeys.contains { key in
      guard let state = chats[key]?.state else {
        return false
      }

      return state.turn.active || state.subagents.values.contains { $0.status == .running || $0.status == .queued }
    }

    guard busy, foregrounded, !isShutDown else {
      stopSubagentPoll()
      return
    }

    if subagentPollTimer == nil {
      scheduleSubagentPoll()
    }
  }

  func scheduleSubagentPoll() {
    subagentPollTimer = options.clock.schedule(after: options.subagentPoll) { [weak self] in
      await self?.subagentPollFired()
    }
  }

  func subagentPollFired() async {
    guard subagentPollTimer != nil else {
      return
    }

    scheduleSubagentPoll()

    for key in liveKeys {
      spawn { await $0.reconcileSubagents(key) }
    }
  }

  func stopSubagentPoll() {
    subagentPollTimer?.cancel()
    subagentPollTimer = nil
  }

  // MARK: - Approvals while a turn runs

  /// `syncApprovalPoll`: the safety net for a request written while the app was
  /// detached; only while a turn runs and the app is in front.
  func syncApprovalPoll() {
    let busy = chats.values.contains { $0.state.turn.active }

    guard busy, foregrounded, !isShutDown else {
      stopApprovalPoll()
      return
    }

    if approvalPollTimer == nil {
      scheduleApprovalPoll()
    }
  }

  func scheduleApprovalPoll() {
    approvalPollTimer = options.clock.schedule(after: options.approvalPoll) { [weak self] in
      await self?.approvalPollFired()
    }
  }

  func approvalPollFired() async {
    guard approvalPollTimer != nil else {
      return
    }

    scheduleApprovalPoll()

    for key in liveKeys {
      spawn { await $0.refreshPendingApprovals(key) }
    }
  }

  func stopApprovalPoll() {
    approvalPollTimer?.cancel()
    approvalPollTimer = nil
  }

  /// `refreshPendingApprovals`: `pending:` cards with no live reply behind them,
  /// folded by the reducer onto a card already showing the same queue entry.
  func refreshPendingApprovals(_ key: String) async {
    guard let runtimeID = chats[key]?.state.runtimeSessionID, !runtimeID.isEmpty else {
      return
    }

    let params: JSONValue = ["session_id": .string(runtimeID), "profile": .string(key)]

    _ = try? await ordered(key, { [link] in try await link.requestReply(RPC.ApprovalPending.name, params: params) }) {
      reply in
      for approval in reply.result["approvals"]?.arrayValue ?? [] {
        let approvalID = approval["request_id"]?.stringValue ?? ""
        let request = ServerRequest(json: [
          "id": .string("pending:\(approvalID.isEmpty ? "approval" : approvalID)"),
          "method": "approval",
          "params": .object(approval.objectValue ?? [:]),
          "replayed": true
        ])
        let now = self.now()
        self.mutateState(key) { applyServerRequest(into: &$0, request, now) }
      }
    }
  }

  // MARK: - Foreground and background

  /// `onForeground`: the polls come back and every live chat re-reads what the
  /// agent is still waiting on.
  public func enterForeground() async {
    foregrounded = true
    syncApprovalPoll()
    syncSubagentPoll()

    await withTaskGroup(of: Void.self) { group in
      for key in liveKeys {
        group.addTask { await self.refreshPendingApprovals(key) }
      }
    }
  }

  /// `onBackground`: stop polling, and write every live chat to the cache now.
  public func enterBackground() async {
    foregrounded = false
    stopApprovalPoll()
    stopSubagentPoll()
    await persistAll()
  }

  // MARK: - The cache

  /// Mark a chat for the next debounced cache write.
  func persistSoon(_ key: String) {
    guard cache != nil, !isShutDown else {
      return
    }

    cacheDirty.insert(key)

    if cacheTimer == nil {
      cacheTimer = options.clock.schedule(after: options.cacheDebounce) { [weak self] in
        await self?.cacheTimerFired()
      }
    }
  }

  func cacheTimerFired() async {
    guard cacheTimer != nil else {
      return
    }

    cacheTimer = nil
    await writePendingCache()
  }

  func writePendingCache() async {
    let keys = cacheDirty.sorted()
    cacheDirty.removeAll()

    for key in keys {
      await persist(key)
    }
  }

  /// Every live chat, and whatever was waiting for the debounce, written now.
  public func persistAll() async {
    cacheTimer?.cancel()
    cacheTimer = nil
    cacheDirty.formUnion(liveKeys)
    await writePendingCache()
  }

  /// `persist`: one chat's snapshot, the last `cacheItemLimit` settled items.
  func persist(_ key: String) async {
    guard let cache, let state = chats[key]?.state, state.hydration != .cold else {
      return
    }

    let snapshot = snapshotForCache(state, now: now())

    guard let text = try? snapshot.jsonValue.canonicalString() else {
      return
    }

    let row = HermieStore.CachedTranscript(
      bot: key,
      itemsJSON: text,
      lastRowId: snapshot.lastRowID.map(Int64.init),
      lastSeq: Int64(snapshot.lastSeq),
      epoch: snapshot.epoch,
      updatedAt: Int64(snapshot.updatedAt)
    )

    // A cache write that fails costs the next cold start a spinner.
    try? await cache.write(row)
  }

  // MARK: - Contract

  func rememberContract(_ contract: Double?) {
    if let contract, !contract.isNaN {
      knownContract = contract
    }
  }

  /// `contractIn`: the number a `session.info` payload carries, if any.
  func contractIn(_ info: JSONValue?) -> Double? {
    switch info?["desktop_contract"] {
    case .number(let value)?: value.isNaN ? nil : value
    case .string(let text)?: parseLeadingInteger(text)
    default: nil
    }
  }

  func desktopContractInfo(_ info: JSONValue?) -> DesktopContract.Info? {
    guard let info, case .object(let object) = info else {
      return nil
    }

    let value: DesktopContract.Value? =
      switch object["desktop_contract"] {
      case nil: nil
      case .number(let number)?: .number(number)
      case .string(let text)?: .string(text)
      default: .other
      }

    return DesktopContract.Info(desktopContract: value, lazy: object["lazy"] == .bool(true))
  }

  // MARK: - Forgetting

  /// Drop a chat: its transcript, its routes, its queue. The bot left the roster
  /// or its canonical chat was replaced.
  public func forget(_ key: String) {
    guard chats.removeValue(forKey: key) != nil else {
      return
    }

    generations[key, default: 0] += 1

    for (id, owner) in routes where owner == key {
      routes[id] = nil
      parked[id] = nil
    }

    for item in lanes.removeValue(forKey: key)?.pending ?? [] {
      if case .step(let step) = item.payload {
        step.abandon()
      }
    }

    for (requestID, delivery) in deliveries where delivery.key == key {
      deliveries[requestID] = nil
    }

    observed[key] = nil
    cacheDirty.remove(key)
    dirty.remove(key)
    removedSinceFrame.insert(key)
    requestFrame()
  }
}

/// A runtime failure in the reference's words.
public struct ChatRuntimeError: Error, Sendable, Equatable, CustomStringConvertible {
  public var message: String

  public init(message: String) {
    self.message = message
  }

  public var description: String { message }
}

/// `countPersistedRows`: how many persisted rows a chat holds.
func countPersistedRows(_ state: ChatState) -> Int {
  state.order.reduce(0) { count, id in state.items[id]?.rowID != nil ? count + 1 : count }
}

/// `countMessages`: persisted rows plus the user and assistant items streamed in live.
func countMessages(_ state: ChatState) -> Int {
  var live = 0

  for id in state.order {
    guard let item = state.items[id], item.rowID == nil else {
      continue
    }

    if case .user = item {
      live += 1
    } else if case .assistant = item {
      live += 1
    }
  }

  return countPersistedRows(state) + live
}

/// `Number.parseInt(text, 10)` for a contract number: leading whitespace, a sign,
/// then digits; `nil` when there are none.
func parseLeadingInteger(_ text: String) -> Double? {
  var scalars = Substring(text).unicodeScalars.drop { CharacterSet.whitespacesAndNewlines.contains($0) }
  var sign = 1.0

  if let first = scalars.first, first == "-" || first == "+" {
    sign = first == "-" ? -1 : 1
    scalars = scalars.dropFirst()
  }

  let digits = scalars.prefix { ("0"..."9").contains($0) }

  guard !digits.isEmpty, let value = Double(String(String.UnicodeScalarView(digits))) else {
    return nil
  }

  return sign * value
}
