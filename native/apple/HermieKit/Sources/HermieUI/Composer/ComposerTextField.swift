import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// The composer's text view: the platform's own multi-line text view, because
/// the key rules need the keys before the text system takes them, which a
/// SwiftUI `TextField` does not allow (its Return never reaches `onKeyPress`).
///
/// - A hardware Return sends, Shift-Return starts a new line, Command-Return
///   sends; Return while text is being composed (an input method's marked
///   text) commits that text instead.
/// - The on-screen keyboard's Return types a new line: it is not a key event.
/// - Esc goes to `onEscape`, which says whether it used it.
/// - Plain text only: a paste takes the pasteboard's string and nothing else.
/// - Grows with its text up to `maxLines`, then scrolls. Dynamic Type sizes it.
struct ComposerTextField {
  @Binding var text: String
  let placeholder: String
  let accessibilityLabel: String
  let accessibilityHint: String
  let maxLines: Int
  /// Moves on every request to put the caret in the field.
  let focusRequest: Int
  let onFocusChange: (Bool) -> Void
  let onSend: () -> Void
  let onEscape: () -> Bool

  static let identifier = "composer.field"

  @MainActor final class Coordinator: NSObject {
    var parent: ComposerTextField
    var lastFocusRequest: Int

    init(_ parent: ComposerTextField) {
      self.parent = parent
      self.lastFocusRequest = parent.focusRequest
    }
  }

  @MainActor func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }
}

#if os(iOS)
  extension ComposerTextField: UIViewRepresentable {
    func makeUIView(context: Context) -> KeyTextView {
      let view = KeyTextView()
      view.delegate = context.coordinator
      view.font = .preferredFont(forTextStyle: .body)
      view.adjustsFontForContentSizeCategory = true
      view.backgroundColor = .clear
      view.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
      view.isScrollEnabled = false
      view.allowsEditingTextAttributes = false
      view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      view.accessibilityIdentifier = Self.identifier
      configure(view, context: context)
      return view
    }

    func updateUIView(_ view: KeyTextView, context: Context) {
      context.coordinator.parent = self
      configure(view, context: context)

      if view.text != text {
        view.text = text
      }

      if focusRequest != context.coordinator.lastFocusRequest {
        context.coordinator.lastFocusRequest = focusRequest
        if !view.isFirstResponder {
          view.becomeFirstResponder()
        }
      }
    }

    @MainActor private func configure(_ view: KeyTextView, context: Context) {
      view.accessibilityLabel = accessibilityLabel
      view.accessibilityHint = accessibilityHint.isEmpty ? nil : accessibilityHint
      let coordinator = context.coordinator
      view.onSend = { coordinator.parent.onSend() }
      view.onEscape = { coordinator.parent.onEscape() }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: KeyTextView, context: Context) -> CGSize? {
      let width = proposal.width ?? 240
      let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
      let lineHeight = view.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
      let insets = view.textContainerInset.top + view.textContainerInset.bottom
      let cap = (lineHeight * CGFloat(maxLines) + insets).rounded(.up)
      let scrolls = fitting.height > cap

      if view.isScrollEnabled != scrolls {
        view.isScrollEnabled = scrolls
      }

      return CGSize(width: width, height: min(fitting.height, cap))
    }
  }

  extension ComposerTextField.Coordinator: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
      if parent.text != textView.text {
        parent.text = textView.text
      }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      parent.onFocusChange(true)
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      parent.onFocusChange(false)
    }
  }

  /// A text view that hears Return, Shift-Return, Command-Return and Esc from
  /// a hardware keyboard before the text system does.
  final class KeyTextView: UITextView {
    var onSend: () -> Void = {}
    var onEscape: () -> Bool = { false }

    override var keyCommands: [UIKeyCommand]? {
      let send = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(returnPressed))
      send.wantsPriorityOverSystemBehavior = true
      let commandSend = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(returnPressed))
      commandSend.wantsPriorityOverSystemBehavior = true
      let newline = UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(newlinePressed))
      newline.wantsPriorityOverSystemBehavior = true
      let escape = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(escapePressed))
      escape.wantsPriorityOverSystemBehavior = true
      return [send, commandSend, newline, escape] + (super.keyCommands ?? [])
    }

    @objc private func returnPressed() {
      // An input method still composing: Return commits, it does not send.
      if markedTextRange != nil {
        unmarkText()
        return
      }

      onSend()
    }

    @objc private func newlinePressed() {
      insertText("\n")
    }

    @objc private func escapePressed() {
      _ = onEscape()
    }

    // Plain text only; attachments are a later task.
    override func paste(_ sender: Any?) {
      if let string = UIPasteboard.general.string {
        insertText(string)
      }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
      if action == #selector(paste(_:)) {
        return UIPasteboard.general.hasStrings
      }

      return super.canPerformAction(action, withSender: sender)
    }
  }
