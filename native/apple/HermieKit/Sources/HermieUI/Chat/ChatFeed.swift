import Foundation
import HermieCore
import HermieGateway
import HermieMarkdown
import HermieTranscript
import Observation
import SwiftUI

/**
 What one chat screen runs on: the chat's model from the session, its rows, and the rules for
 opening, paging and marking read.

 # Per frame

 The session replaces `ChatModel.snapshot` at most once a frame. This feed watches its `revision`,
 hands the snapshot's items to a `ChatRowPipeline` off the main actor, and assigns the rows that
 come back as one `TranscriptListItems` (compared by identity). A frame that arrives while rows are
 being built is folded into the next build. Nothing else runs on the main actor per delta: the
 header's values are set only when they change.

 # Opening

 `GatewaySession.open` runs a full hydration, so it is called only when the chat needs one: when
 the store does not hold it live (cold, from the cache, or failed) and the socket is ready. A chat
 that is `stale` is recovering on its own and is left alone. A failed open is tried again once per
 return of the connection, and by the reader's "Try again".

 # Sending

 The reader's own send takes the transcript to the bottom and keeps it following the new bubble
 and the reply (`TranscriptListState.followOwnSend`), from wherever they had scrolled. A message
 that arrives from elsewhere does not move a reader who scrolled up: the jump pill counts it.

 # Find

 A chat opened from a message search hit is asked to show the row the words are in
 (`find(_:settle:)`): a `ChatFindWalk` looks at the chat's items after every rebuild of the rows,
 scrolls the list to the row that holds the newest match and marks it for a moment, and pages back
 through older history when the words are not in what is loaded. When they are not in the chat's
 visible text at all, a notice says so.

 # Read marks

 The chat is marked read while its newest row is on screen, the window is in front and nothing
 covers the screen (a page pushed on the chat, a sheet), whenever the newest row changes, a moment
 after it settles; when the cover goes, if the reader is at the bottom; and once more when the
 screen goes away.
 */
@MainActor
@Observable
final class ChatFeed: ChatScreenFeed {
  let chat: ChatRef
  let session: GatewaySession
  let model: ChatModel
  /// The chat's composer, the approval and clarify answers, and the secure prompts: one each per
  /// open chat screen, over the same `ChatModel`.
  let composer: ComposerModel
  let requests: RequestsModel
  let secureInput: SecureInputModel
  /// The forms, file requests and draft reviews of this chat (`input.form`, `input.file`,
  /// `review.draft`).
  let interactive: InteractiveModel
  /// Which of those sheets has the screen: approvals and secure prompts first.
  let sheets: ChatSheetOrder
  /// Reading replies aloud, once the screen has given the feed the device's voice settings
  /// (`attachVoice`, in `ChatFeed+Voice.swift`). Nil in a preview or a test that has none: the chat
  /// then has no Read aloud, and its composer no microphone.
  var readAloud: ReadAloudModel?
  /// The device's voice settings the chat's options read and write (the automatic read, per chat).
  var voiceSettings: VoiceSettings?
  /// The voice mode call on this chat, while there is one (`ChatFeed+Voice.swift`): its screen is up
  /// for as long as this is set.
  var voiceMode: VoiceModeModel?
  /// The voice setup screen is up, before a first call or from the call's settings glyph.
  var showingVoiceSetup = false
  /// The setup was opened by the Voice mode button: the call starts when it is done.
  @ObservationIgnored var pendingCallAfterSetup = false
  /// Where a call gets its engines; the tests give their own.
  @ObservationIgnored var voiceEngines = VoiceEngines.live
  /// What this chat's gateway offers to speak with (its text-to-speech, as this bot sees it); nil for a
  /// connection with no REST side. Read once the voice is attached.
  @ObservationIgnored var gatewaySpeech: GatewaySpeechAccess?

  private(set) var rows = TranscriptListItems<TranscriptRow>()
  /// The first rows have arrived.
  private(set) var loaded = false
  /// User and assistant rows that arrived while the reader was scrolled up.
  private(set) var newCount = 0
  private(set) var hydration = HydrationState.cold
  private(set) var activity = TurnActivity.idle
  private(set) var canLoadOlder = false
  private(set) var loadingOlder = false
  /// What the chat says about the last search it was opened from, when the words were not found; it goes
  /// by itself (`ChatFindNotice`).
  private(set) var findNotice: String?
  /// Why the last open failed, for the banner over the transcript.
  private(set) var openError: String?
  /// What kind of failure that was, without its words (`ChatResolver.category`), for diagnostics.
  @ObservationIgnored private(set) var openErrorKind: String?

