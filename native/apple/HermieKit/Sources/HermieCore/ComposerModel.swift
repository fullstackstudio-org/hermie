import Foundation
import HermieGateway
import HermieStore
import HermieTranscript
import Observation

/// Why the composer can or cannot send right now, in the words a reader needs.
public enum ComposerAvailability: Sendable, Equatable {
  /// Attached and the socket is up.
  case ready
  /// The socket is dialling, reconnecting, paused or offline.
  case connecting
  /// The socket is up but the chat is not bound to a session yet (it is opening).
  case opening
  /// The gateway wants the reader to sign in again.
  case signedOut
  /// The gateway is below the contract this app speaks.
  case incompatible
}

/// The one thing the composer has to tell the reader about its last action.
public enum ComposerNotice: Sendable, Equatable {
  /// Refused before anything was painted: the draft is where it was.
  case notSent(String)
  /// Failed after the bubble was painted: the bubble is marked interrupted.
  case failed(String)
  /// `/new` while a send is unanswered or messages are queued.
  case busy
  /// A steer came too late: the message is back in the queue.
  case steerRejected
  /// The stop did not go out.
  case stopFailed(String)
  /// Something else the gateway refused (a `/new` that failed, a queue action).
  case other(String)
  /// A slash command the gateway refused or could not run: the words are back in the field.
  case commandFailed(String)
}

/// What the composer just did, for a VoiceOver announcement.
public enum ComposerEvent: Sendable, Equatable {
  case sent
  case queued
  case stopped
  /// A slash command ran; its answer is in the transcript.
  case commandRan
}

/// The keys that steer the completion list while it is open, as a field reports them.
public enum CompletionKey: Sendable, Equatable {
  case up
  case down
  case tab
  case enter
  case escape
}

public struct ComposerEventEntry: Sendable, Equatable {
  public var event: ComposerEvent
  public var serial: Int
}

/// The composer of one chat: its draft (kept per gateway and bot, across
/// launches), send, stop, and the queue behind a running turn.
///
/// Thin over the session layer on purpose. The queue is `TranscriptStore`'s
/// (`SubmitPipeline`): a send while a turn runs is parked there and goes out,
/// in order, as each turn ends. The failure forms are the store's too: a send
/// refused before anything was painted keeps the draft; a send that failed
/// after the bubble was painted leaves the bubble, marked interrupted, and the
/// draft stays empty.
@MainActor
@Observable
public final class ComposerModel {
  /// How long typing must pause before the draft is written.
  public static let draftDebounce: Duration = .milliseconds(400)
  /// The base key of a draft in the key-value store (namespaced per gateway, then per bot).
  public static let draftKey = "hermie.chat.draft"

  public let chat: ChatModel
  public let gatewayID: String

  /// What is in the field. Every change is written, debounced.
  public var draft: String {
    didSet {
      guard draft != oldValue else {
        return
      }

      scheduleDraftWrite()

      // Typing opens the list; a field set from somewhere else (a stored draft, a prefill, words put
      // back after a failure) does not.
      if settingProgrammatically {
        closeSuggestions()
      } else {
        refreshSuggestions()
      }
    }
  }

  // MARK: Slash completions

  /// What could follow what is typed, while the field holds a command being written: the commands
  /// whose name matches, or for a command with its name done, what the gateway offers after it.
  public internal(set) var suggestions: [SlashSuggestion] = []
  /// The line the arrow keys are on.
  public internal(set) var selectedSuggestion = 0
  /// What the command being filled in takes (`/model [model]`), shown under the list.
  public internal(set) var argumentHint: SlashArgumentHint?
  /// The list is waiting for an answer and has nothing to show yet.
  public internal(set) var suggestionsLoading = false
  /// The gateway method whose refusal left the list empty, for its one line.
  public internal(set) var suggestionsFailure: String?
  /// Escape closed the list; it stays closed until the reader types again.
  public internal(set) var suggestionsDismissed = false

