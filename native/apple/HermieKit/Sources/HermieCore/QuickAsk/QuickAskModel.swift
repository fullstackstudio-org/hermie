import Foundation
import HermieGateway
import HermieTranscript
import Observation

/// Which part of the quick ask takes the keyboard when it opens.
public enum QuickAskFocus: Equatable, Sendable {
  /// The message field.
  case field
  /// The bot picker: what "Send to Hermie" lands on, so the person chooses who gets the text.
  case botPicker
}

/// What something outside the app hands the quick ask: words, files, and where the keyboard goes.
public struct QuickAskHandoff: Equatable, Sendable {
  public var text: String?
  public var files: [URL]
  public var focus: QuickAskFocus

  public init(text: String? = nil, files: [URL] = [], focus: QuickAskFocus = .field) {
    self.text = text
    self.files = files
    self.focus = focus
  }

  /// What the Services menu handed over: the selected text and the files selected in the Finder.
  /// Nil when there is nothing in it to send (empty or blank words, no file). Files win nothing over
  /// words and words nothing over files: both are taken, and the bot picker has the keyboard.
  public static func service(text: String?, files: [URL]) -> QuickAskHandoff? {
    let words = text?.trimmingCharacters(in: .whitespacesAndNewlines)
    let kept = (words?.isEmpty ?? true) ? nil : words
    let fileURLs = files.filter(\.isFileURL)

    guard kept != nil || !fileURLs.isEmpty else {
      return nil
    }

    return QuickAskHandoff(text: kept, files: fileURLs, focus: .botPicker)
  }
}

/**
 The quick ask: a bot, a message, and the answer, in one small window (the menu bar item's, or the
 panel the global shortcut opens when the item is not there).

 It reuses what a chat has instead of a session type of its own:

 - the message goes through the chat's own `ComposerModel` (`submit`), so a quick ask is a message
   in the bot's normal chat, with the same slash commands, queue and attachment tray, and is read
   there afterwards ("Open in Hermie");
 - the answer is the chat's transcript, the items that arrived after the send, which the window
   draws with the transcript's own rows;
 - the chat's model is held the way a chat screen holds it (`Hold`), so a chat that is open in a
   window keeps its model when this lets go.

 The model lives as long as the app, not as long as the window: the global shortcut and the Services
 menu hand it something (`accept`) before any window exists. It follows the live gateway; a window
 calls `sync()` whenever the session, the roster or the chat's state changed (`syncKey`).

 Words dropped or handed over stay in the field when they are short, and become a text file in the
 attachment tray when they are long (`inlineTextLimit`): a page of text in a field the size of a
 menu bar window is not a message, it is a document.
 */
@MainActor
@Observable
public final class QuickAskModel {
  /// Longer than this, handed-over words are attached as a file instead of typed into the field.
  public static let inlineTextLimit = 4_000
  /// What a text attachment is called on the gateway.
  public static let textAttachmentName = "Text.txt"

  /// Takes a hold on a bot's chat model, and says how to give it back (a chat screen's lease).
  public typealias Hold = @MainActor (GatewaySession, String) -> (model: ChatModel, release: @MainActor () -> Void)

  /// One bot in the picker.
  public struct Choice: Identifiable, Equatable, Sendable {
    /// The bot's profile name.
    public var id: String
    /// The name that leads, as the chat list shows it.
    public var title: String
    /// The other name, when there is one.
    public var subtitle: String
    public var avatar: String?
  }

  /// Where the ask stands, for the window.
  public enum Stage: Equatable, Sendable {
    /// Nothing sent yet, or the last answer was put away: the field is the window.
    case composing
    /// The message is going out.
    case sending
    /// Sent; the bot has said nothing yet.
    case waiting
    /// The bot is answering: the reply is growing.
    case streaming
    /// The bot has answered.
    case done

    /// The bot is, or is about to be, at work.
    public var isWorking: Bool { self == .sending || self == .waiting || self == .streaming }
  }

  /// What a window re-syncs on: any of it moving means the model has something to do.
  public struct SyncKey: Hashable, Sendable {
    var session: ObjectIdentifier?
    var phase: ConnectionPhase?
    var names: [String]
    var hydration: HydrationState?
    var selected: String?
    var hasComposer: Bool
  }

  public let settings: QuickAskSettings

  /// Open this chat in the main window. The app routes it (`ShellRequests`).
  @ObservationIgnored public var onOpenChat: (@MainActor (QuickAskTarget) -> Void)?

  /// The bot the next message goes to.
  public private(set) var selectedBot: String?
  /// The composer of the selected bot's chat; nil until there is a session and a bot.
  public private(set) var composer: ComposerModel?
  /// Where the keyboard goes next, and a counter that moves each time it is asked for again.
  public private(set) var focus = QuickAskFocus.field
  public private(set) var focusSerial = 0
  /// Why the chat could not be opened, while it could not.
  public private(set) var openFailure: String?

