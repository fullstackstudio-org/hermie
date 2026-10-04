import CoreGraphics
import Testing

@testable import HermieUI

#if os(iOS)
  import SwiftUI
  import UIKit
#elseif os(macOS)
  import AppKit
  import SwiftUI
#endif

/// Leaving a chat tears the transcript list down while things it started are still queued: a
/// row's height report is applied on the next turn of the main queue, and the layout and the
/// collection view that block holds can outlive the coordinator. The hooks the coordinator
/// installed on them must not then reach a coordinator that is gone (an unowned reference to it
/// aborted the app on swipe-back, `swift_abortRetainUnowned`). These tests would crash the test
/// process with the old hooks and pass with the weak ones.
#if os(iOS) || os(macOS)
  private struct Line: Identifiable, Equatable, Sendable {
    let id: Int
  }

  /// Lets everything already queued on the main queue run first.
  @MainActor
  private func drainMainQueue() async {
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      DispatchQueue.main.async { done.resume() }
    }
  }
#endif

#if os(iOS)
  @MainActor
  @Suite struct TranscriptCoordinatorTeardownTests {
    private func make() -> CollectionTranscriptCoordinator<Line, Text> {
      CollectionTranscriptCoordinator(state: TranscriptListState()) { Text("row \($0.id)") }
    }

    @Test func aQueuedHeightReportAfterTheCoordinatorIsGoneDoesNotCrash() async {
      var coordinator: CollectionTranscriptCoordinator<Line, Text>? = make()
      weak let released = coordinator
      // What outlives the screen: the layout and the collection view the queued block holds.
      let layout = coordinator!.layout
      let collectionView = coordinator!.collectionView

      layout.model.setIDs([1, 2, 3])
      layout.rowReported(2, height: 120)
      coordinator = nil

      await drainMainQueue()

      #expect(released == nil, "the coordinator must be gone for this to prove anything")
      #expect(layout.collectionView === collectionView)
    }

    @Test func theHooksOnTheSurvivingLayoutAnswerSafelyOnceTheCoordinatorIsGone() {
      var coordinator: CollectionTranscriptCoordinator<Line, Text>? = make()
      let layout = coordinator!.layout
      let collectionView = coordinator!.collectionView
      coordinator = nil

      #expect(layout.isPinnedToBottom() == false)
      #expect(layout.measure(0) == nil)
      collectionView.willResize?()
      collectionView.resizeDropped?()
      collectionView.resize?(CGSize(width: 320, height: 600), CGSize(width: 390, height: 600))
      collectionView.didLayoutResize?()
      collectionView.didMoveIntoWindow?()
    }
  }
#elseif os(macOS)
  @MainActor
  @Suite struct TranscriptCoordinatorTeardownTests {
    private func make() -> MacTranscriptCoordinator<Line, Text> {
      MacTranscriptCoordinator(state: TranscriptListState()) { Text("row \($0.id)") }
    }

    @Test func theScrollViewHooksAnswerSafelyOnceTheCoordinatorIsGone() async {
      var coordinator: MacTranscriptCoordinator<Line, Text>? = make()
      weak let released = coordinator
      // What outlives the screen: the scroll view the system is still tearing down.
      let scrollView = coordinator!.scrollView
      coordinator = nil

      await drainMainQueue()

      #expect(released == nil, "the coordinator must be gone for this to prove anything")
      scrollView.willResize?(CGSize(width: 320, height: 600), CGSize(width: 390, height: 600))
      scrollView.didResize?(CGSize(width: 320, height: 600), CGSize(width: 390, height: 600))
      scrollView.didScrollByReader?()
    }
  }
#endif
