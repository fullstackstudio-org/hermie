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

 The chat is marked read while its newest row is on screen and the window is in front, whenever
 the newest row changes, a moment after it settles; and once more when the screen goes away.
 */
@MainActor
@Observable
final class ChatFeed {
  let chat: ChatRef
  let session: GatewaySession
  let model: ChatModel
  /// The chat's composer, the approval and clarify answers, and the secure prompts: one each per
  /// open chat screen, over the same `ChatModel`.
  let composer: ComposerModel
  let requests: RequestsModel
  let secureInput: SecureInputModel

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
  @ObservationIgnored private var sceneActive = true
  @ObservationIgnored private var markTask: Task<Void, Never>?
  /// The newest row (id and version) last marked read.
  @ObservationIgnored private var markedKey: String?
  @ObservationIgnored private var stopped = false

  init(chat: ChatRef, session: GatewaySession, actions: @MainActor (ChatModel) -> TranscriptItemActions) {
    self.chat = chat
    self.session = session
    self.model = ChatLeases.acquire(session, chat.bot)
    self.composer = ComposerModel(session: session, bot: chat.bot)
    self.requests = RequestsModel(session: session, bot: chat.bot)
    self.secureInput = SecureInputModel(session: session, bot: chat.bot)
    self.itemActions = actions(model)
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

    for task in tasks {
      task.cancel()
    }

    tasks = []
    markTask?.cancel()
    listState.onNearTop = nil
    composer.onSubmit = nil

    let session = self.session
    let name = self.name

    Task {
      await session.close(name)
      ChatLeases.release(session, name)
    }
  }

  func sceneChanged(active: Bool) {
    sceneActive = active
    markReadSoon()
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
      let output = await pipeline.rows(for: snapshot.items, historyComplete: !snapshot.canLoadOlder)

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
      } catch {
        failedEpoch = epoch
        openError = ChatResolver.describe(error)
      }
    }
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
    guard sceneActive, listState.isAtBottom, hydration == .live, let last = rows.last else {
      return
    }

    let key = "\(last.id)#\(last.visibleItem?.item.version ?? 0)"

    guard key != markedKey else {
      return
    }

    markTask?.cancel()
    markTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(600))

      guard let self, !Task.isCancelled, !self.stopped, self.sceneActive, self.listState.isAtBottom else {
        return
      }

      self.markedKey = key
      await self.session.markRead(self.name)
    }
  }
}

/// One `ChatModel` per bot per session, shared by every screen that shows the chat (a second
/// window, say), and released to the session only when the last of them goes away.
@MainActor
enum ChatLeases {
  private static var counts: [ObjectIdentifier: [String: Int]] = [:]

  static func acquire(_ session: GatewaySession, _ name: String) -> ChatModel {
    counts[ObjectIdentifier(session), default: [:]][name, default: 0] += 1
    return session.chat(name)
  }

  static func release(_ session: GatewaySession, _ name: String) {
    let id = ObjectIdentifier(session)
    let remaining = (counts[id]?[name] ?? 1) - 1

    if remaining > 0 {
      counts[id]?[name] = remaining
      return
    }

    counts[id]?[name] = nil

    if counts[id]?.isEmpty == true {
      counts[id] = nil
    }

    session.release(name)
  }
}