  @ObservationIgnored let listState = TranscriptListState()
  @ObservationIgnored let expansion = TranscriptExpansion()
  /// The rows' actions other than the answers (which `requests` adds), built once: rows compare on
  /// their item alone, so the actions must not change while open.
  @ObservationIgnored private(set) var itemActions = TranscriptItemActions.none
  /// The attachment Quick Look shows, while it does.
  var attachmentPreview: URL?
  /// The message whose words the select-text sheet shows, while it does (HERM-254).
  var selectTextRequest: SelectTextRequest?
  /// The message menu offers Select text: where a bubble's words cannot be selected in place, which
  /// is a touch screen (a long press there is the menu). Settable for the tests.
  var offersSelectText = !ChatFeed.selectsInPlace
  /// Why the last attachment could not be opened, for a line over the chat.
  private(set) var attachmentNotice: AttachmentOpenResult?
  /// What the last Retry did, for the tests and a line over the chat when it sent nothing.
  private(set) var lastRetry: RetryOutcome?
  /// Why the last Branch from here did not go through, for a line over the chat.
  private(set) var branchFailure: String?
  /// Where the conversation Branch from here made is opened. The screen sets it (it owns the router);
  /// with none the branch is made and nothing opens.
  @ObservationIgnored var openConversation: (@MainActor (Conversation) -> Void)?
  /// This chat's session skips approval requests (`ChatModel.yolo`), set only when it changes: the
  /// title's capsule and the options menu's switch read it, and nothing else on the screen does.
  private(set) var yolo = false
  /// The alert that asks before YOLO mode goes on is up.
  var confirmingYolo = false
  /// Why the last switch of YOLO mode did not go through, for a line over the chat.
  private(set) var yoloFailure: String?
  /// Fast mode, reasoning effort, model and context usage (`ChatModel.options`), set only when they
  /// change: the options menu and the toolbar's ring read them, and nothing else on the screen does.
  /// The methods are in `ChatFeed+Options.swift`.
  var sessionOptions = ChatSessionOptions()
  /// The chat is bound to a runtime session, so the options menu offers what needs one.
  var optionsAvailable = false
  /// The model list is up.
  var showingModelPicker = false
  /// The gateway's models, read when the list is first opened.
  var modelList = ModelListState.idle
  /// A model the gateway calls expensive, waiting for the reader's yes (the alert is up while set).
  var pendingModel: PendingModelSwitch?
  /// Why the last option switch or export did not go through, or what the gateway warned about.
  var optionNotice: ChatOptionNotice?
  /// The file the exporter is saving, while it is up.
  var exportFile: TranscriptFile?
  var exporting = false
  /// `session.usage` was asked for on this attach (once, for a chat resumed with no usage).
  @ObservationIgnored var usageAsked = false

  @ObservationIgnored private let pipeline = ChatRowPipeline()
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var building = false
  @ObservationIgnored private var rebuild = false
  @ObservationIgnored private var opening = false
  /// Bumped each time the connection becomes ready; a failed open is retried once per epoch.
  @ObservationIgnored private var readyEpoch = 0
  @ObservationIgnored private var failedEpoch = -1
  @ObservationIgnored private var historyExhausted = false
  /// The rows as the pipeline built them; `rows` is these with the found row marked, while one is.
  @ObservationIgnored private var builtRows = TranscriptListItems<TranscriptRow>()
  /// Moves with every rebuild of the rows: what a find that was waiting on a page looks at.
  @ObservationIgnored private var rowsRevision = 0
  @ObservationIgnored private var findWalk: ChatFindWalk?
  @ObservationIgnored private var findRequestID: Int?
  /// Tells whoever asked that the request is dealt with.
  @ObservationIgnored private var findSettle: (@MainActor (Int) -> Void)?
  /// The item whose row is marked, and the timers that take the mark and the notice away.
  @ObservationIgnored private var flashID: String?
  @ObservationIgnored private var flashTask: Task<Void, Never>?
  @ObservationIgnored private var findRetryTask: Task<Void, Never>?
  @ObservationIgnored private var findRetries = 0
  @ObservationIgnored private var noticeTask: Task<Void, Never>?
  /// The typing row's debounce, and what it was last told: see `TypingIndicatorGate`.
  @ObservationIgnored private var typingGate = TypingIndicatorGate()
  @ObservationIgnored private var typingWanted = false
  @ObservationIgnored private var typingTask: Task<Void, Never>?
  /// Seconds on a clock that does not jump, for the typing row's debounce; the tests set their own.
  @ObservationIgnored var uptime: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  @ObservationIgnored private var sceneActive = true
  /// Something stands over the screen (a page pushed on the chat, a sheet): the feed keeps running
  /// under it, but marks nothing read until it goes (`coverChanged`).
  @ObservationIgnored private(set) var covered = false
  /// Read marks sent, for the tests and the diagnostics.
  @ObservationIgnored private(set) var readMarks = 0
  /// How long the newest row must stay on screen before it is marked read.
  @ObservationIgnored var readMarkDelay: Duration = .milliseconds(600)
  @ObservationIgnored private var markTask: Task<Void, Never>?
  /// The newest row (id and version) last marked read.
  @ObservationIgnored private var markedKey: String?
  @ObservationIgnored private(set) var stopped = false
  /// This feed's own hold on the chat's model, given back when it stops (and only this one).
  @ObservationIgnored let lease: ChatLease
  /// A number for this feed in the diagnostics and the lifecycle log.
  @ObservationIgnored let tag: Int
  private static var tags = 0

