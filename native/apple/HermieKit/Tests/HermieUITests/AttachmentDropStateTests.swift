import Testing

@testable import HermieUI

/// The overlay's single source of truth: whatever way a drag over the chat ends, it is hidden.
@MainActor
@Suite struct AttachmentDropStateTests {
  @Test func startsHidden() {
    #expect(AttachmentDropState().hint == nil)
  }

  @Test func enterThenDropIsHidden() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    #expect(state.hint == .attach)

    state.updated(blocked: false)
    state.dropped()
    #expect(state.hint == nil)
  }

  @Test func enterThenExitIsHidden() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.exited()

    #expect(state.hint == nil)
  }

  @Test func aNestedEnterAndExitThenADropIsHidden() {
    var state = AttachmentDropState()

    // The outer target is entered, an inner one takes the drag and the outer is told it left, the
    // drag comes back to the outer one, and is dropped there.
    state.entered(blocked: false)
    state.exited()
    state.entered(blocked: false)
    state.updated(blocked: false)
    state.dropped()

    #expect(state.hint == nil)
  }

  @Test func aNestedViewThatConsumesTheDragEndsItWithAnExit() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.exited()

    #expect(state.hint == nil)
  }

  @Test func aRefusedDropIsHidden() {
    var state = AttachmentDropState()

    // A request has the composer: shown as blocked, and the drop is refused.
    state.entered(blocked: true)
    #expect(state.hint == .blocked)

    state.dropped()
    #expect(state.hint == nil)
  }

  @Test func theHintFollowsARequestComingAndGoingMidDrag() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.updated(blocked: true)
    #expect(state.hint == .blocked)

    state.updated(blocked: false)
    #expect(state.hint == .attach)
  }

  @Test func anUpdateThatArrivesAfterTheDropDoesNotBringTheOverlayBack() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.dropped()
    state.updated(blocked: false)
    #expect(state.hint == nil)

    state.entered(blocked: false)
    state.exited()
    state.updated(blocked: false)
    #expect(state.hint == nil)
  }

  @Test func aNewDragAfterAnEndedOneShowsAgain() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.dropped()
    state.entered(blocked: false)

    #expect(state.hint == .attach)
  }

  @Test func theSafetyNetHidesAnOverlayWhoseDragIsGone() {
    var state = AttachmentDropState()

    state.entered(blocked: false)
    state.tick(dragIsLive: true)
    #expect(state.hint == .attach)

    // Cancelled with Esc, or taken out of the window, with no exit sent.
    state.tick(dragIsLive: false)
    #expect(state.hint == nil)

    // And does not come back by a late update.
    state.updated(blocked: false)
    #expect(state.hint == nil)
  }

  @Test func losingTheDragFromAnywhereHidesIt() {
    var state = AttachmentDropState()

    state.entered(blocked: true)
    state.lost()

    #expect(state.hint == nil)
  }
}
