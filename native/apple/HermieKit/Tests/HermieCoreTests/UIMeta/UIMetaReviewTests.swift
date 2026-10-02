import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The ui_meta findings of the push row review: what naming the person and signing out keep.
@Suite("ui_meta: naming the person and signing out")
struct UIMetaReviewTests {
  @Test("in the app's real order (load, then name the person) an unsent app edit is kept and sent")
  func loadThenName() async {
    let gateway = HoldingGateway()
    let persistence = MemoryPersistence(
      UIMetaStoredCopy(documents: UIMetaDocuments(app: ["v": 1, "textSize": "large"]), owner: owner, pendingApp: true)
    )

    var options = UIMetaSync.Options()
    options.debounce = nil
    let sync = UIMetaSync(gateway: gateway.gateway, persistence: persistence, options: options)

    await sync.load()
    sync.setUser(owner)
    #expect(sync.pending)

    await sync.reconcile()
    #expect(gateway.meta("researcher")[ownerKey]?["textSize"] == "large")
  }

  @Test("a different person still drops the app edit")
  func anotherPerson() {
    var state = UIMetaState()
    state.setUser("a")
    state.markApp()
    state.setUser("b")
    #expect(!state.dirtyApp)
  }

  @Test("signing out keeps the pending bot edits; bot sections outlive the person")
  func signOutKeepsBots() {
    var state = UIMetaState()
    state.setUser("a")
    state.markBot("researcher")
    state.markApp()
    state.reset()

    #expect(state.dirtyBots == ["researcher"])
    #expect(!state.dirtyApp)
  }
}