  /// - Parameter standardActions: give the rows the chat's own Retry (send the failed reply's prompt
  ///   again) and attachment opening (Quick Look), over what `actions` built. The shipped app's chat
  ///   screen does; a caller with actions of its own does not.
  init(
    chat: ChatRef,
    session: GatewaySession,
    standardActions: Bool = false,
    actions: @MainActor (ChatModel) -> TranscriptItemActions
  ) {
    Self.tags += 1
    self.tag = Self.tags
    self.chat = chat
    self.session = session
    (self.model, self.lease) = ChatLeases.acquire(session, chat.bot)
    self.composer = ComposerModel(session: session, bot: chat.bot)
    let requests = RequestsModel(session: session, bot: chat.bot)
    let secureInput = SecureInputModel(session: session, bot: chat.bot)
    let interactive = InteractiveModel(session: session, bot: chat.bot)
    self.requests = requests
    self.secureInput = secureInput
    self.interactive = interactive
    self.sheets = ChatSheetOrder(requests: requests, secureInput: secureInput, interactive: interactive)
    var built = actions(model)

    if standardActions {
      built.retry = { [weak self] item in self?.retry(item) }
      built.messageMenu = { [weak self] item in
        self?.messageMenu(for: item) ?? MessageMenu.menu(for: item, context: .readOnly)
      }
      built.chooseMessageAction = { [weak self] action, item in self?.chooseMessageAction(action, item) }
      built.openAttachment = { [weak self] reference in self?.openAttachment(reference) }
      built.images = MessageImageStore { [session, bot = chat.bot] reference in
        if case .preview(let url) = await session.prepareAttachment(reference, profile: bot) { url } else { nil }
      }
    }

    self.itemActions = built
    ChatLifecycleLog.note("feed f\(tag) made for \(chat.bot) (lease \(lease.id))")
  }

  // MARK: Row actions

  /// Retry on a failed reply: its prompt goes out again (`ChatModel.retryTurn`). A turn running, or
  /// no prompt of the reader's to repeat, sends nothing.
  func retry(_ item: AssistantItem) {
    let model = self.model
    let authors = session.retryAuthors

    Task {
      lastRetry = await model.retryTurn(of: item.id, authors: authors)
    }
  }

  // MARK: The message menu

  /// What a message's menu offers now: read when the menu opens, because a row is not redrawn when the
  /// newest reply moves on or a turn starts. Nothing that sends, types or forks while a request has
  /// the composer (HERM-251).
  func messageMenu(for item: TranscriptItem) -> MessageMenu {
    MessageMenu.menu(
      for: item,
      context: model.menuContext(
        authors: session.retryAuthors, blocked: requestUp || composer.held, canEdit: true, canBranch: true,
        canSelectText: offersSelectText, canReadAloud: canReadAloud, reading: readAloud?.readingIDs ?? []))
  }

