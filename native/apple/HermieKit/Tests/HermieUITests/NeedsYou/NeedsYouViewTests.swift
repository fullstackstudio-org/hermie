import Foundation
import HermieCore
import HermieShared
import Testing

@testable import HermieUI

/// The parts of the "Needs you" inbox and the emergency stop that are plain functions: where a row
/// leads, the router's sheets, the words of both screens. (The views themselves are not driven by UI
/// tests.)
@MainActor
@Suite("Needs you and the emergency stop: the shell's side")
struct NeedsYouViewTests {
  private func router() -> AppRouter {
    let router = AppRouter()

    _ = router.gatewaysChanged(
      GatewayIndex(
        entries: [GatewayIndex.Entry(id: "g1", key: "1111111111111111"), GatewayIndex.Entry(id: "g2", key: "2222222222222222")],
        activeId: "g1"))

    return router
  }

  private func item(
    _ id: String = "srq-1", bot: String = "researcher", gateway: String = "g1", key: String = "1111111111111111",
    kind: NeedsYouKind = .input, method: String = "input.form"
  ) -> NeedsYouItem {
    NeedsYouItem(
      id: "\(gateway)\u{1F}\(id)", gatewayId: gateway, gatewayName: "Home", gatewayKey: key, bot: bot,
      kind: kind, method: method, requestId: id, since: Date())
  }

  // MARK: Where a row leads

  @Test("a row opens the bot's chat and brings its request back, and its own sheet goes")
  func rowOpensTheChat() {
    let router = router()
    router.present(.needsYou)

    var brought: [String] = []
    var effects: [[RouterEffect]] = []

    NeedsYouOpening.open(
      item(), in: router,
      bringBack: { key, bot, id in brought.append("\(key)/\(bot)/\(id)") },
      activate: { effects.append($0) })

    #expect(router.selectedChat == ChatRef(gatewayId: "g1", bot: "researcher"))
    #expect(router.sheet == nil, "the list stood over the chat")
    #expect(brought == ["1111111111111111/researcher/srq-1"])
    #expect(effects == [[]], "the live gateway needs no switching")
  }

  @Test("two rows of two bots lead to two different chats, each with its own request")
  func rowsLeadToTheirOwnChats() {
    let router = router()
    var brought: [String] = []

    for row in [item("appr-1", bot: "writer", kind: .approval, method: "approval"), item("srq-9", bot: "analyst")] {
      router.present(.needsYou)
      NeedsYouOpening.open(row, in: router, bringBack: { _, bot, id in brought.append("\(bot)/\(id)") }, activate: { _ in })
    }

    #expect(router.selectedChat == ChatRef(gatewayId: "g1", bot: "analyst"))
    #expect(brought == ["writer/appr-1", "analyst/srq-9"])
  }

  @Test("a row of another gateway selects that gateway's chat and asks for the gateway to be made live")
  func rowOfAnotherGateway() {
    let router = router()
    var effects: [RouterEffect] = []

    NeedsYouOpening.open(
      item(bot: "ops", gateway: "g2", key: "2222222222222222"), in: router, bringBack: { _, _, _ in },
      activate: { effects += $0 })

    #expect(router.selectedChat == ChatRef(gatewayId: "g2", bot: "ops"))
    #expect(effects == [.activateGateway("g2")])
  }

  @Test("the link a row follows is the one a notification's tap follows")
  func theLink() {
    #expect(NeedsYouOpening.link(for: item()) == .chat(bot: "researcher", gatewayKey: "1111111111111111"))
  }

  @Test("another sheet that is up is not the inbox's to close")
  func leavesOtherSheets() {
    let router = router()
    router.present(.newBot)

    NeedsYouOpening.open(item(), in: router, bringBack: { _, _, _ in }, activate: { _ in })
    #expect(router.sheet == .newBot)
  }

  // MARK: The router's sheets

  @Test("the inbox and the emergency stop are sheets of the router")
  func sheets() {
    let router = router()

    router.present(.needsYou)
    #expect(router.sheet == .needsYou)
    router.dismissSheet(.emergencyStop)
    #expect(router.sheet == .needsYou, "another sheet's dismissal leaves it up")

    router.present(.emergencyStop)
    #expect(router.sheet == .emergencyStop)
    router.dismissSheet(.emergencyStop)
    #expect(router.sheet == nil)
  }

