import Foundation
import HermieCore
import Testing

@testable import HermieUI

/// The chat list publishes a `ChatListFocus` at every body. On iOS 26 one that never compares equal
/// to the last re-runs the Chat menu's commands and, through them, the list's body, without end: the
/// launch crash of 0.2.10 to 0.2.14 on iOS 26.x, at the first chat list a launch showed. So two
/// bodies of one list that show the same thing must publish equal values.
@MainActor
@Suite("The chat list's focused value")
struct ChatListFocusTests {
  private let owner = UUID()
  private let arrangement = ChatArrangementModel(now: { 0 })
  private let roster = ["a", "b", "c"]

  /// What `SessionChatList.focus` publishes at one body: everything rebuilt, the closure new.
  private func body(
    owner: UUID? = nil, gateway: String = "g1", arrangement: ChatArrangementModel? = nil, roster: [String]? = nil,
    movable: Bool = true, asks: Bool = true
  ) -> ChatListFocus {
    let arrangement = arrangement ?? self.arrangement
    let roster = roster ?? self.roster
    let sections: ChatListSections<String> = arrangement.arrangement.sections(roster) { $0 }
    // A new closure at every body, as the list's `{ naming = .new(chat: $0) }` is.
    var ask: (@MainActor (String) -> Void)?
    if asks {
      ask = { _ in }
    }

    return ChatListFocus(
      owner: owner ?? self.owner,
      gatewayID: gateway,
      arrangement: arrangement,
      roster: roster,
      moves: movable ? sections.moves : .none,
      askNewFolder: ask
    )
  }

  @Test("two bodies of one list that show the same thing publish equal values")
  func steadyAcrossBodies() {
    #expect(body() == body())
    #expect(body(movable: false) == body(movable: false))
    #expect(body(asks: false) == body(asks: false))
  }

  @Test("anything the commands act on makes it a new value")
  func changes() {
    #expect(body() != body(owner: UUID()), "another list")
    #expect(body() != body(gateway: "g2"))
    #expect(body() != body(arrangement: ChatArrangementModel(now: { 0 })), "another arrangement")
    #expect(body() != body(roster: ["a", "b"]))
    #expect(body() != body(roster: ["b", "a", "c"]), "the steps changed")
    #expect(body() != body(movable: false), "a search narrowed the list")
    #expect(body() != body(asks: false))
  }

  @Test("the steps are the list's own")
  func steps() {
    let focus = body()
    let sections: ChatListSections<String> = arrangement.arrangement.sections(roster) { $0 }

    for name in roster + ["unknown"] {
      #expect(focus.steps(name).up == sections.steps(of: name).up)
      #expect(focus.steps(name).down == sections.steps(of: name).down)
    }

    #expect(focus.steps("a").down == .after("b"))
    #expect(focus.steps("b").up == .before("a"))
    #expect(body(movable: false).steps("b").up == nil)
    #expect(body(movable: false).steps("a").down == nil)
  }
}
