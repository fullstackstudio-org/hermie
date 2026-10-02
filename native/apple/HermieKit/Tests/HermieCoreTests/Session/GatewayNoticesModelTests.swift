import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

@MainActor
private func notice(
  _ text: String,
  level: String = "info",
  kind: String = "sticky",
  ttlMs: Int? = nil,
  key: String? = nil,
  id: String? = nil
) -> NotificationShowPayload {
  var payload = NotificationShowPayload()
  payload.text = text
  payload.level = NoticeLevel(rawValue: level)
  payload.kind = NoticeLifetime(rawValue: kind)
  payload.ttlMs = ttlMs
  payload.key = key
  payload.id = id
  return payload
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct GatewayNoticesModelTests {
  @Test func aKeyedNoticeReplacesItselfInPlaceAndAClearWithdrawsIt() {
    let model = GatewayNoticesModel(clock: ManualClock())
    model.show(notice("First line", key: "a"), chat: nil)
    model.show(notice("You've used $5 of $10", level: "warn", key: "credits.usage"), chat: "researcher")
    model.show(notice("You've used $8 of $10", level: "warn", key: "credits.usage"), chat: "researcher")

    #expect(model.notices.map(\.id) == ["a", "credits.usage"])
    #expect(model.notice("credits.usage")?.text == "You've used $8 of $10")
    #expect(model.notice("credits.usage")?.level == .warn)
    #expect(model.notice("credits.usage")?.chat == "researcher")

    model.clear(key: "credits.usage")
    #expect(model.notices.map(\.id) == ["a"])
    model.clear(key: "nothing-here")
    #expect(model.notices.count == 1)
  }

  @Test func aTimedNoticeExpiresOnTheClockAndAStickyOneStays() async {
    let clock = ManualClock()
    let model = GatewayNoticesModel(clock: clock)
    model.show(notice("Saved", kind: "ttl", ttlMs: 3_000, key: "t"), chat: nil)
    model.show(notice("No lifetime given", kind: "ttl", key: "default"), chat: nil)
    model.show(notice("Still starting the agent", kind: "agent", key: "agent.slow"), chat: nil)
    model.show(notice("Paused", kind: "sticky", key: "s"), chat: nil)

    await clock.advance(by: .milliseconds(2_999))
    #expect(model.notices.count == 4)
    await clock.advance(by: .milliseconds(1))
    #expect(model.notice("t") == nil)
    await clock.advance(by: GatewayNoticesModel.defaultLifetime)
    #expect(model.notice("default") == nil)
    await clock.advance(by: .seconds(3_600))
    #expect(model.notices.map(\.id) == ["agent.slow", "s"])
  }

  @Test func aReplacedNoticeKeepsItsOwnLifetimeNotTheOneItReplaced() async {
    let clock = ManualClock()
    let model = GatewayNoticesModel(clock: clock)
    model.show(notice("one", kind: "ttl", ttlMs: 1_000, key: "k"), chat: nil)
    await clock.advance(by: .milliseconds(900))
    model.show(notice("two", kind: "ttl", ttlMs: 1_000, key: "k"), chat: nil)
    await clock.advance(by: .milliseconds(200))
    #expect(model.notice("k")?.text == "two", "the first notice's timer does not take the second")
    await clock.advance(by: .milliseconds(800))
    #expect(model.notice("k") == nil)
  }

  @Test func theListIsBoundedAndTheOldestGoesFirst() {
    let model = GatewayNoticesModel(clock: ManualClock())

    for index in 0..<(GatewayNoticesModel.maxNotices + 3) {
      model.show(notice("notice \(index)", key: "k\(index)"), chat: nil)
    }

    #expect(model.notices.count == GatewayNoticesModel.maxNotices)
    #expect(model.notices.first?.id == "k3")
  }

  @Test func theTextIsPlainAndBounded() {
    let model = GatewayNoticesModel(clock: ManualClock())
    let spoof = "\u{202E}txt.exe\u{202C} ok\u{0007}\r\nsecond\tline  "
    model.show(notice(spoof, key: "a"), chat: nil)
    #expect(model.notice("a")?.text == "txt.exe ok\nsecond line")

    model.show(notice(String(repeating: "x", count: 5_000), key: "long"), chat: nil)
    let long = model.notice("long")?.text ?? ""
    #expect(long.count == GatewayNoticesModel.maxTextLength)
    #expect(long.hasSuffix("…"))

    model.show(notice("  \u{0001} ", key: "blank"), chat: nil)
    #expect(model.notice("blank") == nil, "nothing to show is not shown")
  }

  @Test func aNoticeWithoutAKeyUsesItsIdAndOtherwiseGetsOneOfItsOwn() {
    let model = GatewayNoticesModel(clock: ManualClock())
    model.show(notice("by id", id: "n-1"), chat: nil)
    model.show(notice("anonymous"), chat: nil)
    model.show(notice("anonymous again"), chat: nil)

    #expect(model.notices.count == 3)
    #expect(model.notice("n-1")?.text == "by id")
    model.dismiss("n-1")
    #expect(model.notices.count == 2)
    model.removeAll()
    #expect(model.notices.isEmpty)
  }
}
