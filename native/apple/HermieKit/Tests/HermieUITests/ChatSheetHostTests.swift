import Foundation
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

/// HERM-251 review: the Mac's request pane gets every request of the chat's three sheet modifiers,
/// and nothing typed or pressed while it is up goes out from the composer under it.
@MainActor
@Suite struct ChatSheetHostTests {
  let session = GatewaySession(gatewayID: "sheet-host", link: UnreachableLink())

  private func makeFeed(_ owner: ChatFeedOwner<ChatFeed>) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      ChatFeed(chat: ChatRef(gatewayId: "sheet-host", bot: "writer"), session: session, standardActions: true) { _ in .none }
    }
    return owner.feed
  }

  @Test func theComposerHoldsItsSendWhileARequestHasTheScreen() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(makeFeed(owner))
    feed.composer.draft = "a value typed for a secure prompt"

    feed.requests.present("srq-1")
    await eventually("the composer held") { feed.composer.held }
    #expect(!feed.composer.canSubmit)

    await feed.composer.submit()
    #expect(feed.composer.draft == "a value typed for a secure prompt", "nothing was taken to send")

    feed.requests.dismissSheet()
    await eventually("the composer free again") { !feed.composer.held }
  }

  #if os(macOS)
    @MainActor final class EntryLog {
      var ids: [String] = []

      func record(_ entries: [ChatSheetEntry]) {
        ids = entries.compactMap { $0.id.base as? String }
      }
    }

    /// The chat's three sheet modifiers as the chat screen stacks them, read where the host reads them.
    struct HostedSheets: View {
      let feed: ChatFeed
      let log: EntryLog

      var body: some View {
        Color.clear
          .modifier(ChatRequestSheets(feed: feed))
          .environment(\.chatSheetHosted, true)
          .overlayPreferenceValue(ChatSheetKey.self) { entries in
            let _ = log.record(entries)
            Color.clear
          }
      }
    }

    private func host<Content: View>(_ view: Content) -> (NSWindow, NSHostingView<Content>) {
      let host = NSHostingView(rootView: view)
      host.frame = NSRect(x: 0, y: 0, width: 600, height: 400)
      let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      window.contentView = host
      host.layoutSubtreeIfNeeded()
      return (window, host)
    }

    @Test func anApprovalUnderTheOtherTwoSheetModifiersReachesThePane() async throws {
      let owner = ChatFeedOwner<ChatFeed>()
      let feed = try #require(makeFeed(owner))
      let log = EntryLog()
      // The innermost of the three: the outer two (secure prompts, interactive requests) have nothing.
      feed.requests.present("srq-1")

      let (window, host) = host(HostedSheets(feed: feed, log: log))
      defer { window.close() }
      await eventually("the pane's entries") {
        host.layoutSubtreeIfNeeded()
        return !log.ids.isEmpty
      }
      #expect(log.ids == ["srq-1"], "the outer modifiers add to it, never replace it")

      feed.requests.dismissSheet()
      await eventually("the entry gone") {
        host.layoutSubtreeIfNeeded()
        return log.ids.isEmpty
      }
    }

    struct Shown: Identifiable {
      let id: String
    }

    /// Three request sheets stacked as the chat stacks them (approvals inside, secure prompts in the
    /// middle, interactive requests outside), each with a request of its own or none.
    struct ThreeSheets: View {
      @State var inner: Shown?
      @State var middle: Shown?
      @State var outer: Shown?
      let log: EntryLog

      var body: some View {
        Color.clear
          .chatSheet(item: $inner) { _ in Text("approval") }
          .chatSheet(item: $middle) { _ in Text("secure prompt") }
          .chatSheet(item: $outer) { _ in Text("form") }
          .environment(\.chatSheetHosted, true)
          .overlayPreferenceValue(ChatSheetKey.self) { entries in
            let _ = log.record(entries)
            Color.clear
          }
      }
    }

    @Test(arguments: [
      (inner: "srq-a", middle: nil, outer: nil, expected: ["srq-a"]),
      (inner: nil, middle: "srq-s", outer: nil, expected: ["srq-s"]),
      (inner: nil, middle: nil, outer: "srq-f", expected: ["srq-f"]),
      (inner: "srq-a", middle: "srq-s", outer: nil, expected: ["srq-a", "srq-s"])
    ] as [(inner: String?, middle: String?, outer: String?, expected: [String])])
    func aRequestAtAnyLevelReachesThePane(inner: String?, middle: String?, outer: String?, expected: [String]) async throws {
      let log = EntryLog()
      let view = ThreeSheets(
        inner: inner.map(Shown.init(id:)), middle: middle.map(Shown.init(id:)), outer: outer.map(Shown.init(id:)), log: log)
      let (window, host) = host(view)
      defer { window.close() }

      await eventually("the pane's entries") {
        host.layoutSubtreeIfNeeded()
        return !log.ids.isEmpty
      }
      #expect(log.ids == expected, "a secure prompt in the middle is never hidden by the outer sheet")
    }

    @Test func theChatsComposerSlotIsOffWhileARequestIsUp() async throws {
      let owner = ChatFeedOwner<ChatFeed>()
      let feed = try #require(makeFeed(owner))
      // The composer's own text field in the chat's slot, without the rest of the composer: the slot's
      // `.disabled` is what is tested, and the field is what it must reach.
      let slot = ComposerSlot(chat: feed.chat, session: session, feed: feed) { context in
        ComposerTextField(
          text: Binding(get: { context.composer.draft }, set: { context.composer.type($0) }), placeholder: "",
          accessibilityLabel: "", accessibilityHint: "", maxLines: 6, controlHeight: 36, focusRequest: 0,
          onFocusChange: { _ in }, onSend: {}, onEscape: { false }, onPaste: { _ in }, completionKeysActive: false,
          onCompletionKey: { _ in false })
      }
      let (window, host) = host(slot)
      defer { window.close() }
      let field = try #require(Self.textView(in: host))
      #expect(window.makeFirstResponder(field))

      feed.requests.present("srq-1")
      await eventually("the field off") {
        host.layoutSubtreeIfNeeded()
        return !field.isEditable
      }
      #expect(window.firstResponder !== field, "the keyboard is given up under the request")

      await eventually("the composer held") { feed.composer.held }
      feed.composer.type("a value typed for the secure prompt")
      #expect(feed.composer.draft.isEmpty, "typing is refused while held")

      feed.requests.dismissSheet()
      await eventually("the field on again") {
        host.layoutSubtreeIfNeeded()
        return field.isEditable
      }
    }

    /// The composer's text field, covered or not.
    struct Field: View {
      @State var text = ""
      let covered: Bool

      var body: some View {
        ComposerTextField(
          text: $text, placeholder: "", accessibilityLabel: "", accessibilityHint: "", maxLines: 6, controlHeight: 36,
          focusRequest: 0, onFocusChange: { _ in }, onSend: {}, onEscape: { false }, onPaste: { _ in },
          completionKeysActive: false, onCompletionKey: { _ in false }
        )
        .disabled(covered)
      }
    }

    private static func textView(in view: NSView) -> NSTextView? {
      if let text = view as? NSTextView {
        return text
      }

      return view.subviews.lazy.compactMap { textView(in: $0) }.first
    }

    @Test func theComposerFieldGivesUpTheKeyboardAndTakesNoTypingWhileCovered() throws {
      let (window, host) = host(Field(covered: false))
      defer { window.close() }
      let field = try #require(Self.textView(in: host))

      #expect(window.makeFirstResponder(field))
      #expect(field.isEditable)

      host.rootView = Field(covered: true)
      host.layoutSubtreeIfNeeded()

      #expect(!field.isEditable, "covered: not editable")
      #expect(window.firstResponder !== field, "covered: the keyboard is given up")
      #expect(!field.acceptsFirstResponder, "and not taken again (Tab, a click)")

      let key = try #require(
        NSEvent.keyEvent(
          with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
          context: nil, characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7))
      field.keyDown(with: key)
      #expect(field.string.isEmpty, "a key reaching it anyway types nothing")

      host.rootView = Field(covered: false)
      host.layoutSubtreeIfNeeded()
      #expect(field.isEditable)
      #expect(field.acceptsFirstResponder)
    }
  #endif
}
