#if os(iOS)
  import Testing
  import UIKit

  @testable import HermieUI

  /// The draft editor on iOS: its text container is as wide as the longest line, so the content
  /// scrolls sideways exactly as far as the text goes.
  @MainActor
  @Suite("The draft editor on iOS")
  struct NoWrapEditorIOSTests {
    private func editor(_ text: String, width: CGFloat = 320, editable: Bool = true) -> NoWrapUITextView {
      let view = NoWrapUITextView(usingTextLayoutManager: false)
      NoWrapTextEditor.configure(view, editable: editable)
      view.frame = CGRect(x: 0, y: 0, width: width, height: 260)
      view.text = text
      view.layoutIfNeeded()
      return view
    }

    @Test("a 600-character line makes the content wider than the view and far narrower than the measuring width")
    func longLineScrolls() {
      let view = editor(String(repeating: "x", count: 600))

      #expect(view.contentSize.width > view.bounds.width, "\(view.contentSize)")
      #expect(view.contentSize.width < NoWrapTextEditor.containerWidth, "\(view.contentSize)")
      // As wide as the line, to within a few characters: no large empty area after it.
      let glyph = ("x" as NSString).size(withAttributes: [.font: view.font as Any]).width
      #expect(view.contentSize.width < glyph * 620 + 40, "\(view.contentSize.width) for \(glyph * 600)")
      #expect(view.contentSize.width > glyph * 600, "every character is reachable")
      #expect(view.textContainer.lineBreakMode == .byClipping)
    }

    @Test("a short text keeps the content at the view's width, and the longest of several lines decides")
    func shortAndSeveral() {
      let short = editor("short\nlines")
      #expect(short.contentSize.width <= short.bounds.width + 0.5, "\(short.contentSize)")

      let several = editor("a\n" + String(repeating: "y", count: 300) + "\n" + String(repeating: "z", count: 700))
      let wide = several.contentSize.width

      several.text = "a\n" + String(repeating: "y", count: 300)
      several.textChanged()
      several.layoutIfNeeded()
      #expect(several.contentSize.width < wide, "the content follows the text when the longest line goes")
      #expect(several.contentSize.width > several.bounds.width)
    }

    @Test("a read-only text fits its height, and corrects nothing")
    func readOnly() {
      let view = editor("one\ntwo\nthree", editable: false)
      #expect(!view.isEditable)
      #expect(view.fittingHeight() > 40 && view.fittingHeight() < 200)
      #expect(view.autocorrectionType == .no)
      #expect(view.smartQuotesType == .no)
      #expect(view.smartDashesType == .no)
      #expect(view.dataDetectorTypes.isEmpty)
      #expect(!view.textContainer.widthTracksTextView)
    }
  }
#endif
