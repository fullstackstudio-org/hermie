import HermieCore
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// Something a paste into the field brought that is not text: a file copied in the Finder or Files,
/// or an image (a screenshot, a copied picture).
enum PasteItem: Sendable, Equatable {
  case file(URL)
  case image(Data, UTType)
}

/// How the field is measured, in plain numbers so both platforms and a test use the same ones.
///
/// One line of text makes exactly `controlHeight` (the height of the round buttons beside the
/// field), with the same room above and below it, so the text, the placeholder and the caret sit
/// on the middle of the field and the buttons line up with them. The field's height is its text's
/// height, never the placeholder's: typing the first character moves nothing.
enum ComposerFieldMetrics {
  /// The least room above and below the text, whatever the font.
  static let minimumInset: CGFloat = 6

  /// The room above and below the text that makes one line `controlHeight` tall.
  static func verticalInset(controlHeight: CGFloat, lineHeight: CGFloat) -> CGFloat {
    max(minimumInset, (controlHeight - lineHeight) / 2)
  }

  /// The field's height for text `fitting` points tall: never under one line, never over `maxLines`.
  static func height(fitting: CGFloat, lineHeight: CGFloat, inset: CGFloat, maxLines: Int) -> CGFloat {
    let one = lineHeight + inset * 2
    let cap = lineHeight * CGFloat(maxLines) + inset * 2

    return min(max(fitting, one), cap.rounded(.up))
  }
}

/// The composer's text view: the platform's own multi-line text view, because
/// the key rules need the keys before the text system takes them, which a
/// SwiftUI `TextField` does not allow (its Return never reaches `onKeyPress`).
///
/// - A hardware Return sends, Shift-Return starts a new line, Command-Return
///   sends; Return while text is being composed (an input method's marked
///   text) commits that text instead.
/// - The on-screen keyboard's Return types a new line: it is not a key event.
/// - Esc goes to `onEscape`, which says whether it used it.
/// - While the command list is open (`completionKeysActive`), Up, Down and Tab go to
///   `onCompletionKey` first, which says whether the list used them; the field's own handling of
///   them (the caret moving a line, a tab) is for when it did not. Return and Esc go through
///   `onSend` and `onEscape` as always, and the composer decides what they mean for the list.
/// - A paste takes the pasteboard's string as plain text; files and pictures on the pasteboard
///   (and no text) go to `onPaste` instead, to be attached.
/// - The placeholder is the text view's own: drawn by the same layout as the typed text, at the
///   same place, so it sits on the same baseline as the first typed character and the caret.
/// - Grows with its text up to `maxLines`, then scrolls. Dynamic Type sizes it.
struct ComposerTextField {
  @Binding var text: String
  let placeholder: String
  let accessibilityLabel: String
  let accessibilityHint: String
  let maxLines: Int
  /// The height of one line of the field, with the room around it: the round buttons' size.
  let controlHeight: CGFloat
  /// Moves on every request to put the caret in the field.
  let focusRequest: Int
  let onFocusChange: (Bool) -> Void
  let onSend: () -> Void
  let onEscape: () -> Bool
  let onPaste: ([PasteItem]) -> Void
  /// The command list is open with something to move on: its keys are listened for.
  let completionKeysActive: Bool
  let onCompletionKey: (CompletionKey) -> Bool

  static let identifier = "composer.field"

  @MainActor final class Coordinator: NSObject {
    var parent: ComposerTextField
    var lastFocusRequest: Int
    /// The last measurement, by what it depends on: SwiftUI asks for the same size many times per
    /// layout pass, and each answer lays the text out afresh.
    var measured: (key: SizeKey, size: CGSize)?

