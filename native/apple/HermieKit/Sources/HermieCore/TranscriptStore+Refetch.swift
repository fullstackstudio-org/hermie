import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript

/// Whether a `session.events.since` answer vouches for the chat it was asked for.
///
/// Anything but `continuous` means events happened that this chat never applied
/// and the replay does not carry: the chat is read again (`refetch`) unless a
/// history read just ran.
enum ReplayContinuity: Sendable, Equatable {
  /// Every event after the watermark was in the answer (and applied).
  case continuous
  /// `truncated: true`: the gateway's ring evicted (or never kept) an event after the watermark.
  case truncated
  /// The answer came from another gateway process, which numbered from 1 again.
  case epochChanged
  /// The chat had no watermark and the session has numbered events it never saw.
  case unseen
}

// The full re-fetch: what makes a chat whole again when a replay cannot.
//
// A reconnect replay is an optimisation over a history read. When it cannot
// vouch for itself (the connection's own replay reports a `ReplayGap`, or the
// store's replay in `recover` answers anything but `continuous`, or the chat
// came back on another runtime session) the chat is resumed and its history read
// again through `load`, the same path `hydrate` takes: on the chat's ordered
// lane, with the generation checks, the resume's in-flight snapshot and open
// requests re-applied, and the history reconciled onto what is there (ids kept,
// nothing doubled). The queue and the draft are not part of a chat's state, so
// nothing here touches them.
extension TranscriptStore {
  /// The connection's replay left a hole in this session.
  func noteGap(_ gap: ReplayGap) {
    guard !isShutDown, let key = routes[gap.sessionID], chats[key]?.live == true else {
      return
    }

    scheduleRefetch(key)
  }

  /// Read the chat again once; a request while one runs makes it run once more
  /// after, so the last one asked for is always a read that started after it.
  func scheduleRefetch(_ key: String) {
    guard !isShutDown else {
      return
    }

    if refetching.contains(key) {
      refetchAgain.insert(key)
      return
    }

    refetching.insert(key)
    spawn { store in await store.runRefetches(key) }
  }

  func runRefetches(_ key: String) async {
    repeat {
      refetchAgain.remove(key)
      await refetch(key)
    } while refetchAgain.contains(key) && !isShutDown

    refetching.remove(key)
  }

  /// One full re-fetch of a live chat: resume, history, the replay, then live.
  /// Registered as the chat's hydration, so an `open` meanwhile joins it rather
  /// than starting another. A resume that fails leaves the chat `stale`, which
  /// the next open or reconnect reads again.
  func refetch(_ key: String) async {
    await waitForOpening(key)

    guard !isShutDown, let record = chats[key], record.live, !record.state.storedSessionID.isEmpty else {
      return
    }

    let state = record.state
    let canonical = CanonicalSession(
      id: state.storedSessionID,
      resolvedID: state.resolvedSessionID,
      messageCount: countPersistedRows(state)
    )
    let ticket = generation(of: key)
    let task = Task { try await self.load(key, canonical, generation: ticket, failure: .stale) }

    opening[key] = Opening(task: task, storedID: canonical.id)

    defer {
      if opening[key]?.task == task {
        opening[key] = nil
      }
    }

    _ = try? await task.value
  }

  /// Whether a re-fetch of this chat is running or waiting (for tests).
  func isRefetching(_ key: String) -> Bool {
    refetching.contains(key)
  }

  /// Whether another re-fetch is due after the running one (for tests).
  func isRefetchQueued(_ key: String) -> Bool {
    refetchAgain.contains(key)
  }
}