  /// The chat's items as they were when the message went out: the answer is what came after.
  private var sentMarker: Set<String>?

  @ObservationIgnored private let currentSession: @MainActor () -> GatewaySession?
  @ObservationIgnored private let hold: Hold
  @ObservationIgnored private var held: Held?
  @ObservationIgnored private var opening: Task<Void, Never>?
  @ObservationIgnored private var pendingText: [String] = []
  @ObservationIgnored private var pendingFiles: [URL] = []
  /// The words in the field when the composer went away (another bot, another gateway).
  @ObservationIgnored private var carriedDraft = ""

  private struct Held {
    var session: GatewaySession
    var bot: String
    var model: ChatModel
    var release: @MainActor () -> Void
  }

  /// - Parameters:
  ///   - session: the session a quick ask goes through, read each time (and so observed): the live
  ///     gateway's.
  ///   - hold: how the chat's model is taken and given back. The app's is a chat screen's lease;
  ///     the default just asks the session for it.
  public init(
    session: @escaping @MainActor () -> GatewaySession?,
    settings: QuickAskSettings,
    hold: @escaping Hold = { session, bot in (session.chat(bot), {}) }
  ) {
    self.currentSession = session
    self.settings = settings
    self.hold = hold
  }

  /// A quick ask over the app's live gateway.
  public convenience init(
    live: LiveGateway,
    settings: QuickAskSettings,
    hold: @escaping Hold = { session, bot in (session.chat(bot), {}) }
  ) {
    self.init(session: { [live] in live.session }, settings: settings, hold: hold)
  }

  // MARK: What the window reads

  /// The live gateway's session, when there is one.
  public var session: GatewaySession? { currentSession() }

  /// The bots, in the chat list's order.
  public var choices: [Choice] {
    guard let session else {
      return []
    }

    return session.chatList.names.map { name in
      let names = session.botNames(name)

      return Choice(id: name, title: names.primary, subtitle: names.secondary, avatar: session.chatList.rows[name]?.avatar)
    }
  }

  /// The bot and gateway a message goes to, and what "Open in Hermie" opens.
  public var target: QuickAskTarget? {
    guard let held else {
      return nil
    }

    return QuickAskTarget(gatewayID: held.session.gatewayID, bot: held.bot)
  }

  /// The chat's items that arrived after the message went out: the message, and the answer as it grows.
  public var exchange: [VisibleItem] {
    guard let sentMarker, let model = held?.model else {
      return []
    }

    return model.items.filter { !sentMarker.contains($0.item.base.id) }
  }

  public var stage: Stage {
    guard sentMarker != nil, let composer, let model = held?.model else {
      return .composing
    }

    if composer.isSending {
      return .sending
    }

    let items = exchange
    let replying = items.contains { $0.item.asAssistant != nil }

    if model.turnActive || model.busy {
      return replying ? .streaming : .waiting
    }

    // A turn that is over has said something besides the message; with nothing yet, the bot has not begun.
    return items.contains { $0.item.asUser == nil } ? .done : .waiting
  }

  /// What a window re-syncs on.
  public var syncKey: SyncKey {
    let session = self.session

    return SyncKey(
      session: session.map(ObjectIdentifier.init),
      phase: session?.status.phase,
      names: session?.chatList.names ?? [],
      hydration: held?.model.snapshot?.hydration,
      selected: selectedBot,
      hasComposer: composer != nil
    )
  }

  // MARK: Following the session

  /// Bring the model in line with the live session: choose the bot (the last used, else the first),
  /// give it a composer, open its chat when that needs opening, and put in what was handed over while
  /// there was nowhere to put it. Cheap, and safe to call as often as wanted.
  public func sync() {
    guard let session else {
      letGoOfComposer()
      return
    }

    resolveSelection(in: session)

    guard let bot = selectedBot else {
      return
    }

    if held?.session !== session || held?.bot != bot {
      rebuildComposer(in: session, bot: bot)
    }

    openIfNeeded(in: session, bot: bot)
    applyPending()
  }

  private func resolveSelection(in session: GatewaySession) {
    let names = session.chatList.names

    // A roster still loading says nothing about a bot that was chosen.
    guard !names.isEmpty, selectedBot.map(names.contains) != true else {
      return
    }

    if let last = settings.lastBot, last.gatewayID == session.gatewayID, names.contains(last.bot) {
      selectedBot = last.bot
    } else {
      selectedBot = names.first
    }
  }

  private func rebuildComposer(in session: GatewaySession, bot: String) {
    let carried = composer?.draft ?? carriedDraft
    letGoOfComposer()

    let (model, release) = hold(session, bot)
    held = Held(session: session, bot: bot, model: model, release: release)

    let next = ComposerModel(chat: model, gatewayID: session.gatewayID, session: session, drafts: nil)
    carriedDraft = ""

    if !carried.isEmpty {
      next.draft = carried
    }

    composer = next
    sentMarker = nil
    openFailure = nil
  }