  /// The list is on screen: the field holds a command being written and there is something to say
  /// about it (matches, a hint, a wait, a refusal), and Escape has not closed it.
  public var suggestionsOpen: Bool {
    !suggestionsDismissed
      && (!suggestions.isEmpty || argumentHint != nil || suggestionsLoading || suggestionsFailure != nil)
  }

  /// The gateway's command list for this chat, as last fetched (nil until the first slash).
  public var commands: SlashCatalog? { commandCatalog }

  /// What is staged to go with the next message: images read, files uploaded, each a chip.
  /// A send waits for it (`canSubmit`) and takes it out in the same step that clears the draft.
  public let tray: AttachmentTray

  /// Sends whose `prompt.submit` has not answered yet. A second message may
  /// follow before the first is answered: the store queues it behind the turn.
  public internal(set) var sendsInFlight = 0
  public var isSending: Bool { sendsInFlight > 0 }
  public private(set) var isStopping = false
  public internal(set) var notice: ComposerNotice?
  /// The last event, with a counter so the same event twice is announced twice.
  public internal(set) var lastEvent: ComposerEventEntry?

  /// Called once for every message the reader sends from this composer, the moment it is
  /// accepted (before the gateway answers): the chat screen takes its transcript to the bottom on
  /// it, wherever the reader had scrolled. Not called for a send that is refused.
  @ObservationIgnored public var onSubmit: (@MainActor () -> Void)?

  @ObservationIgnored let session: GatewaySession?
  @ObservationIgnored let drafts: KeyValueStore?
  @ObservationIgnored let debounce: Duration
  @ObservationIgnored private var draftWrite: Task<Void, Never>?
  @ObservationIgnored private var loaded = false
  @ObservationIgnored private var eventSerial = 0
  // The completion list's working state (`ComposerModel+Slash.swift`).
  @ObservationIgnored var settingProgrammatically = false
  @ObservationIgnored var commandCatalog: SlashCatalog?
  @ObservationIgnored var catalogTask: Task<Void, Never>?
  @ObservationIgnored var remoteTask: Task<Void, Never>?
  /// The reader is inside one run of typing a command (from the slash to the line being sent or
  /// emptied): the list is fetched once per run, and a fetch that failed is not repeated within it.
  @ObservationIgnored var inSlashRun = false
  @ObservationIgnored var catalogFailedInRun = false
  @ObservationIgnored var suggestionSerial = 0
  /// A send waiting for the command list, so a second Return does not send the line twice.
  @ObservationIgnored var resolvingCommand = false

  /// The composer for `bot` on `session`, its draft kept in the session's
  /// key-value store.
  public convenience init(session: GatewaySession, bot: String) {
    self.init(
      chat: session.chat(bot),
      gatewayID: session.gatewayID,
      session: session,
      drafts: session.roster.keyValues
    )
  }

  init(
    chat: ChatModel,
    gatewayID: String,
    session: GatewaySession?,
    drafts: KeyValueStore?,
    debounce: Duration = ComposerModel.draftDebounce,
    tray: AttachmentTray? = nil
  ) {
    self.chat = chat
    self.gatewayID = gatewayID
    self.session = session
    self.drafts = drafts
    self.debounce = debounce
    self.draft = ""

    if let tray {
      self.tray = tray
    } else {
      let store = chat.store
      let key = chat.key
      self.tray = AttachmentTray(
        AttachmentTray.Dependencies(upload: { file, progress in
          try await store.uploadAttachment(key, file: file, onProgress: progress)
        }))
    }
  }

  // MARK: - State the view reads

  /// The chat's key (the bot's name).
  public var bot: String { chat.key }

  public var availability: ComposerAvailability {
    let phase = session?.status.phase ?? (chat.connectionReady ? .ready : .connecting)

    switch phase {
    case .incompatible: return .incompatible
    case .needsSignin: return .signedOut
    case .ready: return chat.canSend ? .ready : .opening
    default: return .connecting
    }
  }