  /// A line of the menu other than the copies was chosen. The menu is worked out again first: it was
  /// built when it opened, and the chat can have moved on while it was up.
  func chooseMessageAction(_ action: MessageMenu.Action, _ item: TranscriptItem) {
    guard messageMenu(for: item).entry(action)?.enabled == true else {
      return
    }

    switch action {
    case .regenerate:
      regenerate(item.id)
    case .editResend:
      if let words = MessageMenu.editResendDraft(of: item) {
        composer.editAndResend(words)
      }
    case .branch:
      branch(item.id)
    case .readAloud, .stopReading:
      toggleReadAloud(item)
    case .selectText:
      if let words = MessageMenu.selectableText(of: item) {
        selectTextRequest = SelectTextRequest(id: item.id, text: words)
      }
    case .copyText, .copyMarkdown:
      break
    }
  }

  /// A bubble's words are selectable where they are (a pointer: the Mac), so its menu has no line
  /// for it; on a touch screen a long press is the menu, so the words are offered apart.
  static var selectsInPlace: Bool {
    #if os(iOS)
      false
    #else
      true
    #endif
  }

  /// Regenerate on the newest reply: its prompt goes out again, as Retry does on a failed one.
  private func regenerate(_ itemID: String) {
    let model = self.model
    let authors = session.retryAuthors

    Task {
      lastRetry = await model.regenerate(itemID, authors: authors)
    }
  }

  /// Branch from here: the conversation is forked at this message and the new one opens. A refusal is
  /// a line over the chat.
  private func branch(_ itemID: String) {
    let model = self.model

    Task {
      switch await model.branch(from: itemID) {
      case .branched(let conversation):
        branchFailure = nil
        openConversation?(conversation)
      case .failed(let reason):
        branchFailure = reason
      case .nothing:
        break
      }
    }
  }

  /// Open an attachment a message names. A picture (by its extension, or by its first bytes when the
  /// file has none) opens in the gallery, any other file in Quick Look, and when this device cannot have
  /// it a line over the chat says why not (`AttachmentOpening`): a tap is never silent.
  func openAttachment(_ reference: String) {
    let session = self.session
    let store = itemActions.images
    let bot = chat.bot

    Task {
      let result = await session.prepareAttachment(reference, profile: bot)

      guard case .preview(let url) = result else {
        attachmentNotice = result
        return
      }

      attachmentNotice = nil
      if Self.destination(of: url) == .gallery, let store {
        // The file is already here: the gallery uses it instead of asking the gateway again.
        store.prime(reference, url: url)
        store.present([MessageImage(reference: reference, name: url.lastPathComponent)], at: 0)
      } else {
        attachmentPreview = url
      }
    }
  }

  /// Where an opened attachment goes.
  enum Destination: Equatable {
    case gallery
    case quickLook
  }

