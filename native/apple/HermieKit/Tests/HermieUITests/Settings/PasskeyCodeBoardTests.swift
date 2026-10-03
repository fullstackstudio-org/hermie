import Testing

@testable import HermieUI

#if os(macOS)
  import AppKit

  @MainActor
  @Suite("The pasteboard of an invite code on the Mac")
  struct PasskeyCodeBoardTests {
    private func board() -> NSPasteboard {
      NSPasteboard(name: NSPasteboard.Name("hermie.test.\(UUID().uuidString)"))
    }

    @Test("the code is written with the concealed and transient markers")
    func markers() {
      let board = board()
      defer { board.releaseGlobally() }
      _ = PasskeyCodeBoard.write("ABCDE-12345", to: board)

      #expect(board.string(forType: .string) == "ABCDE-12345")
      let types = board.types?.map(\.rawValue) ?? []
      #expect(types.contains(PasskeyCodeBoard.concealedType))
      #expect(types.contains(PasskeyCodeBoard.transientType))
    }

    @Test("it is cleared when it expires while the pasteboard still holds it")
    func clearsOnExpiry() {
      let board = board()
      defer { board.releaseGlobally() }
      let written = PasskeyCodeBoard.write("ABCDE-12345", to: board)

      PasskeyCodeBoard.clearIfUnchanged(board, written: written, code: "ABCDE-12345")
      #expect(board.string(forType: .string) == nil)
    }

    @Test("it is left alone when something else was copied meanwhile")
    func leavesOthersAlone() {
      let board = board()
      defer { board.releaseGlobally() }
      let written = PasskeyCodeBoard.write("ABCDE-12345", to: board)

      board.clearContents()
      board.setString("something else", forType: .string)
      PasskeyCodeBoard.clearIfUnchanged(board, written: written, code: "ABCDE-12345")
      #expect(board.string(forType: .string) == "something else")
    }
  }
#endif