#elseif os(macOS)
  extension ComposerTextField: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
      let textView = KeyTextView()
      textView.delegate = context.coordinator
      textView.isRichText = false
      textView.importsGraphics = false
      textView.allowsUndo = true
      textView.drawsBackground = false
      textView.font = .preferredFont(forTextStyle: .body)
      textView.textContainerInset = NSSize(width: 4, height: 6)
      textView.isVerticallyResizable = true
      textView.isHorizontallyResizable = false
      textView.autoresizingMask = [.width]
      textView.textContainer?.widthTracksTextView = true
      textView.setAccessibilityIdentifier(Self.identifier)

      let scroll = NSScrollView()
      scroll.documentView = textView
      scroll.drawsBackground = false
      scroll.hasVerticalScroller = true
      scroll.autohidesScrollers = true
      configure(textView, context: context)
      return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
      guard let textView = scroll.documentView as? KeyTextView else {
        return
      }

      context.coordinator.parent = self
      configure(textView, context: context)

      if textView.string != text {
        textView.string = text
      }

      if focusRequest != context.coordinator.lastFocusRequest {
        context.coordinator.lastFocusRequest = focusRequest
        textView.window?.makeFirstResponder(textView)
      }
    }

    @MainActor private func configure(_ textView: KeyTextView, context: Context) {
      textView.setAccessibilityLabel(accessibilityLabel)
      textView.setAccessibilityHelp(accessibilityHint.isEmpty ? nil : accessibilityHint)
      let coordinator = context.coordinator
      textView.onSend = { coordinator.parent.onSend() }
      textView.onEscape = { coordinator.parent.onEscape() }
      textView.onFocusChange = { coordinator.parent.onFocusChange($0) }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
      guard let textView = scroll.documentView as? NSTextView, let layout = textView.layoutManager,
        let container = textView.textContainer
      else {
        return nil
      }

      let width = proposal.width ?? 240
      container.containerSize = NSSize(width: width - textView.textContainerInset.width * 2, height: .greatestFiniteMagnitude)
      layout.ensureLayout(for: container)
      let font = textView.font ?? .preferredFont(forTextStyle: .body)
      let lineHeight = layout.defaultLineHeight(for: font)
      let insets = textView.textContainerInset.height * 2
      let used = max(layout.usedRect(for: container).height, lineHeight) + insets
      let cap = (lineHeight * CGFloat(maxLines) + insets).rounded(.up)
      return CGSize(width: width, height: min(used.rounded(.up), cap))
    }
  }

  extension ComposerTextField.Coordinator: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView, parent.text != textView.string else {
        return
      }

      parent.text = textView.string
    }
  }

  /// A text view that sends on Return and Command-Return, starts a new line on
  /// Shift-Return, and hands Esc to the composer.
  final class KeyTextView: NSTextView {
    var onSend: () -> Void = {}
    var onEscape: () -> Bool = { false }
    var onFocusChange: (Bool) -> Void = { _ in }

    private static let returnKeys: Set<UInt16> = [36, 76]
    private static let escapeKey: UInt16 = 53

    override func keyDown(with event: NSEvent) {
      if Self.returnKeys.contains(event.keyCode), !hasMarkedText() {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        if flags.contains(.shift) {
          insertNewlineIgnoringFieldEditor(nil)
        } else if !flags.contains(.option) {
          onSend()
        } else {
          super.keyDown(with: event)
        }

        return
      }

      if event.keyCode == Self.escapeKey, !hasMarkedText(), onEscape() {
        return
      }

      super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

      if window?.firstResponder === self, Self.returnKeys.contains(event.keyCode), flags.contains(.command) {
        onSend()
        return true
      }

      return super.performKeyEquivalent(with: event)
    }

    override func becomeFirstResponder() -> Bool {
      let became = super.becomeFirstResponder()
      if became { onFocusChange(true) }
      return became
    }

    override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()
      if resigned { onFocusChange(false) }
      return resigned
    }
  }
#endif