  /// The session layer's own gate: attached and the socket is ready.
  public var canSend: Bool { chat.canSend }

  /// Whether the send button does anything: something to send and a chat to send it to.
  ///
  /// Never while an attachment is still being read or uploaded, or failed and still in the tray:
  /// what the reader sees staged is what goes, and a message that silently left without the file
  /// would be the worse surprise.
  public var canSubmit: Bool { canSend && !tray.blocked && (!trimmedDraft.isEmpty || !tray.isEmpty) }

  /// The bot is at work (a turn, a tool, a subagent, a compaction): Stop is
  /// offered while the field is empty, and Esc stops.
  public var running: Bool { chat.busy }

  /// A turn runs: a send now is queued behind it.
  public var turnActive: Bool { chat.turnActive }

  /// Messages parked behind the running turn, oldest first.
  public var queue: [QueuedMessage] { chat.queue }

  private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

  // MARK: - The draft

  /// The key the draft is kept under: `hermie.chat.draft.<bot>@<gateway id>`.
  public var draftStorageKey: String {
    GatewayNamespace(gatewayID).key("\(Self.draftKey).\(bot)")
  }

  /// Read the stored draft. Typing that began before it arrived wins.
  public func loadDraft() async {
    guard !loaded else {
      return
    }

    loaded = true

    guard let drafts, let stored = try? await drafts.string(forKey: draftStorageKey), !stored.isEmpty else {
      return
    }

    if draft.isEmpty {
      putDraft(stored)
      // Read back, not typed: nothing new to write.
      draftWrite?.cancel()
      draftWrite = nil
    }
  }

  /// Write the draft now instead of after the pause (the screen is going away).
  public func flushDraft() async {
    draftWrite?.cancel()
    draftWrite = nil
    await writeDraft(draft)
  }

  private func scheduleDraftWrite() {
    guard drafts != nil else {
      return
    }

    draftWrite?.cancel()
    let text = draft
    let debounce = self.debounce
    draftWrite = Task { [weak self] in
      if debounce > .zero {
        try? await Task.sleep(for: debounce)
      }

      guard !Task.isCancelled else {
        return
      }

      await self?.writeDraft(text)
    }
  }

