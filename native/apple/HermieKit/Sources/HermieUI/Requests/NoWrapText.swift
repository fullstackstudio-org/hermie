import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// A draft's text, shown exactly as it is: monospaced, every space kept, and never wrapped. A long
/// line scrolls sideways instead of being re-wrapped into line breaks the text does not have
/// (`contract/requests/README.md` §6). The text is plain: never Markdown, never a link. It is the
/// same text view as the editor, read-only, so a very long line is reachable to its last character
/// (a SwiftUI `Text` that wide is cut off by the renderer's layer limits).
struct NoWrapText: View {
  let text: String
  var compact = false
  var identifier = "draft.text"

  var body: some View {
    NoWrapTextEditor(
      text: .constant(text), isEditable: false, compact: compact, identifier: identifier
    )
    .background(.background.secondary, in: .rect(cornerRadius: 10))
    .clipShape(.rect(cornerRadius: 10))
  }
}

// MARK: - The editor

/// A text editor that does not wrap: lines run on and the box scrolls sideways (and up and down), and
/// nothing is corrected, capitalised, replaced, linked or made smart, so what is typed is what is
/// approved. A `UITextView` on iOS and an `NSTextView` in a scroll view on the Mac, since SwiftUI's
/// own `TextEditor` always wraps. Read-only (`isEditable: false`) it sizes itself to its text, up to
/// `maxHeight`.
struct NoWrapTextEditor {
  @Binding var text: String
  var isEditable = true
  /// A smaller type (the revealed copy of a text).
  var compact = false
  var identifier = "draft.editor"

  /// The editor's own height; its text scrolls inside it.
  static let minimumHeight: CGFloat = 260
  /// The tallest a read-only text gets before it scrolls.
  static let maximumHeight: CGFloat = 420
  /// A text container this wide: wider than any line the contract lets through (2,000 characters).
  /// The iOS view narrows its container to the longest line, so this is only ever the measuring width.
  static let containerWidth: CGFloat = 100_000
}

