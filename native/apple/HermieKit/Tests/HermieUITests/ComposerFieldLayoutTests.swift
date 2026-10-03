#if os(macOS)
  import AppKit
  import SwiftUI
  import Testing

  @testable import HermieUI

  /// What is typed in the Mac composer stays laid out where it is drawn, whatever SwiftUI asks
  /// the field while it sizes it.
  ///
  /// SwiftUI sizes the field with probe proposals as well as the real one: a width of 0, and an
  /// infinite width, in passes such as the one a window's activation causes. The field used to
  /// answer by setting its live text container to the proposed width. The last probe won, and the
  /// text view's frame did not change, so `widthTracksTextView` never put the width back: after a
  /// 0-wide probe the text was laid out in a container of no width and drew nothing. That was the
  /// owner's "I cannot see what I type" in the Mac app.
  @MainActor
  @Suite(.serialized) struct ComposerFieldLayoutTests {
    /// The field as the app builds it, 320 points wide in a window, with text in it.
    private func makeField(_ text: String = "Can you see what I am typing here?") -> (NSTextView, NSScrollView, NSWindow) {
      let scroll = ComposerTextField.makeScrollView()
      scroll.frame = NSRect(x: 0, y: 0, width: 320, height: 40)
      let window = NSWindow(contentRect: scroll.frame, styleMask: [.titled], backing: .buffered, defer: true)
      window.isReleasedWhenClosed = false
      window.contentView = scroll
      let textView = scroll.documentView as! NSTextView
      textView.frame = NSRect(x: 0, y: 0, width: 320, height: 40)
      textView.string = text
      return (textView, scroll, window)
    }

    /// The glyphs' bounding box, laid out as the text view would draw them now.
    private func drawnRect(_ textView: NSTextView) throws -> NSRect {
      let layout = try #require(textView.layoutManager)
      let container = try #require(textView.textContainer)
      layout.ensureLayout(for: container)
      return layout.boundingRect(forGlyphRange: layout.glyphRange(for: container), in: container)
    }

    @Test(arguments: [CGFloat(0), .infinity, 120])
    func probingTheSizeLeavesTheTextLaidOutAtTheFieldsWidth(probe: CGFloat) throws {
      let (textView, _, window) = makeField()
      defer { window.close() }
      let before = try drawnRect(textView)
      #expect(before.width > 100, "the text is laid out on one line before the probe")

      _ = ComposerTextField.fittingSize(of: textView, width: probe, maxLines: 6)

      let container = try #require(textView.textContainer)
      #expect(container.containerSize.width == textView.frame.width - textView.textContainerInset.width * 2)
      #expect(try drawnRect(textView) == before, "the probe moved the text the view draws")
    }

    @Test func theAnswerFollowsTheTextAtTheProposedWidth() throws {
      let (textView, _, window) = makeField("one")
      defer { window.close() }
      let one = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))

      textView.string = String(repeating: "a long line of words ", count: 12)
      let wrapped = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))
      let narrow = try #require(ComposerTextField.fittingSize(of: textView, width: 160, maxLines: 6))
      #expect(wrapped.height > one.height, "more lines, taller")
      #expect(narrow.height >= wrapped.height, "narrower, at least as tall")
      #expect(wrapped.width == 320)

      textView.string = String(repeating: "line\n", count: 40)
      let capped = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))
      let font = try #require(textView.font)
      let lineHeight = try #require(textView.layoutManager).defaultLineHeight(for: font)
      #expect(capped.height <= (lineHeight * 6 + textView.textContainerInset.height * 2).rounded(.up))
    }

    @Test func aZeroWidthProbeAnswersWithoutLayingTheTextOutInNoSpace() throws {
      let (textView, _, window) = makeField()
      defer { window.close() }
      let size = try #require(ComposerTextField.fittingSize(of: textView, width: 0, maxLines: 6))
      #expect(size.width == 0)
      #expect(size.height > 0)
    }
  }
#endif