  /// A picture goes to the gallery, anything else to Quick Look. The extension decides when it names a
  /// picture; a file with none (an image dropped from a screenshot tool) is read: its first bytes say.
  static func destination(of url: URL) -> Destination {
    if MessageImages.isImagePath(url.lastPathComponent) { return .gallery }
    guard let handle = try? FileHandle(forReadingFrom: url) else { return .quickLook }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 32)) ?? Data()
    return sniffImageType([UInt8](head)) == nil ? .quickLook : .gallery
  }

  /// The line about an attachment that could not be opened, or a Retry that sent nothing, goes.
  func dismissActionNotices() {
    attachmentNotice = nil
    lastRetry = nil
    yoloFailure = nil
    branchFailure = nil
    optionNotice = nil
  }

  /// The reader asked for YOLO mode on or off. Turning it on asks first (`confirmingYolo`); turning
  /// it off is always safe, and goes at once.
  func requestYolo(_ enabled: Bool) {
    guard enabled != yolo else {
      return
    }

    if enabled {
      confirmingYolo = true
    } else {
      switchYolo(false)
    }
  }

  /// The alert was confirmed.
  func confirmYolo() {
    confirmingYolo = false
    switchYolo(true)
  }

  private func switchYolo(_ enabled: Bool) {
    let model = self.model

    Task {
      switch await model.setYolo(enabled) {
      case .switched: yoloFailure = nil
      case .failed(let reason): yoloFailure = reason
      }
    }
  }

  var name: String { chat.bot }

  /// A request of this chat has the screen (approval, clarify, confirm, secure prompt, form, file
  /// request or draft review).
  var requestUp: Bool {
    requests.presentedRequestID != nil || secureInput.presentedID != nil || interactive.presentedID != nil
  }

  /// The requests the person put away that are still open, oldest kind first: what the chat says is
  /// waiting. Each opens through its own model.
  var waitingRequests: [WaitingRequest] {
    requests.waiting.map { WaitingRequest(id: $0, kind: .answer) }
      + secureInput.waiting.map { WaitingRequest(id: $0, kind: .secure) }
      + interactive.waiting.map { WaitingRequest(id: $0, kind: .interactive) }
  }

  /// Open a request that was put away again, in its sheet.
  func open(_ waiting: WaitingRequest) {
    switch waiting.kind {
    case .answer: requests.present(waiting.id)
    case .secure: secureInput.present(waiting.id)
    case .interactive: interactive.present(waiting.id)
    }
  }

  // MARK: Lifecycle

  func start() {
    let model = self.model
    let session = self.session
    let listState = self.listState

    listState.onNearTop = { [weak self] in self?.loadOlder() }
    // The reader's own send takes the transcript to the bottom, wherever they had scrolled; a
    // message from elsewhere leaves a reader who scrolled up where they are.
    composer.onSubmit = { [weak listState] in listState?.followOwnSend() }

    let revisions = Observations { model.snapshot?.revision }
    let phases = Observations { session.status.phase }
    let bottom = Observations { listState.isAtBottom }
    let requests = self.requests
    let secureInput = self.secureInput
    let interactive = self.interactive
    let composer = self.composer
    let covering = Observations {
      requests.presentedRequestID != nil || secureInput.presentedID != nil || interactive.presentedID != nil
    }

    tasks = [
      // Nothing goes out from the composer while a request has the screen: what is typed for a
      // secure prompt must never leave as a message (the field is off as well; this holds the send).
      Task {
        for await up in covering {
          composer.held = up
        }
      },
      Task { [weak self] in
        for await _ in revisions {
          await self?.snapshotChanged()
        }
      },
      Task { [weak self] in
        for await phase in phases {
          self?.connectionChanged(phase)
        }
      },
      Task { [weak self] in
        for await atBottom in bottom {
          guard let self else { return }
          if atBottom {
            self.newCount = 0
          }
          self.markReadSoon()
        }
      }
    ]
  }

  /// The screen is gone: stop watching, mark read and write the cache, give the model back.
  func stop() {
    guard !stopped else {
      return
    }

    stopped = true
    ChatLifecycleLog.note("feed f\(tag) stopped for \(name) (lease \(lease.id))")
    // Leaving the chat puts away the request its sheet showed, as Later does: the chat, opened
    // again, says it is waiting instead of raising it over the screen once more. Nothing is answered.
    requests.leave()
    secureInput.leave()
    interactive.leave()

    for task in tasks {
      task.cancel()
    }

    tasks = []
    markTask?.cancel()
    typingTask?.cancel()
    typingTask = nil
    abandonFind()
    flashTask?.cancel()
    noticeTask?.cancel()
    listState.onNearTop = nil
    composer.onSubmit = nil
    // Leaving the chat: nothing keeps reading, and the microphone closes.
    stopVoice()
    // Leaving the chat: every upload stops and what was staged goes with it.
    composer.tray.clear()

    let session = self.session
    let name = self.name
    let lease = self.lease

    Task {
      await session.close(name)
      ChatLeases.release(lease, from: session)
    }
  }

  func sceneChanged(active: Bool) {
    sceneActive = active
    voiceSceneChanged(active: active)
    markReadSoon()
  }

  /// A page or a sheet came over the screen, or went. Uncovered, a reader at the bottom gets the
  /// newest row marked read as usual.
  func coverChanged(covered: Bool) {
    guard self.covered != covered else {
      return
    }

    self.covered = covered

    if covered {
      markTask?.cancel()
    } else {
      markReadSoon()
    }
  }

  // MARK: Snapshots

  private func snapshotChanged() async {
    guard let snapshot = model.snapshot else {
      return
    }

    if hydration != snapshot.hydration {
      hydration = snapshot.hydration
    }

    if activity != snapshot.activity {
      activity = snapshot.activity
    }

    if canLoadOlder != snapshot.canLoadOlder {
      canLoadOlder = snapshot.canLoadOlder
    }

    if yolo != snapshot.yolo {
      yolo = snapshot.yolo
    }

    applyOptions(snapshot)

    // A live chat's finished replies are offered to the automatic read (a cached copy is not a
    // conversation: what it holds is history).
    if snapshot.hydration == .live {
      autoReadChanged(snapshot)
    }

    if snapshot.hydration == .error {
      openIfNeeded()
    }

    // Only a chat that is live says the bot is working: a cached copy's turn may be long over.
    typingChanged(
      wanted: snapshot.hydration == .live && TypingIndicator.wanted(activity: snapshot.activity, items: snapshot.items))

    await buildRows()
    markReadSoon()
  }

  /// One build at a time; frames that arrive meanwhile are folded into one more.
  private func buildRows() async {
    guard !building else {
      rebuild = true
      return
    }

    building = true
    defer { building = false }

    repeat {
      rebuild = false

      guard let snapshot = model.snapshot else {
        return
      }

      // The chat's first message gets its date line only once no earlier page can arrive.
      let output = await pipeline.rows(
        for: snapshot.items, historyComplete: !snapshot.canLoadOlder, typing: typingGate.visible)

      guard !stopped else {
        return
      }

      builtRows = output.rows
      rowsRevision += 1
      rows = flashed(output.rows)

      if !listState.isAtBottom, output.arrived > 0 {
        newCount += output.arrived
      }

      if !loaded {
        loaded = true
      }

      // After the rows are in: the row a search hit is about may have arrived with them.
      findWalk?.step()
    } while rebuild
  }

  // MARK: Typing row

  /// The bot's state, as the debounce wants it. The row's own appearance waits `showDelay` for the
  /// bot to keep working with nothing on screen; its going comes with the snapshot that puts the
  /// reply (or the end of the turn) on screen, so it is already in the rows being built.
  private func typingChanged(wanted: Bool) {
    typingWanted = wanted
    typingGate.update(wanted: wanted, now: uptime())

    // One timer per stretch of wanting, not one per streamed delta.
    guard typingGate.showDeadline != nil else {
      typingTask?.cancel()
      typingTask = nil
      return
    }

    guard typingTask == nil else {
      return
    }

    typingTask = Task { [weak self] in
      while let self, !Task.isCancelled, !self.stopped, let deadline = self.typingGate.showDeadline {
        try? await Task.sleep(for: .seconds(max(0, deadline - self.uptime())))

        guard !Task.isCancelled, !self.stopped else {
          return
        }

        if self.typingGate.update(wanted: self.typingWanted, now: self.uptime()) {
          await self.buildRows()
        }
      }

      // Done (the row shows), not cancelled: a cancelled timer's slot may already be a new one's.
      if !Task.isCancelled {
        self?.typingTask = nil
      }
    }
  }

  // MARK: Opening

  private func connectionChanged(_ phase: ConnectionPhase) {
    if phase == .ready {
      readyEpoch += 1
      openIfNeeded()
    }
  }

  /// The hydration the store holds the chat at, before this screen's first snapshot.
  private var currentHydration: HydrationState {
    model.snapshot?.hydration ?? session.chatList.rows[name]?.hydration ?? .cold
  }

  func openIfNeeded(force: Bool = false) {
    guard !stopped, !opening, session.status.phase == .ready else {
      return
    }

    switch currentHydration {
    case .cold, .cached:
      break
    case .error:
      guard force || failedEpoch != readyEpoch else { return }
    default:
      guard force else { return }
    }

    opening = true
    let epoch = readyEpoch

    Task {
      defer { opening = false }

      do {
        try await session.open(name)
        openError = nil
        openErrorKind = nil
      } catch {
        failedEpoch = epoch
        recordOpenFailure(error)
      }
    }
  }

  /// The open failed: its words for the banner, its kind for diagnostics.
  func recordOpenFailure(_ error: any Error) {
    openError = ChatResolver.describe(error)
    openErrorKind = ChatResolver.category(error)
  }

  // MARK: History

  func loadOlder() {
    guard canLoadOlder, !loadingOlder, !historyExhausted, hydration == .live else {
      return
    }

    loadingOlder = true

    Task {
      let result = await model.loadOlder()
      loadingOlder = false

      if result != .grew {
        historyExhausted = true
      }
    }
  }

  // MARK: Find

  /// How long the found row stays marked, and how long the notice for words that were not found stays
  /// up; the tests set their own.
  @ObservationIgnored var flashDuration: Duration = .seconds(2.5)
  @ObservationIgnored var noticeDuration: Duration = .seconds(8)
  /// How often a find that is waiting for the list to lay out its first rows looks again.
  @ObservationIgnored var findRetryInterval: Duration = .milliseconds(100)
  /// Where the found row lands in the viewport: a little below the top, so the row above it shows.
  static let findAnchor = UnitPoint(x: 0.5, y: 0.3)

  /// Show the newest row that holds `request`'s words. A request this feed has taken already, or one
  /// for another chat, is ignored; a newer one replaces a walk still under way.
  ///
  /// - Parameter settle: called once, with the request's id, when the request is dealt with (the row
  ///   shown, or the words not found) or the screen goes before that.
  func find(_ request: ChatFindRequest, settle: @escaping @MainActor (Int) -> Void) {
    guard !stopped, request.chat == chat, request.id != findRequestID else {
      return
    }

    abandonFind()
    clearFindNotice()
    findRetries = 0
    findRequestID = request.id
    findSettle = settle

    let walk = ChatFindWalk(
      query: request.query,
      hooks: .chat(
        model,
        reveal: { [weak self] id in self?.revealRow(holding: id) ?? false },
        revision: { [weak self] in self?.rowsRevision ?? 0 },
        // What the rows draw, so that whatever is found has a row to scroll to.
        items: { [weak self] in self?.rows.flatMap(\.items) ?? [] },
        loadOlder: { [weak self] in await self?.loadOlderForFind() ?? .unavailable }
      ),
      onSettled: { [weak self] outcome in self?.findSettled(outcome, request: request) }
    )
    findWalk = walk
    walk.step()
  }

  /// Scroll to the row that draws the item and mark it. False when the list has no such row yet, or has
  /// not laid out its rows yet: a scroll it is asked for before that is dropped, and nothing else may
  /// come to ask again in a chat nobody is writing in, so the walk looks again by itself.
  private func revealRow(holding itemID: String) -> Bool {
    guard let row = rows.first(where: { $0.holds(itemID: itemID) }) else {
      return false
    }

    guard listState.rowsLaidOut else {
      retryFindSoon()
      return false
    }

    // Unanimated: the row may be hundreds of rows away, among heights that are still estimates.
    listState.scroll(to: row.id, anchor: Self.findAnchor, animated: false)
    flash(itemID)
    return true
  }

  /// Look again at the rows in a moment: the list is not showing them yet. Bounded, so a chat on a
  /// window nobody sees does not poll for ever; the rebuilds that follow look again as well.
  private func retryFindSoon() {
    guard findRetryTask == nil, findRetries < 100 else {
      return
    }

    findRetries += 1
    let interval = findRetryInterval
    findRetryTask = Task { [weak self] in
      try? await Task.sleep(for: interval)

      guard !Task.isCancelled, let self else { return }

      self.findRetryTask = nil
      self.findWalk?.step()
    }
  }

  /// One page for the walk. The same indicator and the same end of history as the reader's own scroll.
  private func loadOlderForFind() async -> OlderHistory {
    loadingOlder = true
    let result = await model.loadOlder()
    loadingOlder = false

    if result != .grew {
      historyExhausted = true
    }

    return result
  }

  private func findSettled(_ outcome: ChatFindWalk.Outcome, request: ChatFindRequest) {
    findWalk = nil

    switch outcome {
    case .found:
      announce(NativeStrings.Search.found(query: request.query))
    case .notFound:
      // Said where it can be read, and announced: scrolling to nowhere without an explanation is how a
      // working search reads as a broken one.
      let words = Strings.App.Chat.findExhausted(query: request.query)
      findNotice = words
      announce(words)

      noticeTask?.cancel()
      let duration = noticeDuration
      noticeTask = Task { [weak self] in
        try? await Task.sleep(for: duration)

        guard !Task.isCancelled else { return }
        self?.clearFindNotice()
      }
    }

    settleRequest()
  }

  private func clearFindNotice() {
    noticeTask?.cancel()
    noticeTask = nil

    if findNotice != nil {
      findNotice = nil
    }
  }

  /// The screen goes, or another request replaces the walk: no outcome is reported, the request is let go.
  private func abandonFind() {
    findWalk?.cancel()
    findWalk = nil
    findRetryTask?.cancel()
    findRetryTask = nil
    settleRequest()
  }

  private func settleRequest() {
    if let id = findRequestID, let settle = findSettle {
      findSettle = nil
      settle(id)
    }
  }

  private func announce(_ text: String) {
    AccessibilityNotification.Announcement(text).post()
  }

  // MARK: The marked row

  /// Mark the row that draws `itemID`, and take the mark away after `flashDuration`.
  private func flash(_ itemID: String) {
    flashID = itemID
    rows = flashed(builtRows)

    flashTask?.cancel()
    let duration = flashDuration
    flashTask = Task { [weak self] in
      try? await Task.sleep(for: duration)

      guard !Task.isCancelled, let self, !self.stopped else { return }

      self.flashID = nil
      self.rows = self.builtRows
    }
  }

  /// `rows` with the marked row, while there is one: only that row's value differs, so only it redraws.
  private func flashed(_ rows: TranscriptListItems<TranscriptRow>) -> TranscriptListItems<TranscriptRow> {
    guard let flashID, rows.contains(where: { $0.holds(itemID: flashID) }) else {
      return rows
    }

    return TranscriptListItems(
      rows.elements.map { row in
        guard row.holds(itemID: flashID) else { return row }

        var marked = row
        marked.flash = true
        return marked
      })
  }

  // MARK: Read marks

  private func markReadSoon() {
    guard sceneActive, !covered, listState.isAtBottom, hydration == .live,
      let last = rows.last(where: { !$0.isTypingIndicator })
    else {
      return
    }

    let key = "\(last.id)#\(last.visibleItem?.item.version ?? 0)"

    guard key != markedKey else {
      return
    }

    markTask?.cancel()
    let delay = readMarkDelay
    markTask = Task { [weak self] in
      try? await Task.sleep(for: delay)

      guard let self, !Task.isCancelled, !self.stopped, self.sceneActive, !self.covered, self.listState.isAtBottom else {
        return
      }

      self.markedKey = key
      self.readMarks += 1
      await self.session.markRead(self.name)
    }
  }
}

