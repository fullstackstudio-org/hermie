import ExpoModulesCore
import UIKit

/**
 A reading surface a mouse can actually drag a selection across.

 React Native cannot draw one. `Text selectable` is a long press that presents a `UIEditMenuInteraction`
 whose single action copies the entire paragraph — `RCTParagraphComponentView` has no selection range
 at all, and `RCTParagraphTextView` (a plain `UIView`, despite the name) returns `nil` from
 `hitTest:`. So there is nothing in the renderer for a drag to move, and no prop that changes that.

 A `UITextView` over an `NSAttributedString` is the only thing in UIKit that drag-selects a range of
 RICH text, and everything the owner asked for comes with it rather than being written here:
 press-and-drag selection, double click for a word and triple for a paragraph, shift-click to extend,
 ⌘A, ⌘C, and the system's own edit menu on a secondary click.

 What it cannot hold is a view, which is why this is a SECOND presentation of a message rather than a
 replacement for the bubble: our renderer emits a horizontally scrolling code block and a table built
 out of boxes, and neither fits in a text view. `src/markdown/attributed.ts` is the flattening, and
 what arrives here is its output — a list of runs, each a slice of characters plus the role it plays.

 Colours and the body size come from JavaScript because the theme does: the app has a pinned light
 and dark scheme and an accent per chat, and a native view guessing at any of that would be the one
 surface in the app whose ink does not match the rest.
 */
public final class HermieSelectableTextView: ExpoView {
  private let textView = UITextView()

  private var runs: [[String: Any]] = []
  private var fontSize: CGFloat = 16
  private var textColor: UIColor = .label
  private var mutedColor: UIColor = .secondaryLabel
  private var linkColor: UIColor = .link
  private var codeBackground: UIColor = .secondarySystemBackground

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    textView.isEditable = false
    // Both, and they are not the same switch: `isSelectable` is what makes the view take a selection
    // and become first responder for ⌘A and ⌘C, and it is meaningless while `isEditable` is true.
    textView.isSelectable = true
    textView.backgroundColor = .clear
    textView.alwaysBounceVertical = true
    // The overlay draws its own padding around this view; a second inset here would put the text
    // somewhere the panel did not ask for.
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []

    addSubview(textView)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()

    textView.frame = bounds
  }

  /**
   Take the selection as soon as there is a window to take it in.

   Without this ⌘A and ⌘C do nothing until the reader has clicked the text once, which on a panel
   that exists FOR copying is a step with no reason a reader could guess.
   */
  public override func didMoveToWindow() {
    super.didMoveToWindow()

    if window != nil {
      textView.becomeFirstResponder()
    }
  }

  func setRuns(_ value: [[String: Any]]) {
    runs = value
    rebuild()
  }

  func setFontSize(_ value: Double?) {
    fontSize = value.map { CGFloat($0) } ?? 16
    rebuild()
  }

  func setTextColor(_ value: UIColor?) {
    textColor = value ?? .label
    rebuild()
  }

  func setMutedColor(_ value: UIColor?) {
    mutedColor = value ?? .secondaryLabel
    rebuild()
  }

  func setLinkColor(_ value: UIColor?) {
    linkColor = value ?? .link
    rebuild()
  }

  func setCodeBackground(_ value: UIColor?) {
    codeBackground = value ?? .secondarySystemBackground
    rebuild()
  }

  /**
   The size and weight a block role is drawn at.

   The scale steps are the renderer's own (`src/markdown/Block.tsx`): a message opened here has to
   read as the same message, or the overlay looks like a different reply.
   */
  private func font(for block: String, bold: Bool, italic: Bool) -> UIFont {
    if block == "code" {
      return UIFont.monospacedSystemFont(ofSize: fontSize - 1, weight: bold ? .semibold : .regular)
    }

    let size: CGFloat
    let weight: UIFont.Weight

    switch block {
    case "heading1":
      size = (fontSize * 1.5).rounded()
      weight = .bold
    case "heading2":
      size = (fontSize * 1.3).rounded()
      weight = .bold
    case "heading3":
      size = (fontSize * 1.1).rounded()
      weight = .semibold
    default:
      size = fontSize
      weight = bold ? .semibold : .regular
    }

    let base = UIFont.systemFont(ofSize: size, weight: weight)

    guard italic, let descriptor = base.fontDescriptor.withSymbolicTraits(.traitItalic) else {
      return base
    }

    return UIFont(descriptor: descriptor, size: size)
  }

  private func attributes(for run: [String: Any]) -> [NSAttributedString.Key: Any] {
    let block = run["block"] as? String ?? "body"
    let bold = run["bold"] as? Bool ?? false
    let italic = run["italic"] as? Bool ?? false
    let mono = run["mono"] as? Bool ?? false

    var attributes: [NSAttributedString.Key: Any] = [
      .font: font(for: mono ? "code" : block, bold: bold, italic: italic),
      // A quote is the one role drawn in the muted ink rather than the body's, which is how the
      // renderer separates it without a rule down the side that a text view cannot draw.
      .foregroundColor: block == "quote" ? mutedColor : textColor
    ]

    if mono || block == "code" {
      attributes[.backgroundColor] = codeBackground
    }

    if run["strike"] as? Bool == true {
      attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
    }

    if let href = run["href"] as? String, let url = URL(string: href) {
      attributes[.link] = url
    } else if run["href"] is String {
      // A target UIKit will not parse — a path on the gateway's disk, say — still reads as a link,
      // it just does not open. Dropping the colour would hide that the author wrote one.
      attributes[.foregroundColor] = linkColor
      attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
    }

    return attributes
  }

  private func rebuild() {
    let string = NSMutableAttributedString()

    for run in runs {
      guard let text = run["text"] as? String, !text.isEmpty else {
        continue
      }

      string.append(NSAttributedString(string: text, attributes: attributes(for: run)))
    }

    textView.linkTextAttributes = [
      .foregroundColor: linkColor,
      .underlineStyle: NSUnderlineStyle.single.rawValue
    ]
    textView.attributedText = string
  }
}