  // MARK: The words

  @Test("every kind has a symbol and a sentence, and a title is the contract's phrase")
  func kindsAndTitles() {
    #expect(Set(NeedsYouKind.allCases.map(\.symbol)).count == NeedsYouKind.allCases.count, "told apart by their symbol")
    #expect(NeedsYouKind.allCases.allSatisfy { !NativeStrings.NeedsYou.kind($0).isEmpty })
    #expect(!NativeStrings.NeedsYou.kind(.approval).hasPrefix("native."))

    let copy = NeedsYouCopy.localized
    #expect(copy.connector == NativeStrings.NeedsYou.connectorTitle)

    for method in PushRequestMethod.allCases {
      let row = NeedsYouItem(
        id: method.rawValue, gatewayId: "g1", bot: "researcher", kind: NeedsYouKind(method: method.rawValue),
        method: method.rawValue, requestId: "x", since: Date())
      let title = row.title(copy: copy)

      #expect(!title.isEmpty && !title.hasPrefix("native."), "\(method.rawValue) has a title")
    }
  }

  @Test("the count and the stop's question follow the number")
  func plurals() {
    #expect(NativeStrings.NeedsYou.count(1).contains("1"))
    #expect(NativeStrings.NeedsYou.count(3).contains("3"))
    #expect(NativeStrings.NeedsYou.count(1) != NativeStrings.NeedsYou.count(3))
    #expect(NativeStrings.EmergencyStop.confirmTitle(4).contains("4"))
    #expect(NativeStrings.EmergencyStop.confirmTitle(1) != NativeStrings.EmergencyStop.confirmTitle(4))
    #expect(NativeStrings.EmergencyStop.unreachable(2).contains("2"))
  }

  @Test("an outcome has its own sentence, and a failure carries the gateway's words")
  func outcomes() {
    let sentences = [
      NativeStrings.EmergencyStop.outcome(.stopped), NativeStrings.EmergencyStop.outcome(.alreadyDone),
      NativeStrings.EmergencyStop.outcome(.notConnected)
    ]

    #expect(Set(sentences).count == 3)
    #expect(NativeStrings.EmergencyStop.outcome(.failed("session not found")).contains("session not found"))
    #expect(sentences.allSatisfy { !$0.hasPrefix("native.") })
  }

  @Test("a turn is named by its bot, else by the gateway's title, else as another session")
  func names() {
    #expect(StopNames.name(of: RunningTurn(id: "1", botName: "Researcher", title: "ignored")) == "Researcher")
    #expect(StopNames.name(of: RunningTurn(id: "1", title: "Nightly report")) == "Nightly report")
    #expect(StopNames.name(of: RunningTurn(id: "1")) == NativeStrings.EmergencyStop.unnamed)
  }

  @Test(arguments: [
    "native.needsYou.title", "native.needsYou.empty.title", "native.needsYou.empty.message",
    "native.needsYou.waiting", "native.needsYou.rowHint", "native.needsYou.otherGateways",
    "native.needsYou.connectorTitle", "native.needsYou.kind.approval", "native.needsYou.kind.question",
    "native.needsYou.kind.secureInput", "native.needsYou.kind.confirmation", "native.needsYou.kind.input",
    "native.needsYou.kind.review", "native.needsYou.kind.device", "native.needsYou.kind.connector",
    "native.needsYou.kind.other", "native.commands.stopAll", "native.emergencyStop.looking",
    "native.emergencyStop.confirmMessage", "native.emergencyStop.stopping", "native.emergencyStop.idle.title",
    "native.emergencyStop.idle.message", "native.emergencyStop.summary.allStopped",
    "native.emergencyStop.summary.someFailed", "native.emergencyStop.summary.stopped",
    "native.emergencyStop.summary.alreadyDone", "native.emergencyStop.summary.failed", "native.emergencyStop.unnamed",
    "native.emergencyStop.notAsked", "native.emergencyStop.incomplete", "native.emergencyStop.outcome.stopped",
    "native.emergencyStop.outcome.alreadyDone", "native.emergencyStop.outcome.notConnected",
    "native.emergencyStop.outcome.failed", "native.emergencyStop.button"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }
}