  /// Let go of the chat and its composer: what was staged is deleted, the model goes back.
  private func letGoOfComposer() {
    guard let held else {
      return
    }

    carriedDraft = composer?.draft ?? carriedDraft
    composer?.tray.clear()
    composer = nil
    sentMarker = nil
    opening?.cancel()
    opening = nil
    self.held = nil
    held.release()
  }

  /// A chat that the store does not hold live is opened, as a chat screen does it, once the
  /// connection is up. A failed open is not tried again until the connection has come and gone.
  private func openIfNeeded(in session: GatewaySession, bot: String) {
    guard session.status.phase == .ready else {
      openFailure = nil
      return
    }

    guard opening == nil, openFailure == nil else {
      return
    }

    let hydration = held?.model.snapshot?.hydration ?? session.chatList.rows[bot]?.hydration ?? .cold

    guard hydration == .cold || hydration == .cached || hydration == .error else {
      return
    }

    opening = Task { [weak self] in
      do {
        try await session.open(bot)
        self?.openFailure = nil
      } catch {
        self?.openFailure = ChatResolver.describe(error)
      }

      self?.opening = nil
    }
  }

  /// Try to open the chat again after a failure.
  public func retryOpen() {
    openFailure = nil
    sync()
  }

  // MARK: Choosing

  /// Send the next message to `bot`. The words in the field come along; what was staged is let go,
  /// because an attachment is uploaded to one chat's workspace and is not another's.
  public func select(_ bot: String) {
    guard let session, bot != selectedBot, session.chatList.names.contains(bot) else {
      return
    }

    selectedBot = bot
    settings.setLastBot(QuickAskTarget(gatewayID: session.gatewayID, bot: bot))
    sync()
  }

  // MARK: Sending

  /// Send what is in the field, through the chat's own composer, and show what comes of it.
  public func send() async {
    guard let composer, let model = held?.model, composer.canSubmit, !composer.isSending else {
      return
    }

    let body = composer.draft
    let before = Set(model.items.map { $0.item.base.id })
    let event = composer.lastEvent?.serial ?? 0

    // Before the await: the message appears in the window when the chat paints it.
    sentMarker = before
    await composer.submit()

    // A send that was refused painted nothing and kept the words: there is no exchange to show.
    // One that failed after the paint cleared the field and keeps its bubble.
    let wentOut = composer.lastEvent?.serial != event || composer.draft != body

    if wentOut {
      if let target {
        settings.setLastBot(target)
      }
    } else {
      sentMarker = nil
    }
  }

  /// Put the last answer away: the window is the field again.
  public func clearExchange() {
    sentMarker = nil
  }

  /// Open the bot's chat in the main window.
  public func openInApp() {
    guard let target else {
      return
    }

    onOpenChat?(target)
  }

  // MARK: What comes from outside

  /// The global shortcut, the Services menu or a drop handed words or files. They wait when there
  /// is no session yet and are put in once there is.
  public func accept(_ handoff: QuickAskHandoff) {
    focus = handoff.focus
    focusSerial += 1
    take(handoff)
  }

  private func take(_ handoff: QuickAskHandoff) {
    // A new thing to say: the last answer is put away, unless the bot is still saying it.
    if !stage.isWorking {
      sentMarker = nil
    }

    if let text = handoff.text {
      pendingText.append(text)
    }

    pendingFiles += handoff.files
    sync()
  }

  /// Words dropped on the window: typed into the field when they are short, a text file in the tray
  /// when they are long.
  public func acceptText(_ text: String) {
    take(QuickAskHandoff(text: text))
  }

  /// Files dropped on the window or chosen in the Finder.
  public func acceptFiles(_ urls: [URL]) {
    take(QuickAskHandoff(files: urls))
  }

  private func applyPending() {
    guard let composer, !pendingText.isEmpty || !pendingFiles.isEmpty else {
      return
    }

    let words = pendingText
    let files = pendingFiles
    pendingText = []
    pendingFiles = []

    for text in words {
      put(text, into: composer)
    }

    if !files.isEmpty {
      composer.tray.addFiles(copying: files)
    }
  }

  private func put(_ text: String, into composer: ComposerModel) {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !words.isEmpty else {
      return
    }

    if words.count > Self.inlineTextLimit, attach(words, to: composer) {
      return
    }

    let draft = composer.draft
    composer.type(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? words : draft + "\n\n" + words)
  }

  /// Long words as a text file in the tray; false when it could not be made.
  private func attach(_ words: String, to composer: ComposerModel) -> Bool {
    guard
      let file = try? AttachmentStaging.stage(
        data: Data(words.utf8), name: Self.textAttachmentName, mimeType: "text/plain")
    else {
      return false
    }

    composer.tray.add([file])
    return true
  }
}
