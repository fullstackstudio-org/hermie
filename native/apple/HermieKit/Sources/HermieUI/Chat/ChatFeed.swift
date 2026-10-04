import Foundation
import HermieCore
import HermieGateway
import HermieTranscript
import Observation

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

  private(set) var rows = TranscriptListItems<TranscriptRow>()
  /// The first rows have arrived.
  private(set) var loaded = false
  /// User and assistant rows that arrived while the reader was scrolled up.
  private(set) var newCount = 0
  private(set) var hydration = HydrationState.cold
  private(set) var activity = TurnActivity.idle
  private(set) var canLoadOlder = false
  private(set) var loadingOlder = false
  /// Why the last open failed, for the banner over the transcript.
  private(set) var openError: String?
  /// What kind of failure that was, without its words (`ChatResolver.category`), for diagnostics.
  @ObservationIgnored private(set) var openErrorKind: String?

  @ObservationIgnored let listState = TranscriptListState()
  @ObservationIgnored let expansion = TranscriptExpansion()
  /// The rows' actions other than the answers (which `requests` adds), built once: rows compare on
  /// their item alone, so the actions must not change while open.
  @ObservationIgnored let itemActions: TranscriptItemActions

  @ObservationIgnored private let pipeline = ChatRowPipeline()
  @ObservationIgnored private var tasks: [Task<Void, Never>] = []
  @ObservationIgnored private var building = false
  @ObservationIgnored private var rebuild = false
  @ObservationIgnored private var opening = false
  /// Bumped each time the connection becomes ready; a failed open is retried once per epoch.
  @ObservationIgnored private var readyEpoch = 0
  @ObservationIgnored private var failedEpoch = -1
  @ObservationIgnored private var historyExhausted = false
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

  init(chat: ChatRef, session: GatewaySession, actions: @MainActor (ChatModel) -> TranscriptItemActions) {
    Self.tags += 1
    self.tag = Self.tags
    self.chat = chat
    self.session = session
    (self.model, self.lease) = ChatLeases.acquire(session, chat.bot)
    self.composer = ComposerModel(session: session, bot: chat.bot)
    self.requests = RequestsModel(session: session, bot: chat.bot)
    self.secureInput = SecureInputModel(session: session, bot: chat.bot)
    self.interactive = InteractiveModel(session: session, bot: chat.bot)
    self.itemActions = actions(model)
    ChatLifecycleLog.note("feed f\(tag) made for \(chat.bot) (lease \(lease.id))")
  }

  var name: String { chat.bot }

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

    tasks = [
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

    for task in tasks {
      task.cancel()
    }

    tasks = []
    markTask?.cancel()
    typingTask?.cancel()
    typingTask = nil
    listState.onNearTop = nil
    composer.onSubmit = nil
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

      rows = output.rows

      if !listState.isAtBottom, output.arrived > 0 {
        newCount += output.arrived
      }

      if !loaded {
        loaded = true
      }
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
