#if os(macOS)
  import AppKit
  import Testing

  @testable import HermieUI

  /// The Mac composer's keys, on its text view itself: Return and
  /// Command-Return send, Shift-Return starts a new line, Esc goes to the
  /// composer. (The iPad's are the same rules on `UIKeyCommand`s; the simulator
  /// does not deliver synthesized keys, see `ComposerUITests`.)
  @MainActor
  @Suite struct ComposerKeyTests {
    private final class Recorder {
      var sends = 0
      var escapes = 0
      var escapeHandled = true
    }

    private func makeField() -> (KeyTextView, Recorder, NSWindow) {
      let recorder = Recorder()
      let view = KeyTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
      view.onSend = { recorder.sends += 1 }
      view.onEscape = {
        recorder.escapes += 1
        return recorder.escapeHandled
      }
      let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: true)
      window.contentView = view
      window.makeFirstResponder(view)
      view.string = "hello"
      view.setSelectedRange(NSRange(location: 5, length: 0))
      return (view, recorder, window)
    }

    private func key(
      _ keyCode: UInt16,
      _ characters: String,
      _ flags: NSEvent.ModifierFlags = [],
      in window: NSWindow
    ) throws -> NSEvent {
      try #require(
        NSEvent.keyEvent(
          with: .keyDown,
          location: .zero,
          modifierFlags: flags,
          timestamp: 0,
          windowNumber: window.windowNumber,
          context: nil,
          characters: characters,
          charactersIgnoringModifiers: characters,
          isARepeat: false,
          keyCode: keyCode
        )
      )
    }

    @Test func returnSendsAndLeavesTheTextAlone() throws {
      let (view, recorder, window) = makeField()
      view.keyDown(with: try key(36, "\r", in: window))
      #expect(recorder.sends == 1)
      #expect(view.string == "hello")
    }

    @Test func shiftReturnStartsANewLineAndDoesNotSend() throws {
      let (view, recorder, window) = makeField()
      view.keyDown(with: try key(36, "\r", .shift, in: window))
      #expect(recorder.sends == 0)
      #expect(view.string == "hello\n")
    }

    @Test func commandReturnSends() throws {
      let (view, recorder, window) = makeField()
      #expect(view.performKeyEquivalent(with: try key(36, "\r", .command, in: window)))
      #expect(recorder.sends == 1)
      #expect(view.string == "hello")
    }

    @Test func enterOnTheKeypadSendsToo() throws {
      let (view, recorder, window) = makeField()
      view.keyDown(with: try key(76, "\u{3}", in: window))
      #expect(recorder.sends == 1)
    }

    @Test func escapeGoesToTheComposerAndNeverClearsTheText() throws {
      let (view, recorder, window) = makeField()
      view.keyDown(with: try key(53, "\u{1b}", in: window))
      #expect(recorder.escapes == 1)
      #expect(view.string == "hello")

      recorder.escapeHandled = false
      view.keyDown(with: try key(53, "\u{1b}", in: window))
      #expect(recorder.escapes == 2)
      #expect(view.string == "hello")
    }
  }
#endif