#if os(iOS)
  /// A text view whose text container is as wide as its longest line (and never narrower than the
  /// view), so the content is exactly as wide as the text: every character can be scrolled to, with
  /// no large empty area after the longest line.
  final class NoWrapUITextView: UITextView {
    /// What the container was last fitted for.
    private var fitted: (text: String, width: CGFloat, font: UIFont?)?

    /// Room the container keeps on each side of a line, beyond its own padding.
    private static let slack: CGFloat = 2

    private var insetWidth: CGFloat {
      textContainerInset.left + textContainerInset.right
    }

    /// The width of the longest line, measured with the container wide enough for any line.
    private func longestLine() -> CGFloat {
      textContainer.size = CGSize(width: NoWrapTextEditor.containerWidth, height: .greatestFiniteMagnitude)
      layoutManager.ensureLayout(for: textContainer)
      return ceil(layoutManager.usedRect(for: textContainer).width)
    }

    /// Make the container as wide as the longest line, at least as wide as the view.
    func fitContainer() {
      let key = (text: text ?? "", width: bounds.width, font: font)

      if let fitted, fitted.text == key.text, fitted.width == key.width, fitted.font == key.font {
        return
      }

      let longest = longestLine()
      let padding = textContainer.lineFragmentPadding * 2
      let width = max(bounds.width - insetWidth, longest + padding + Self.slack)
      textContainer.size = CGSize(width: width, height: .greatestFiniteMagnitude)
      fitted = key
    }

    /// The text needs this much height at the current width, for a read-only block that fits it.
    func fittingHeight() -> CGFloat {
      fitContainer()
      layoutManager.ensureLayout(for: textContainer)
      return ceil(layoutManager.usedRect(for: textContainer).height) + textContainerInset.top + textContainerInset.bottom
    }

    override func layoutSubviews() {
      fitContainer()
      super.layoutSubviews()

      // The content is as wide as the container (and the view at least): never the measuring width.
      let width = max(bounds.width, textContainer.size.width + insetWidth)

      if abs(contentSize.width - width) > 0.5 {
        contentSize = CGSize(width: width, height: contentSize.height)
      }
    }

    /// The text changed under the view (a binding): measure again.
    func textChanged() {
      fitted = nil
      setNeedsLayout()
    }
  }

  extension NoWrapTextEditor: UIViewRepresentable {
    func makeUIView(context: Context) -> NoWrapUITextView {
      // TextKit 1 on purpose: the container's width is the one thing this view is about.
      let view = NoWrapUITextView(usingTextLayoutManager: false)
      Self.configure(view, editable: isEditable, compact: compact)
      view.accessibilityIdentifier = identifier
      view.delegate = context.coordinator
      view.text = text
      return view
    }

    func updateUIView(_ view: NoWrapUITextView, context: Context) {
      // Only when it differs: setting it again would move the insertion point.
      if view.text != text {
        view.text = text
        view.textChanged()
      }

      let font = Self.font(compact: compact)

      if view.font != font {
        view.font = font
        view.textChanged()
      }
    }

    /// A read-only text takes the height of its text, up to `maximumHeight`; an editor is sized by
    /// its frame.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: NoWrapUITextView, context: Context) -> CGSize? {
      guard !isEditable else {
        return nil
      }

      let width = proposal.width ?? 320
      uiView.bounds.size.width = width
      let height = min(max(uiView.fittingHeight(), 44), Self.maximumHeight)
      return CGSize(width: width, height: height)
    }

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    /// Monospaced, and following the person's text size.
    static func font(compact: Bool = false) -> UIFont {
      let style: UIFont.TextStyle = compact ? .footnote : .body
      let base = UIFont.preferredFont(forTextStyle: style)
      return UIFontMetrics(forTextStyle: style).scaledFont(
        for: UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: .regular))
    }

    /// No wrapping, no help.
    @MainActor static func configure(_ view: UITextView, editable: Bool = true, compact: Bool = false) {
      view.font = font(compact: compact)
      view.adjustsFontForContentSizeCategory = true
      view.backgroundColor = .clear
      view.isEditable = editable
      view.isSelectable = true
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
    }

    final class Coordinator: NSObject, UITextViewDelegate {
      var parent: NoWrapTextEditor

      init(_ parent: NoWrapTextEditor) {
        self.parent = parent
      }

      func textViewDidChange(_ textView: UITextView) {
        (textView as? NoWrapUITextView)?.textChanged()

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
      Self.configure(view, in: scroll, editable: isEditable, compact: compact)
      view.setAccessibilityIdentifier(identifier)
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

    /// A read-only text takes the height of its text, up to `maximumHeight`; an editor is sized by
    /// its frame.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
      guard !isEditable, let view = nsView.documentView as? NSTextView, let layout = view.layoutManager,
        let container = view.textContainer
      else {
        return nil
      }

      layout.ensureLayout(for: container)
      let height = ceil(layout.usedRect(for: container).height) + view.textContainerInset.height * 2
      return CGSize(width: proposal.width ?? 320, height: min(max(height, 44), Self.maximumHeight))
    }

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    /// No wrapping, no help. An `NSTextView` that is horizontally resizable grows to its longest line
    /// inside the scroll view, so the width is exact.
    @MainActor static func configure(_ view: NSTextView, in scroll: NSScrollView, editable: Bool = true, compact: Bool = false) {
      scroll.hasVerticalScroller = true
      scroll.hasHorizontalScroller = true
      scroll.autohidesScrollers = true
      scroll.drawsBackground = false
      scroll.borderType = .noBorder

      let size = NSFont.preferredFont(forTextStyle: compact ? .footnote : .body).pointSize
      view.font = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
      view.drawsBackground = false
      view.isEditable = editable
      view.isSelectable = true
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