/// A chat screen's hold on a bot's `ChatModel`, from `ChatLeases.acquire`. Each is unique, so giving
/// one back can only ever end that hold.
struct ChatLease: Hashable, Sendable {
  let session: ObjectIdentifier
  let bot: String
  let id: UInt64
}

/// Who holds which bot's model on which session, without the session: `ChatLeases` keeps one.
struct ChatLeaseBook {
  private var holders: [ObjectIdentifier: [String: Set<UInt64>]] = [:]
  private var lastID: UInt64 = 0

  mutating func acquire(session: ObjectIdentifier, bot: String) -> ChatLease {
    lastID += 1
    holders[session, default: [:]][bot, default: []].insert(lastID)

    return ChatLease(session: session, bot: bot, id: lastID)
  }

  /// Gives `lease` back. True when it was the bot's last one, so the model goes back to the
  /// session. A lease given back twice, or never taken, changes nothing and returns false: an old
  /// screen's late teardown cannot take the model from a screen that holds it now.
  mutating func release(_ lease: ChatLease) -> Bool {
    guard holders[lease.session]?[lease.bot]?.remove(lease.id) != nil else {
      return false
    }

    guard holders[lease.session]?[lease.bot]?.isEmpty == true else {
      return false
    }

    holders[lease.session]?[lease.bot] = nil

    if holders[lease.session]?.isEmpty == true {
      holders[lease.session] = nil
    }

    return true
  }

  /// How many screens hold the bot's model on the session.
  func count(session: ObjectIdentifier, bot: String) -> Int {
    holders[session]?[bot]?.count ?? 0
  }
}

/// One `ChatModel` per bot per session, shared by every screen that shows the chat (a second
/// window, say), and released to the session only when the last of them goes away.
@MainActor
enum ChatLeases {
  private static var book = ChatLeaseBook()

  static func acquire(_ session: GatewaySession, _ name: String) -> (model: ChatModel, lease: ChatLease) {
    let lease = book.acquire(session: ObjectIdentifier(session), bot: name)
    ChatLifecycleLog.note("lease \(lease.id) taken for \(name), holders \(holders(session, name))")

    return (session.chat(name), lease)
  }

  static func release(_ lease: ChatLease, from session: GatewaySession) {
    let last = book.release(lease)
    ChatLifecycleLog.note("lease \(lease.id) given back for \(lease.bot), holders \(holders(session, lease.bot))")

    if last {
      session.release(lease.bot)
    }
  }

  /// How many screens hold the bot's model, for the diagnostics.
  static func holders(_ session: GatewaySession, _ name: String) -> Int {
    book.count(session: ObjectIdentifier(session), bot: name)
  }
}
