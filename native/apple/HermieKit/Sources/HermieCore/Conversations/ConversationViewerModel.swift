import Foundation
import Observation

import HermieTranscript

/**
 One of a bot's other conversations, read and not answered: a past conversation, or a branch
 (`#/chat/<bot>/s/<id>`, the web client's read-only viewer).

 It reads the transcript off the gateway (`ConversationsBackend.transcript`: the REST route paged
 from the newest row, else `session.history`) and projects it onto the same items the chat draws,
 so a conversation reads the way it did when it was the chat. It is a snapshot: nothing it holds is
 live, nothing is written to the chat cache, no read mark moves, and the bot's own chat is not
 touched.

 Older pages are read on request (`loadOlder`) and placed in front of what is held; a page that
 overlaps the last one adds nothing twice.
 */
@MainActor
@Observable
public final class ConversationViewerModel {
  public enum Phase: Equatable, Sendable {
    case loading
    case ready
    case failed(String)
  }

  public let bot: String
  public let conversation: Conversation

  public private(set) var phase = Phase.loading
  /// What the transcript draws, under `visibility`.
  public private(set) var items: [VisibleItem] = []
  /// Moves whenever `items` changed, for a view that rebuilds rows on it.
  public private(set) var revision = 0
  public private(set) var loadingOlder = false
  /// An older page may exist.
  public private(set) var canLoadOlder = false
  /// Why the last read of an older page failed, in the gateway's words.
  public private(set) var olderError: String?

  public var visibility: VisibilityOptions {
    didSet {
      if visibility != oldValue {
        publish()
      }
    }
  }

  @ObservationIgnored private let backend: any ConversationsBackend
  @ObservationIgnored private var state: ChatState
  /// Rows read so far: where the next older page starts.
  @ObservationIgnored private var rowsRead = 0
  @ObservationIgnored private var loading = false

  /// How many rows one page asks for.
  public static let pageSize = ChatRuntimeLimits.restHistoryLimit

  public init(
    bot: String,
    conversation: Conversation,
    backend: any ConversationsBackend,
    visibility: VisibilityOptions
  ) {
    self.bot = bot
    self.conversation = conversation
    self.backend = backend
    self.visibility = visibility
    self.state = createChatState(bot, conversation.id, conversation.resolvedID)
  }

  /// Read the newest page. Called once when the viewer opens, and again by its "Try again".
  public func load() async {
    guard !loading else {
      return
    }

    loading = true
    defer { loading = false }

    phase = .loading
    state = createChatState(bot, conversation.id, conversation.resolvedID)
    rowsRead = 0

    do {
      let page = try await backend.transcript(
        bot: bot, conversation: conversation, window: MessageWindow(limit: Self.pageSize))

      state = reconcile(state, rowsToItems(page.rows, page.shape))
      rowsRead = page.rows.count
      canLoadOlder = !page.reachedStart && !page.rows.isEmpty
      phase = .ready
      publish()
    } catch {
      phase = .failed(ConversationsModel.words(of: error))
    }
  }

  /// Read the next older page and put it in front. A failure is reported and may be retried.
  public func loadOlder() async {
    guard phase == .ready, canLoadOlder, !loadingOlder, !loading else {
      return
    }

    loadingOlder = true
    olderError = nil
    defer { loadingOlder = false }

    do {
      let page = try await backend.transcript(
        bot: bot, conversation: conversation,
        window: MessageWindow(limit: Self.pageSize, offset: rowsRead))
      let before = state.order.count

      if !page.rows.isEmpty {
        state = prependHistory(state, rowsToItems(page.rows, page.shape))
      }

      rowsRead += page.rows.count
      // A short page is the start; so is one that added nothing (it was all rows already held).
      canLoadOlder = !page.reachedStart && !page.rows.isEmpty && state.order.count > before
      publish()
    } catch {
      olderError = ConversationsModel.words(of: error)
    }
  }

  /**
   One older page for a search that is looking for words in this conversation (`ChatFindWalk`): waits for
   a page already being read rather than racing it, and says where the history came out. A page that
   could not be read ends the walk (`.start`): "not found" is the honest answer when the history cannot
   be read any further, and the reader's own scroll offers the retry.
   */
  public func loadOlderForFind() async -> OlderHistory {
    while loadingOlder || loading {
      try? await Task.sleep(for: .milliseconds(20))
    }

    guard phase == .ready, canLoadOlder else {
      return .start
    }

    let before = rowsRead

    await loadOlder()

    if olderError != nil {
      return .start
    }

    return rowsRead > before ? .grew : .start
  }

  private func publish() {
    items = visibleItems(state, visibility)
    revision += 1
  }
}
