import CoreGraphics
import Foundation
import Testing

@testable import HermieUI

/// How the composer's field is measured.
@MainActor
@Suite struct ComposerFieldMetricsTests {
  @Test(arguments: [16, 17, 20.3, 22, 27.6, 40] as [CGFloat])
  func oneLineMakesExactlyTheControlHeightWithTheSameRoomAboveAndBelow(lineHeight: CGFloat) {
    let control: CGFloat = 56
    let inset = ComposerFieldMetrics.verticalInset(controlHeight: control, lineHeight: lineHeight)

    #expect(abs(lineHeight + inset * 2 - control) < 0.0001)
    #expect(
      ComposerFieldMetrics.height(fitting: lineHeight + inset * 2, lineHeight: lineHeight, inset: inset, maxLines: 6)
        == control)
  }

  @Test func theFieldIsNeverUnderOneLineAndNeverOverTheCap() {
    let line: CGFloat = 20
    let inset: CGFloat = 10

    #expect(ComposerFieldMetrics.height(fitting: 0, lineHeight: line, inset: inset, maxLines: 6) == 40, "empty is one line")
    #expect(ComposerFieldMetrics.height(fitting: 1000, lineHeight: line, inset: inset, maxLines: 6) == 140)
    #expect(ComposerFieldMetrics.height(fitting: 80, lineHeight: line, inset: inset, maxLines: 6) == 80)
  }

  @Test func aFontTallerThanTheControlStillGetsItsMinimumRoom() {
    #expect(ComposerFieldMetrics.verticalInset(controlHeight: 40, lineHeight: 60) == ComposerFieldMetrics.minimumInset)
  }

  @Test func aCopiedPicturesAddressIsNotWordsButASentenceIs() {
    #expect(PasteboardText.isWords("https://example.com/photo.png") == false)
    #expect(PasteboardText.isWords("  http://example.com/a  ") == false)
    #expect(PasteboardText.isWords("look at https://example.com/photo.png") == true)
    #expect(PasteboardText.isWords("hello") == true)
    #expect(PasteboardText.isWords("ftp://example.com/x") == true)
    #expect(PasteboardText.isWords("   ") == false)
    #expect(PasteboardText.isWords("") == false)
  }
}

#if os(macOS)
  import AppKit

  /// The placeholder is the text view's own, on the line the typed text gets.
  @MainActor
  @Suite(.serialized) struct ComposerPlaceholderTests {
    private func makeField(controlHeight: CGFloat = 32, width: CGFloat = 320) -> (KeyTextView, NSWindow) {
      let scroll = ComposerTextField.makeScrollView()
      let textView = scroll.documentView as! KeyTextView
      textView.placeholder = "Message"
      textView.applyControlHeight(controlHeight)
      scroll.frame = NSRect(x: 0, y: 0, width: width, height: controlHeight)
      let window = NSWindow(contentRect: scroll.frame, styleMask: [.titled], backing: .buffered, defer: true)
      window.isReleasedWhenClosed = false
      window.contentView = scroll
      textView.frame = NSRect(x: 0, y: 0, width: width, height: controlHeight)
      return (textView, window)
    }

    /// The baseline of the first line, in the text view's own coordinates: for the typed text, and
    /// for the placeholder as it is drawn.
    private func baselines(_ textView: KeyTextView, typed: String) throws -> (typed: CGPoint, placeholder: CGPoint) {
      textView.string = typed
      let layout = try #require(textView.layoutManager)
      let container = try #require(textView.textContainer)
      layout.ensureLayout(for: container)
      let origin = textView.textContainerOrigin
      let line = layout.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
      let location = layout.location(forGlyphAt: 0)
      let typedPoint = CGPoint(x: origin.x + line.minX + location.x, y: origin.y + line.minY + location.y)

      let drawn = textView.placeholderLayout()
      let placeholderLine = drawn.layout.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
      let placeholderLocation = drawn.layout.location(forGlyphAt: 0)
      let placeholderPoint = CGPoint(
        x: textView.placeholderOrigin.x + placeholderLine.minX + placeholderLocation.x,
        y: textView.placeholderOrigin.y + placeholderLine.minY + placeholderLocation.y)

      return (typedPoint, placeholderPoint)
    }

    @Test(arguments: [CGFloat(32), 40, 48, 64])
    func thePlaceholderSitsOnTheBaselineOfTheFirstTypedCharacter(controlHeight: CGFloat) throws {
      let (textView, window) = makeField(controlHeight: controlHeight)
      defer { window.close() }

      let points = try baselines(textView, typed: "a")
      #expect(abs(points.typed.x - points.placeholder.x) < 0.01, "same left edge: \(points)")
      #expect(abs(points.typed.y - points.placeholder.y) < 0.01, "same baseline: \(points)")
    }

    @Test func theCaretOfAnEmptyFieldIsOnThePlaceholdersLine() throws {
      let (textView, window) = makeField()
      defer { window.close() }

      textView.string = ""
      let layout = try #require(textView.layoutManager)
      let caret = layout.extraLineFragmentRect
      let drawn = textView.placeholderLayout()
      let placeholderLine = drawn.layout.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)

      #expect(abs(caret.height - placeholderLine.height) < 0.01, "caret \(caret), placeholder line \(placeholderLine)")
      #expect(abs((textView.textContainerOrigin.y + caret.minY) - textView.placeholderOrigin.y) < 0.01)
    }

    @Test(arguments: [CGFloat(32), 40, 56])
    func theFirstLineIsCentredInTheFieldAndTheFieldDoesNotJumpWhenTheFirstCharacterIsTyped(controlHeight: CGFloat) throws {
      let (textView, window) = makeField(controlHeight: controlHeight)
      defer { window.close() }

      let empty = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))
      textView.string = "a"
      let typed = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))

      #expect(empty.height == typed.height, "no jump: \(empty.height) then \(typed.height)")
      #expect(abs(empty.height - controlHeight) <= 1, "one line is the control's height: \(empty.height)")

      let font = try #require(textView.font)
      let lineHeight = try #require(textView.layoutManager).defaultLineHeight(for: font)
      let middle = textView.placeholderOrigin.y + lineHeight / 2
      #expect(abs(middle - empty.height / 2) <= 1, "centred: line middle \(middle) in a field \(empty.height) tall")
    }

    @Test func aMultiLineFieldGrowsFromThatLineAndTheCapStillHolds() throws {
      let (textView, window) = makeField(controlHeight: 40)
      defer { window.close() }

      let one = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))
      textView.string = "one\ntwo\nthree"
      let three = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))
      textView.string = String(repeating: "line\n", count: 40)
      let capped = try #require(ComposerTextField.fittingSize(of: textView, width: 320, maxLines: 6))

      let font = try #require(textView.font)
      let lineHeight = try #require(textView.layoutManager).defaultLineHeight(for: font)
      #expect(abs((three.height - one.height) - lineHeight * 2) < 1.5, "two more lines of text")
      #expect(capped.height <= (lineHeight * 6 + textView.textContainerInset.height * 2).rounded(.up))
    }
  }
#endif
