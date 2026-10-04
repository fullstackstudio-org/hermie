import Foundation
import HermieTranscript

/// A chat opened from a search hit, looking for the row the words are in (`use-find-in-chat.ts`).
///
/// The gateway names the conversation and never the message (`SessionSearch`), so the row is found
/// again here from the words the reader typed (`FindInChat`), in three cases:
///
/// - **found**: the row is revealed (the list scrolls to it) and the walk is done;
/// - **not found yet, and the chat is still arriving**: a miss against a half-loaded transcript is not
///   a miss, so nothing happens until it is live;
/// - **not found, and the chat is live**: one more page of older history is loaded and the rows are
///   looked at again once the page is in. That is a loop without being written as one, and it walks
///   back a page at a time.
///
/// The walk is BOUNDED (`FindInChat.pageLimit`), and the bound is not timidity. The gateway's index is
/// built over the JSON-encoded message and this searches the projected item, so a hit on a tool's
/// arguments can never be found here however far back it reads; an unbounded walk on that query would
/// page to the start of a thousand-turn conversation and then apologise anyway. "Not in the visible
/// text of this chat" is the sentence for both ways of stopping, because they are the same fact to the
/// reader. Scrolling to the bottom with no explanation is how a working search reads as a broken one.
///
/// It is driven, not running: `step()` looks at the rows as they are now and does the next thing. The
/// owner calls it when the request arrives and after every rebuild of the rows, which is what keeps a
/// page that lands after the load returned from being missed.
@MainActor
public final class ChatFindWalk {
  public enum Outcome: Sendable, Equatable {
    /// The row holding the newest match was revealed.
    case found(itemID: String)
    /// Not in the visible text of this chat, whether the history ran out or the walk hit its bound.
    case notFound
  }

  public struct Hooks {
    /// The rows on screen, oldest first (the items a row groups included).
    public var items: @MainActor () -> [VisibleItem]
    /// The chat is loaded (live or stale): a miss now is a miss.
    public var loaded: @MainActor () -> Bool
    /// Scroll to the row that holds the item. False when the list does not have it yet: it is asked again.
    public var reveal: @MainActor (_ itemID: String) -> Bool
    /// One more page of older history.
    public var loadOlder: @MainActor () async -> OlderHistory
    /// Moves every time the rows are rebuilt, so a page drawn while its load was waiting is noticed.
    public var revision: @MainActor () -> Int

    public init(
      items: @escaping @MainActor () -> [VisibleItem],
      loaded: @escaping @MainActor () -> Bool,
      reveal: @escaping @MainActor (String) -> Bool,
      loadOlder: @escaping @MainActor () async -> OlderHistory,
      revision: @escaping @MainActor () -> Int
    ) {
      self.items = items
      self.loaded = loaded
      self.reveal = reveal
      self.loadOlder = loadOlder
      self.revision = revision
    }
  }

  /// The words, as typed (trimmed).
  public let query: String
  public let hooks: Hooks
  public let pageLimit: Int
  /// Pages loaded so far.
  public private(set) var pages = 0
  public private(set) var outcome: Outcome?

  private let settle: @MainActor (Outcome) -> Void
  private var loading = false
  private var cancelled = false
  private var task: Task<Void, Never>?

  public init(
    query: String,
    hooks: Hooks,
    pageLimit: Int = FindInChat.pageLimit,
    onSettled settle: @escaping @MainActor (Outcome) -> Void
  ) {
    self.query = query
    self.hooks = hooks
    self.pageLimit = pageLimit
    self.settle = settle
  }

  /// Look at the rows as they are and do the next thing. Safe to call as often as the rows change.
  public func step() {
    guard outcome == nil, !loading, !cancelled else {
      return
    }

    if let found = FindInChat.newestMatch(in: hooks.items(), query: query) {
      if hooks.reveal(found) {
        finish(.found(itemID: found))
      }

      return
    }

    // Still arriving: a miss against a half-loaded transcript is not a miss.
    guard hooks.loaded() else {
      return
    }

    guard pages < pageLimit else {
      finish(.notFound)
      return
    }

    pages += 1
    loading = true

    let before = hooks.revision()

    task = Task { [weak self] in
      guard let self else { return }

      let result = await self.hooks.loadOlder()

      self.loading = false

      guard !self.cancelled, self.outcome == nil else {
        return
      }

      if result != .grew {
        self.finish(.notFound)
      } else if self.hooks.revision() != before {
        // The page was drawn while this waited, and that rebuild found the walk busy: look now.
        self.step()
      }
      // Otherwise the page is drawn after this, and that rebuild looks again.
    }
  }

  /// The chat screen is going or the request was replaced: no more steps, and nothing is reported.
  public func cancel() {
    cancelled = true
    task?.cancel()
    task = nil
    loading = false
  }

  private func finish(_ result: Outcome) {
    outcome = result
    settle(result)
  }
}

extension ChatFindWalk.Hooks {
  /// The walk's view of one chat: its visible items, whether it is loaded (live or stale), and one page
  /// of older history at a time. `reveal` and `revision` are the screen's: only it knows which row
  /// holds an item and when its rows were last rebuilt. A screen that searches the items its rows draw,
  /// rather than the chat's, so that what is found always has a row to scroll to, passes them as `items`.
  public static func chat(
    _ model: ChatModel,
    reveal: @escaping @MainActor (String) -> Bool,
    revision: @escaping @MainActor () -> Int,
    items: (@MainActor () -> [VisibleItem])? = nil,
    loadOlder: (@MainActor () async -> OlderHistory)? = nil
  ) -> ChatFindWalk.Hooks {
    ChatFindWalk.Hooks(
      items: items ?? { model.items },
      loaded: { model.hydration == .live || model.hydration == .stale },
      reveal: reveal,
      loadOlder: loadOlder ?? { await model.loadOlder() },
      revision: revision
    )
  }
}