    struct SizeKey: Equatable {
      var text: String
      var width: CGFloat
      var maxLines: Int
      var pointSize: CGFloat
      var controlHeight: CGFloat
    }

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
        if !view.isFirstResponder, view.isEditable {
          view.becomeFirstResponder()
        }
      }
    }

    @MainActor private func configure(_ view: KeyTextView, context: Context) {
      view.accessibilityLabel = accessibilityLabel
      view.accessibilityHint = accessibilityHint.isEmpty ? nil : accessibilityHint
      view.placeholder = placeholder
      view.applyControlHeight(controlHeight)
      let coordinator = context.coordinator
      view.onSend = { coordinator.parent.onSend() }
      view.onEscape = { coordinator.parent.onEscape() }
      view.onPaste = { coordinator.parent.onPaste($0) }
      view.completionKeysActive = completionKeysActive
      view.onCompletionKey = { coordinator.parent.onCompletionKey($0) }
      view.setEnabled(context.environment.isEnabled)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: KeyTextView, context: Context) -> CGSize? {
      let width = proposal.width ?? 240
      view.applyControlHeight(controlHeight)
      let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
      let lineHeight = view.font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
      let inset = view.textContainerInset.top
      let height = ComposerFieldMetrics.height(
        fitting: fitting.height, lineHeight: lineHeight, inset: inset, maxLines: maxLines)
      let scrolls = fitting.height > height

      if view.isScrollEnabled != scrolls {
        view.isScrollEnabled = scrolls
      }

      return CGSize(width: width, height: height)
    }
  }

  extension ComposerTextField.Coordinator: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
      (textView as? KeyTextView)?.syncPlaceholder()

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
  /// a hardware keyboard before the text system does, and that draws its own placeholder.
  final class KeyTextView: UITextView {
    /// Off while something covers the composer (`.disabled`): not editable, and the keyboard goes.
    func setEnabled(_ enabled: Bool) {
      guard enabled != isEditable else {
        return
      }

      isEditable = enabled

      if !enabled, isFirstResponder {
        resignFirstResponder()
      }
    }

    var onSend: () -> Void = {}
    var onEscape: () -> Bool = { false }
    var onPaste: ([PasteItem]) -> Void = { _ in }
    var completionKeysActive = false
    var onCompletionKey: (CompletionKey) -> Bool = { _ in false }

    /// What shows while the field is empty, a label laid out on the text's own first line.
    let placeholderLabel = UILabel()

    var placeholder = "" {
      didSet {
        placeholderLabel.text = placeholder
        syncPlaceholder()
      }
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
      super.init(frame: frame, textContainer: textContainer)
      placeholderLabel.numberOfLines = 1
      placeholderLabel.lineBreakMode = .byTruncatingTail
      // A plain colour, not a vibrant one: inside glass the hierarchical grey blends with what is
      // behind the field, below the audit's contrast.
      placeholderLabel.textColor = .secondaryLabel
      placeholderLabel.isAccessibilityElement = false
      placeholderLabel.isUserInteractionEnabled = false
      addSubview(placeholderLabel)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("init(coder:) is not used")
    }

    override var text: String! {
      didSet { syncPlaceholder() }
    }

    override var font: UIFont? {
      didSet { syncPlaceholder() }
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      syncPlaceholder()
    }

    /// The room above and below the text that makes one line `controlHeight` tall.
    func applyControlHeight(_ controlHeight: CGFloat) {
      let lineHeight = font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
      let inset = ComposerFieldMetrics.verticalInset(controlHeight: controlHeight, lineHeight: lineHeight)

      guard textContainerInset.top != inset || textContainerInset.bottom != inset else {
        return
      }

      textContainerInset.top = inset
      textContainerInset.bottom = inset
      setNeedsLayout()
    }

    /// Where the first line of text starts: the label goes exactly there.
    func syncPlaceholder() {
      let lineHeight = font?.lineHeight ?? UIFont.preferredFont(forTextStyle: .body).lineHeight
      let padding = textContainer.lineFragmentPadding
      let x = textContainerInset.left + padding
      let width = max(0, bounds.width - x - textContainerInset.right - padding)

      placeholderLabel.font = font
      placeholderLabel.frame = CGRect(x: x, y: textContainerInset.top, width: width, height: lineHeight)
      placeholderLabel.isHidden = hasText || markedTextRange != nil
    }

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
      guard isEditable else {
        return
      }

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

    // The command list's keys from a hardware keyboard, while it is open: Up, Down and Tab are the
    // list's when it uses them, and every other press is the text view's.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      guard completionKeysActive else {
        super.pressesBegan(presses, with: event)
        return
      }

      var rest = Set<UIPress>()

      for press in presses {
        if let key = press.key,
          key.modifierFlags.intersection([.shift, .control, .alternate, .command]).isEmpty,
          let mapped = Self.completionKey(for: key.keyCode), onCompletionKey(mapped)
        {
          continue
        }

        rest.insert(press)
      }

      if !rest.isEmpty {
        super.pressesBegan(rest, with: event)
      }
    }

    static func completionKey(for code: UIKeyboardHIDUsage) -> CompletionKey? {
      switch code {
      case .keyboardUpArrow: .up
      case .keyboardDownArrow: .down
      case .keyboardTab: .tab
      default: nil
      }
    }

    // Text goes in as plain text; files and pictures with no text go to be attached.
    override func paste(_ sender: Any?) {
      guard isEditable else {
        return
      }

      let items = Self.attachments(on: UIPasteboard.general)

      if !items.isEmpty {
        onPaste(items)
      } else if let string = UIPasteboard.general.string {
        insertText(string)
      }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
      if action == #selector(paste(_:)) {
        let board = UIPasteboard.general
        return board.hasStrings || board.hasImages || board.hasURLs
      }

      return super.canPerformAction(action, withSender: sender)
    }

    /// What on the pasteboard is to be attached rather than typed: copied files first, then a
    /// picture when there are no words with it (a copied picture often carries its address as
    /// text, which is not words).
    static func attachments(on board: UIPasteboard) -> [PasteItem] {
      let files = (board.urls ?? []).filter(\.isFileURL)

      if !files.isEmpty {
        return files.map(PasteItem.file)
      }

      guard board.hasImages else {
        return []
      }

      if let string = board.string, PasteboardText.isWords(string) {
        return []
      }

      for type in [UTType.png, .jpeg, .gif, .webP, .heic, .tiff] {
        if let data = board.data(forPasteboardType: type.identifier) {
          return [.image(data, type)]
        }
      }

      if let png = board.image?.pngData() {
        return [.image(png, .png)]
      }

      return []
    }
  }