  private func writeDraft(_ text: String) async {
    guard let drafts else {
      return
    }

    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      try? await drafts.removeValue(forKey: draftStorageKey)
    } else {
      try? await drafts.setString(text, forKey: draftStorageKey)
    }
  }

  // MARK: - Actions

  /// Clear the last notice (the reader dismissed it, or typed on).
  public func dismissNotice() {
    notice = nil
  }

  /// Send what is in the field, or run the command it holds.
  ///
  /// `/new`, `/reset` and `/clear` start a new conversation. A line that begins with a slash and
  /// names a command the gateway has (`/model`, `/status`, a skill) runs it, and its answer lands in
  /// the transcript; a slash command takes no attachments, they stay staged for the next message.
  /// Anything else, `/usr/local/bin` or a sentence that happens to begin with a slash, goes to the
  /// bot as written; while a turn runs it is queued behind it.
  public func submit() async {
    let body = draft
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty || !tray.isEmpty else {
      return
    }

    // The send waits for the tray: an upload still going, or one that failed, holds it back.
    guard !tray.blocked else {
      return
    }

    if tray.isEmpty, let command = Self.conversationCommand(trimmed) {
      await runConversationCommand(command, body: body)
      return
    }

    if SlashLine.looksLikeCommand(trimmed) {
      switch await decideCommand(trimmed) {
      case .command:
        await runSlashCommand(trimmed, body: body)
        return
      case .abandoned:
        return
      case .prompt:
        break
      }
    }

    guard canSend else {
      notice = .notSent(ChatRuntimeError.notAttached(bot).message)
      return
    }

    notice = nil
    sendsInFlight += 1
    draft = ""
    // Taken out of the tray in this very step, before anything is awaited: a second Return (or a
    // tap on Send) that lands while this send is in flight finds the tray empty and sends nothing
    // (HERM-126: the same attachments went out twice).
    let taken = tray.take()
    onSubmit?()

    defer {
      sendsInFlight -= 1
    }

    do {
      let painted = try await chat.store.send(bot, text: body, outgoing: taken?.attachments ?? [])
      announce(painted == nil ? .queued : .sent)

      if let taken {
        tray.release(taken)
      }
    } catch let error as ChatRuntimeError where error.isNotAttached {
      // Refused before anything was painted: the words go back where they were, and so do the files.
      if draft.isEmpty {
        putDraft(body)
      }

      if let taken {
        tray.restore(taken)
      }

      notice = .notSent(error.message)
    } catch {
      // Painted, then failed: the bubble keeps the words, marked interrupted. What it carried is
      // on screen with it, not in the tray.
      if let taken {
        tray.release(taken)
      }

      notice = .failed(ChatResolver.describe(error))
    }
  }

  /// Stop the running turn. The partial reply stays; it was really said.
  public func stop() async {
    guard !isStopping else {
      return
    }

    isStopping = true

    defer {
      isStopping = false
    }

    do {
      try await chat.store.stopTurn(bot)
      announce(.stopped)
    } catch {
      notice = .stopFailed(ChatResolver.describe(error))
    }
  }

  /// Hand a parked message to the running turn now. One the gateway did not
  /// take goes back in the queue (`steerQueued`), and the reader is told.
  public func steerQueued(_ id: String) async {
    do {
      if try await chat.store.steerQueued(bot, id) == .rejected {
        notice = .steerRejected
      }
    } catch let error as ChatRuntimeError where error.isNotAttached {
      // Refused before anything moved (no session, or a `/new` running): the
      // message is still in the queue.
      notice = .notSent(error.message)
    } catch {
      notice = .steerRejected
    }
  }

  /// Take a parked message out of the queue.
  public func removeQueued(_ id: String) async {
    await chat.store.deleteQueued(bot, id)
  }

  /// Take a parked message back into the field, after whatever is there.
  public func editQueued(_ id: String) async {
    guard let text = await chat.store.editQueued(bot, id) else {
      return
    }

    putDraft(draft.isEmpty ? text : draft + "\n" + text)
  }

  private func runConversationCommand(_ command: ConversationCommand, body: String) async {
    guard canSend else {
      notice = .notSent(ChatRuntimeError.notAttached(bot).message)
      return
    }

    notice = nil
    sendsInFlight += 1
    draft = ""

    defer {
      sendsInFlight -= 1
    }

    do {
      try await chat.store.startNewConversation(bot, argument: command.argument, command: command.name)
    } catch is ConversationBusyError {
      restore(body)
      notice = .busy
    } catch let error as ChatRuntimeError where error.isNotAttached {
      restore(body)
      notice = .notSent(error.message)
    } catch {
      restore(body)
      notice = .other(ChatResolver.describe(error))
    }
  }

  private func restore(_ body: String) {
    if draft.isEmpty {
      putDraft(body)
    }
  }

  func announce(_ event: ComposerEvent) {
    eventSerial += 1
    lastEvent = ComposerEventEntry(event: event, serial: eventSerial)
  }

  // MARK: - Commands

  struct ConversationCommand: Equatable {
    var name: String
    var argument: String
  }

  /// `/new`, `/reset` or `/clear`, with whatever follows it, or nil.
  static func conversationCommand(_ text: String) -> ConversationCommand? {
    guard text.hasPrefix("/") else {
      return nil
    }

    let head = text.prefix { !$0.isWhitespace }
    let name = head.lowercased()

    guard ["/new", "/reset", "/clear"].contains(name) else {
      return nil
    }

    let argument = text.dropFirst(head.count).trimmingCharacters(in: .whitespacesAndNewlines)
    return ConversationCommand(name: name, argument: argument)
  }
}
