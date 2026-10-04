import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// A draft's text, shown exactly as it is: monospaced, every space kept, and never wrapped. A long
/// line scrolls sideways instead of being re-wrapped into line breaks the text does not have
/// (`contract/requests/README.md` §6). The text is plain: never Markdown, never a link.
struct NoWrapText: View {
  let text: String
  var font: Font = .body.monospaced()
  var identifier = "draft.text"

  var body: some View {
    ScrollView(.horizontal) {
      Text(verbatim: text)
        .font(font)
        .fixedSize(horizontal: true, vertical: true)
        .textSelection(.enabled)
        .padding(12)
        .accessibilityIdentifier(identifier)
    }
    .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: .rect(cornerRadius: 10))
    .clipShape(.rect(cornerRadius: 10))
  }
}

// MARK: - The editor

/// A text editor that does not wrap: lines run on and the box scrolls sideways (and up and down), and
/// nothing is corrected, capitalised, replaced, linked or made smart, so what is typed is what is
/// approved. A `UITextView` on iOS and an `NSTextView` in a scroll view on the Mac, since SwiftUI's
/// own `TextEditor` always wraps.
struct NoWrapTextEditor {
  @Binding var text: String

  /// The editor's own height; its text scrolls inside it.
  static let minimumHeight: CGFloat = 260
  /// Wider than any line the contract lets through (2,000 characters, and then some).
  static let containerWidth: CGFloat = 100_000
}

#if os(iOS)
  extension NoWrapTextEditor: UIViewRepresentable {
    func makeUIView(context: Context) -> UITextView {
      let view = UITextView()
      Self.configure(view)
      view.delegate = context.coordinator
      view.text = text
      return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
      // Only when it differs: setting it again would move the insertion point.
      if view.text != text {
        view.text = text
      }

      let font = Self.font()

      if view.font != font {
        view.font = font
      }
    }

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    /// Monospaced, and following the person's text size.
    static func font() -> UIFont {
      let body = UIFont.preferredFont(forTextStyle: .body)
      return UIFontMetrics(forTextStyle: .body).scaledFont(
        for: UIFont.monospacedSystemFont(ofSize: body.pointSize, weight: .regular))
    }

    /// No wrapping, no help.
    static func configure(_ view: UITextView) {
      view.font = font()
      view.adjustsFontForContentSizeCategory = true
      view.backgroundColor = .clear
      view.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
      view.isScrollEnabled = true
      view.alwaysBounceHorizontal = false
      view.showsHorizontalScrollIndicator = true
      view.textContainer.widthTracksTextView = false
      view.textContainer.lineBreakMode = .byClipping
      view.textContainer.size = CGSize(width: containerWidth, height: .greatestFiniteMagnitude)
      view.autocorrectionType = .no
      view.autocapitalizationType = .none
      view.spellCheckingType = .no
      view.smartQuotesType = .no
      view.smartDashesType = .no
      view.smartInsertDeleteType = .no
      view.dataDetectorTypes = []
      view.allowsEditingTextAttributes = false
      view.isFindInteractionEnabled = false
      view.accessibilityIdentifier = "draft.editor"
    }

    final class Coordinator: NSObject, UITextViewDelegate {
      var parent: NoWrapTextEditor

      init(_ parent: NoWrapTextEditor) {
        self.parent = parent
      }

      func textViewDidChange(_ textView: UITextView) {
        if parent.text != textView.text {
          parent.text = textView.text
        }
      }
    }
  }
#elseif os(macOS)
  extension NoWrapTextEditor: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
      let scroll = NSScrollView()
      let view = NSTextView(frame: .zero)
      Self.configure(view, in: scroll)
      view.delegate = context.coordinator
      view.string = text
      scroll.documentView = view
      return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
      guard let view = scroll.documentView as? NSTextView else {
        return
      }

      if view.string != text {
        view.string = text
      }
    }

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    /// No wrapping, no help.
    static func configure(_ view: NSTextView, in scroll: NSScrollView) {
      scroll.hasVerticalScroller = true
      scroll.hasHorizontalScroller = true
      scroll.autohidesScrollers = true
      scroll.drawsBackground = false
      scroll.borderType = .noBorder

      view.font = NSFont.monospacedSystemFont(ofSize: NSFont.preferredFont(forTextStyle: .body).pointSize, weight: .regular)
      view.drawsBackground = false
      view.isRichText = false
      view.importsGraphics = false
      view.allowsUndo = true
      view.textContainerInset = NSSize(width: 6, height: 8)
      view.isHorizontallyResizable = true
      view.isVerticallyResizable = true
      view.autoresizingMask = [.width, .height]
      view.maxSize = NSSize(width: containerWidth, height: .greatestFiniteMagnitude)
      view.textContainer?.widthTracksTextView = false
      view.textContainer?.containerSize = NSSize(width: containerWidth, height: .greatestFiniteMagnitude)
      view.textContainer?.lineBreakMode = .byClipping
      view.isAutomaticQuoteSubstitutionEnabled = false
      view.isAutomaticDashSubstitutionEnabled = false
      view.isAutomaticTextReplacementEnabled = false
      view.isAutomaticSpellingCorrectionEnabled = false
      view.isAutomaticLinkDetectionEnabled = false
      view.isAutomaticDataDetectionEnabled = false
      view.isContinuousSpellCheckingEnabled = false
      view.isGrammarCheckingEnabled = false
      view.smartInsertDeleteEnabled = false
      view.setAccessibilityIdentifier("draft.editor")
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
      var parent: NoWrapTextEditor

      init(_ parent: NoWrapTextEditor) {
        self.parent = parent
      }

      func textDidChange(_ notification: Notification) {
        guard let view = notification.object as? NSTextView else {
          return
        }

        if parent.text != view.string {
          parent.text = view.string
        }
      }
    }
  }
#endif
