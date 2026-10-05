import HermieCore
import Observation
import SwiftUI

/**
 A conversation opened from a search hit, looking for the row the words are in (`ChatFindWalk`, the
 same walk the chat runs): found, the list scrolls to the row and marks it for a moment; not found yet
 and the first page not in, it waits; not found and loaded, one more older page is read and the rows
 are looked at again once they have been rebuilt. Bounded, and says "not in the visible text" when the
 history runs out or the bound is hit.

 The viewer is read-only and nothing in it is live, so this is the chat's `find` without the parts that
 belong to a live chat: the rows are the viewer's own, the older pages are the viewer model's.
 */
@MainActor
@Observable
final class ConversationFinder {
  /// The row that is marked now.
  private(set) var flashID: String?
  /// What is said when the words were not found, until it goes by itself.
  private(set) var notice: String?

  /// How long the found row stays marked, and how long the notice stays up; the tests set their own.
  @ObservationIgnored var flashDuration: Duration = .seconds(2.5)
  @ObservationIgnored var noticeDuration: Duration = .seconds(8)
  /// How often a find that is waiting for the list to lay out its first rows looks again.
  @ObservationIgnored var retryInterval: Duration = .milliseconds(100)

  @ObservationIgnored private var walk: ChatFindWalk?
  @ObservationIgnored private var requestID: Int?
  @ObservationIgnored private var settle: (@MainActor (Int) -> Void)?
  @ObservationIgnored private var rows = TranscriptListItems<TranscriptRow>()
  @ObservationIgnored private var revision = 0
  @ObservationIgnored private var retries = 0
  @ObservationIgnored private var retryTask: Task<Void, Never>?
  @ObservationIgnored private var flashTask: Task<Void, Never>?
  @ObservationIgnored private var noticeTask: Task<Void, Never>?
  @ObservationIgnored private var stopped = false

  init() {}

  /// Look for `request`'s words in the conversation. A request this finder has taken already is
  /// ignored; a newer one replaces a walk still under way.
  ///
  /// - Parameter settle: called once, with the request's id, when it is dealt with (the row shown, or
  ///   the words not found) or the screen goes before that.
  func find(
    _ request: ConversationFindRequest, model: ConversationViewerModel, listState: TranscriptListState,
    settle: @escaping @MainActor (Int) -> Void
  ) {
    guard request.id != requestID else {
      return
    }

    stopped = false
    abandon()
    clearNotice()
    retries = 0
    requestID = request.id
    self.settle = settle

    let walk = ChatFindWalk(
      query: request.query,
      hooks: .conversation(
        model,
        reveal: { [weak self] id in self?.reveal(itemID: id, listState: listState, model: model) ?? false },
        revision: { [weak self] in self?.revision ?? 0 },
        // What the rows draw, so that whatever is found has a row to scroll to.
        items: { [weak self] in self?.rows.flatMap(\.items) ?? [] }
      ),
      onSettled: { [weak self] outcome in self?.settled(outcome, request: request) }
    )
    self.walk = walk
    walk.step()
  }

  /// The rows were rebuilt (the first page arrived, an older one was put in front): look again.
  func rowsChanged(_ rows: TranscriptListItems<TranscriptRow>) {
    self.rows = rows
    revision += 1
    walk?.step()
  }

  /// The screen goes: nothing is reported, and every pending look is dropped.
  func stop() {
    stopped = true
    abandon()
    flashTask?.cancel()
    flashTask = nil
    noticeTask?.cancel()
    noticeTask = nil
  }

  /// `rows` with the found row marked, while there is one: only that row's value differs.
  func marked(_ rows: TranscriptListItems<TranscriptRow>) -> TranscriptListItems<TranscriptRow> {
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

  // MARK: The walk

  /// Scroll to the row that draws the item and mark it. False when the list has no such row yet or has
  /// not laid out: a scroll asked for before that is dropped, so the walk looks again by itself.
  private func reveal(itemID: String, listState: TranscriptListState, model: ConversationViewerModel) -> Bool {
    guard let row = rows.first(where: { $0.holds(itemID: itemID) }) else {
      return false
    }

    guard listState.rowsLaidOut else {
      retrySoon()
      return false
    }

    // Unanimated: the row may be hundreds of rows away, among heights that are still estimates.
    listState.scroll(to: row.id, anchor: ChatFeed.findAnchor, animated: false)
    flash(itemID)
    return true
  }

  private func retrySoon() {
    guard retryTask == nil, retries < 100 else {
      return
    }

    retries += 1
    let interval = retryInterval
    retryTask = Task { [weak self] in
      try? await Task.sleep(for: interval)

      guard !Task.isCancelled, let self else { return }

      self.retryTask = nil
      self.walk?.step()
    }
  }

  private func settled(_ outcome: ChatFindWalk.Outcome, request: ConversationFindRequest) {
    walk = nil

    switch outcome {
    case .found:
      AccessibilityNotification.Announcement(NativeStrings.Search.found(query: request.query)).post()
    case .notFound:
      let words = Strings.App.Chat.findExhausted(query: request.query)

      notice = words
      AccessibilityNotification.Announcement(words).post()
      noticeTask?.cancel()

      let duration = noticeDuration

      noticeTask = Task { [weak self] in
        try? await Task.sleep(for: duration)

        guard !Task.isCancelled else { return }
        self?.clearNotice()
      }
    }

    settleRequest()
  }

  private func flash(_ itemID: String) {
    flashID = itemID
    flashTask?.cancel()

    let duration = flashDuration

    flashTask = Task { [weak self] in
      try? await Task.sleep(for: duration)

      guard !Task.isCancelled, let self, !self.stopped else { return }

      self.flashID = nil
    }
  }

  private func clearNotice() {
    noticeTask?.cancel()
    noticeTask = nil

    if notice != nil {
      notice = nil
    }
  }

  private func abandon() {
    walk?.cancel()
    walk = nil
    retryTask?.cancel()
    retryTask = nil
    settleRequest()
  }

  private func settleRequest() {
    if let id = requestID, let settle {
      self.settle = nil
      settle(id)
    }
  }
}