#elseif os(macOS)
  extension ComposerTextField: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
      let scroll = Self.makeScrollView()
      if let textView = scroll.documentView as? KeyTextView {
        textView.delegate = context.coordinator
        configure(textView, context: context)
      }
      return scroll
    }

    /// The text view in its scroll view, as the field draws it.
    @MainActor static func makeScrollView() -> NSScrollView {
      let textView = KeyTextView()
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
        if textView.isEnabledForInput {
          textView.window?.makeFirstResponder(textView)
        }
      }
    }

    @MainActor private func configure(_ textView: KeyTextView, context: Context) {
      textView.setAccessibilityLabel(accessibilityLabel)
      textView.setAccessibilityHelp(accessibilityHint.isEmpty ? nil : accessibilityHint)
      textView.placeholder = placeholder
      textView.applyControlHeight(controlHeight)
      let coordinator = context.coordinator
      textView.onSend = { coordinator.parent.onSend() }
      textView.onEscape = { coordinator.parent.onEscape() }
      textView.onFocusChange = { coordinator.parent.onFocusChange($0) }
      textView.onPaste = { coordinator.parent.onPaste($0) }
      textView.completionKeysActive = completionKeysActive
      textView.onCompletionKey = { coordinator.parent.onCompletionKey($0) }
      textView.setEnabled(context.environment.isEnabled)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
      guard let textView = scroll.documentView as? KeyTextView else {
        return nil
      }

      let width = proposal.width ?? 240
      textView.applyControlHeight(controlHeight)
      let key = Coordinator.SizeKey(
        text: textView.string, width: width, maxLines: maxLines, pointSize: textView.font?.pointSize ?? 0,
        controlHeight: controlHeight)
      if let measured = context.coordinator.measured, measured.key == key {
        return measured.size
      }
      let size = Self.fittingSize(of: textView, width: width, maxLines: maxLines)
      if let size {
        context.coordinator.measured = (key, size)
      }
      return size
    }

    /// The field's size at `width`: as tall as its text, up to `maxLines` lines.
    ///
    /// Measured in a text system of its own, never in the text view's: SwiftUI also asks with
    /// probe widths (0, infinity), and a live container set to one of those kept it, because the
    /// view's frame did not change and `widthTracksTextView` only acts on a frame change. After a
    /// 0-wide probe the text was laid out in no space and the field showed nothing of what was
    /// typed (in the Mac app, after the window became active).
    @MainActor static func fittingSize(of textView: NSTextView, width: CGFloat, maxLines: Int) -> CGSize? {
      guard let live = textView.textContainer else {
        return nil
      }

      let font = textView.font ?? .preferredFont(forTextStyle: .body)
      let inset = textView.textContainerInset
      let storage = NSTextStorage(attributedString: textView.attributedString())
      let layout = NSLayoutManager()
      let container = NSTextContainer(
        size: NSSize(width: max(0, width - inset.width * 2), height: .greatestFiniteMagnitude))
      container.lineFragmentPadding = live.lineFragmentPadding
      layout.addTextContainer(container)
      storage.addLayoutManager(layout)
      layout.ensureLayout(for: container)

      let lineHeight = layout.defaultLineHeight(for: font)
      // An empty field, or a width too narrow for a glyph, is still one line tall.
      let used = width > 0 ? layout.usedRect(for: container).height : 0
      let height = ComposerFieldMetrics.height(
        fitting: used + inset.height * 2, lineHeight: lineHeight, inset: inset.height, maxLines: maxLines)
      return CGSize(width: width, height: height.rounded(.up))
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
  /// Shift-Return, hands Esc to the composer, and draws its own placeholder.
  final class KeyTextView: NSTextView {
    /// Off while something covers the composer (a request over the chat, `.disabled`): the field
    /// cannot be typed in, pasted into or sent from, does not take the keyboard, and gives it up
    /// if it had it, so what is typed for a secure prompt can never land here.
    private(set) var isEnabledForInput = true

    func setEnabled(_ enabled: Bool) {
      guard enabled != isEnabledForInput else {
        return
      }

      isEnabledForInput = enabled
      isEditable = enabled
      isSelectable = enabled

      if !enabled, let window, window.firstResponder === self {
        window.makeFirstResponder(nil)
      }
    }

    override var acceptsFirstResponder: Bool {
      isEnabledForInput && super.acceptsFirstResponder
    }

    var onSend: () -> Void = {}
    var onEscape: () -> Bool = { false }
    var onFocusChange: (Bool) -> Void = { _ in }
    var onPaste: ([PasteItem]) -> Void = { _ in }
    var completionKeysActive = false
    var onCompletionKey: (CompletionKey) -> Bool = { _ in false }

    /// What shows while the field is empty.
    var placeholder = "" {
      didSet { needsDisplay = true }
    }

    private static let returnKeys: Set<UInt16> = [36, 76]
    private static let escapeKey: UInt16 = 53

    override var string: String {
      didSet { needsDisplay = true }
    }

    override func didChangeText() {
      super.didChangeText()
      // The placeholder is wider than the first character: redraw it all, not the character's rect.
      needsDisplay = true
    }

    /// The room above and below the text that makes one line `controlHeight` tall.
    func applyControlHeight(_ controlHeight: CGFloat) {
      let lineHeight = layoutManager?.defaultLineHeight(for: font ?? .preferredFont(forTextStyle: .body)) ?? 16
      let inset = ComposerFieldMetrics.verticalInset(controlHeight: controlHeight, lineHeight: lineHeight)

      guard textContainerInset.height != inset else {
        return
      }

      textContainerInset = NSSize(width: textContainerInset.width, height: inset)
    }

    /// Where the placeholder's first line starts: where the typed text's first line does.
    var placeholderOrigin: NSPoint {
      NSPoint(x: textContainerOrigin.x + (textContainer?.lineFragmentPadding ?? 5), y: textContainerOrigin.y)
    }

    /// The placeholder laid out by a text system of its own, the same typesetter as the text's, so
    /// its line (and so its baseline) is the line the typed text gets.
    func placeholderLayout() -> (layout: NSLayoutManager, container: NSTextContainer, storage: NSTextStorage) {
      let attributes: [NSAttributedString.Key: Any] = [
        .font: font ?? NSFont.preferredFont(forTextStyle: .body),
        .foregroundColor: NSColor.secondaryLabelColor
      ]
      let storage = NSTextStorage(string: placeholder, attributes: attributes)
      let layout = NSLayoutManager()
      let container = NSTextContainer(size: NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
      container.lineFragmentPadding = 0
      layout.addTextContainer(container)
      storage.addLayoutManager(layout)
      layout.ensureLayout(for: container)
      return (layout, container, storage)
    }

    override func draw(_ dirtyRect: NSRect) {
      super.draw(dirtyRect)

      guard string.isEmpty, !hasMarkedText(), !placeholder.isEmpty else {
        return
      }

      let drawn = placeholderLayout()
      drawn.layout.drawGlyphs(forGlyphRange: drawn.layout.glyphRange(for: drawn.container), at: placeholderOrigin)
    }

    /// Up, Down and Tab with no modifier: the keys of the command list.
    static func completionKey(for event: NSEvent) -> CompletionKey? {
      guard event.modifierFlags.intersection([.shift, .control, .option, .command]).isEmpty else {
        return nil
      }

      switch event.keyCode {
      case 126: return .up
      case 125: return .down
      case 48: return .tab
      default: return nil
      }
    }

    override func keyDown(with event: NSEvent) {
      guard isEnabledForInput else {
        return
      }

      // The command list first, while it is open. Not while an input method is composing: its
      // arrows pick a candidate.
      if completionKeysActive, !hasMarkedText(), let key = Self.completionKey(for: event), onCompletionKey(key) {
        return
      }

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

      if isEnabledForInput, window?.firstResponder === self, Self.returnKeys.contains(event.keyCode), flags.contains(.command) {
        onSend()
        return true
      }

      return super.performKeyEquivalent(with: event)
    }

    // MARK: Drags

    // A text view registers for the files and pictures of a drag too, and then is the one that
    // answers it: a file dropped over the field went in as its path as words (or was refused)
    // instead of reaching the chat's drop target (`attachmentDropTarget`), which attaches it.
    // Files and pictures are therefore not registered for here: they pass over the field to the
    // chat, and words are still the field's own to take.
    override func registerForDraggedTypes(_ newTypes: [NSPasteboard.PasteboardType]) {
      super.registerForDraggedTypes(Self.textDragTypes(in: newTypes))
    }

    /// The types of a drag that the field takes: words, and nothing that is a file or a picture.
    nonisolated static func textDragTypes(in types: [NSPasteboard.PasteboardType]) -> [NSPasteboard.PasteboardType] {
      types.filter { !isAttachmentDragType($0) }
    }

    nonisolated static func isAttachmentDragType(_ type: NSPasteboard.PasteboardType) -> Bool {
      if attachmentDragTypeNames.contains(type.rawValue) {
        return true
      }

      guard let known = UTType(type.rawValue) else {
        return false
      }

      return known.conforms(to: .image) || known.conforms(to: .fileURL) || known.conforms(to: .pdf)
    }

    /// The old names of a file on a drag (and of a file a sender promises to write), which have no
    /// type of the system's to be recognised by.
    private nonisolated static let attachmentDragTypeNames: Set<String> = [
      "NSFilenamesPboardType", "NSFilesPromisePboardType", "NXFileContentsPboardType",
      "com.apple.NSFilePromiseItemProvider", "com.apple.pasteboard.promised-file-url",
      "com.apple.pasteboard.promised-file-content-type"
    ]

    // Said once more where the registration is not enough: a drag that carries files or a picture is
    // never the field's, whatever else it carries beside them.
    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
      Self.carriesAttachment(sender.draggingPasteboard) ? [] : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
      Self.carriesAttachment(sender.draggingPasteboard) ? [] : super.draggingUpdated(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
      Self.carriesAttachment(sender.draggingPasteboard) ? false : super.performDragOperation(sender)
    }

    static func carriesAttachment(_ board: NSPasteboard) -> Bool {
      (board.types ?? []).contains(where: isAttachmentDragType)
    }

    // Text goes in as plain text; files and pictures with no text go to be attached.
    override func paste(_ sender: Any?) {
      guard isEnabledForInput else {
        return
      }

      let items = Self.attachments(on: .general)

      if items.isEmpty {
        super.paste(sender)
      } else {
        onPaste(items)
      }
    }

    override func validateUserInterfaceItem(_ item: any NSValidatedUserInterfaceItem) -> Bool {
      // Asked for on every menu pass, so nothing is read: only whether the pasteboard could give
      // files or a picture. What it holds is read when Paste is chosen.
      if item.action == #selector(paste(_:)), Self.canPasteAttachment(from: .general) {
        return true
      }

      return super.validateUserInterfaceItem(item)
    }

    /// Whether the pasteboard has copied files or a picture, without reading either.
    static func canPasteAttachment(from board: NSPasteboard) -> Bool {
      board.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        || board.availableType(from: [.png, .tiff]) != nil
    }

    /// What on the pasteboard is to be attached rather than typed: copied files first, then a
    /// picture when there are no words with it.
    static func attachments(on board: NSPasteboard) -> [PasteItem] {
      let files =
        (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []

      if !files.isEmpty {
        return files.map(PasteItem.file)
      }

      if let string = board.string(forType: .string), PasteboardText.isWords(string) {
        return []
      }

      if let png = board.data(forType: .png) {
        return [.image(png, .png)]
      }

      if let tiff = board.data(forType: .tiff), let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
        return [.image(png, .png)]
      }

      return []
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

/// What counts as words on a pasteboard that also holds a picture.
enum PasteboardText {
  /// A copied picture often carries its address as text; that is a label, not something the reader
  /// wrote. Anything with a space in it, or that is not one web address, is words.
  static func isWords(_ string: String) -> Bool {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      return false
    }

    if trimmed.contains(where: \.isWhitespace) {
      return true
    }

    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), url.host() != nil else {
      return true
    }

    return !(scheme == "http" || scheme == "https")
  }
}
