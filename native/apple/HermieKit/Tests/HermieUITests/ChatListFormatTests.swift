import Foundation
import SwiftUI
import HermieCore
import HermieTranscript
import Testing

@testable import HermieUI

/// The chat list's row rules and the chat screen's row pipeline, without a view.
@MainActor
@Suite("Chat list and chat rows")
struct ChatListFormatTests {
  static func row(
    _ name: String,
    display: String? = nil,
    preview: ChatPreview? = nil,
    description: String = "",
    unread: Int = 0,
    lastActive: Double = 0
  ) -> ChatListRow {
    let canonical = lastActive > 0 ? CanonicalSession(id: "s-\(name)", resolvedID: "s-\(name)", lastActive: lastActive) : nil
    return ChatListRow(
      bot: Bot(name: name, displayName: display, description: description, canonical: canonical),
      preview: preview,
      unreadCount: unread,
      attached: true
    )
  }

  @Test("the search keeps the roster's order and matches the display name or the handle")
  func filtering() {
    let rows = [
      "alpha": Self.row("alpha", display: "Research Desk"),
      "beta": Self.row("beta", display: "Writer"),
      "gamma": Self.row("gamma", display: "Résumé helper")
    ]
    let names = ["gamma", "alpha", "beta"]

    #expect(ChatListFormat.filtered(names, rows: rows, query: "").map(\.id) == names)
    #expect(ChatListFormat.filtered(names, rows: rows, query: "  ").map(\.id) == names)
    #expect(ChatListFormat.filtered(names, rows: rows, query: "desk").map(\.id) == ["alpha"])
    #expect(ChatListFormat.filtered(names, rows: rows, query: "BET").map(\.id) == ["beta"])
    #expect(ChatListFormat.filtered(names, rows: rows, query: "resume").map(\.id) == ["gamma"], "diacritics are ignored")
    #expect(ChatListFormat.filtered(names + ["gone"], rows: rows, query: "").count == 3, "a name without a row is skipped")
  }

  @Test("the preview is one line without Markdown, else the description, else no messages yet")
  func preview() {
    let online = Presence.of(gatewayReady: true, sessionAttached: true, working: false, needsInput: false)
    let markdown = ChatPreview(text: "## Heading\n\nSome *bold* words", system: false)
    #expect(ChatListFormat.preview(Self.row("a", preview: markdown), presence: online).text == "Heading Some bold words")

    let fromBot = ChatPreview(text: "hello", fromHandle: "writer", system: false)
    #expect(ChatListFormat.preview(Self.row("a", preview: fromBot), presence: online).text == "@writer: hello")

    let long = ChatPreview(text: String(repeating: "word ", count: 60), system: false)
    let cut = ChatListFormat.preview(Self.row("a", preview: long), presence: online).text
    #expect(cut.count <= ChatListFormat.previewLimit + 1)
    #expect(cut.hasSuffix("…"))

    let described = ChatListFormat.preview(Self.row("a", description: "Finds things out."), presence: online)
    #expect(described.text == "Finds things out.")
    #expect(described.quiet)

    #expect(ChatListFormat.preview(Self.row("a"), presence: online).text == Strings.App.Bots.noPreview)
  }

  @Test("an offline bot that was heard from says when instead of its last message")
  func offlinePreview() {
    let row = Self.row("a", preview: ChatPreview(text: "stale words", system: false), lastActive: 1_700_000_000)
    let presence = row.presence(gatewayReady: false)
    #expect(presence.state == .offline)
    #expect(ChatListFormat.preview(row, presence: presence).text != "stale words")
    #expect(!ChatListFormat.stamp(row, presence: presence).isEmpty)
  }

  @Test("list times: nothing, now, the clock today, the weekday this week, else the date")
  func listTime() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let seconds = now.timeIntervalSince1970

    #expect(ChatListFormat.listTime(0, now: now, calendar: calendar).isEmpty)
    #expect(ChatListFormat.listTime(.nan, now: now, calendar: calendar).isEmpty)
    #expect(!ChatListFormat.listTime(seconds - 10, now: now, calendar: calendar).isEmpty)

    let earlier = ChatListFormat.listTime(seconds - 3 * 86_400, now: now, calendar: calendar)
    let older = ChatListFormat.listTime(seconds - 30 * 86_400, now: now, calendar: calendar)
    #expect(!earlier.isEmpty)
    #expect(!older.isEmpty)
    #expect(earlier != older)
  }

  @Test("the row's label says the name, the presence and the unread count, in that order")
  func accessibilityLabel() {
    let row = Self.row("helper", display: "Helper", unread: 3)
    let label = ChatListFormat.accessibilityLabel(row, presence: Presence.of(gatewayReady: true, sessionAttached: true, working: false, needsInput: false))
    #expect(label == ["Helper", "helper", Strings.App.Presence.online, Strings.App.Bots.unreadLabel(count: 3)].joined(separator: ", "))
  }

  /// `swift test` runs on the Mac, where text does not scale with Dynamic Type, so this proves the
  /// row renders and never shrinks at AX5; the simulator's audit in `ChatScreenUITests` checks
  /// for clipped text.
  @Test("a row renders at AX5 and never shrinks")
  func rowAtAccessibilitySizes() throws {
    let long = ChatPreview(text: String(repeating: "a fairly long last message ", count: 8), system: false)
    let row = ChatListRow(
      bot: Bot(name: "helper", displayName: "A helper with a rather long display name"),
      preview: long,
      unreadCount: 12,
      needsInput: true,
      attached: true,
      lastMessageAt: 1_790_000_000
    )

    func height(_ size: DynamicTypeSize) throws -> Int {
      let renderer = ImageRenderer(
        content: ChatListRowView(row: row, gatewayReady: true).frame(width: 390).dynamicTypeSize(size)
      )
      renderer.proposedSize = ProposedViewSize(width: 390, height: nil)
      return try #require(renderer.cgImage, "the row rendered at \(size)").height
    }

    let regular = try height(.large)
    let largest = try height(.accessibility5)
    #expect(regular > 0)
    #expect(largest >= regular)
  }

  @Test("the pipeline counts new replies below the newest row, never history prepended above")
  func arrivals() async {
    func item(_ id: String, _ text: String = "x") -> VisibleItem {
      VisibleItem(
        item: .assistant(AssistantItem(base: ItemBase(id: id, seq: 0, origin: .live, version: 1), text: text, streaming: false, interim: false)),
        presentation: .full
      )
    }

    let pipeline = ChatRowPipeline()
    let first = await pipeline.rows(for: [item("a"), item("b")])
    #expect(first.arrived == 0, "the first rows are the chat, not arrivals")
    #expect(first.rows.count == 2)

    let appended = await pipeline.rows(for: [item("a"), item("b"), item("c"), item("d")])
    #expect(appended.arrived == 2)

    let prepended = await pipeline.rows(for: [item("y"), item("z"), item("a"), item("b"), item("c"), item("d")])
    #expect(prepended.arrived == 0)
  }
}
