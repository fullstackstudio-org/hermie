import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The "Needs you" inbox: one list over every bot and gateway, oldest first, with the count the
/// badge shows. Fed with fake request models; no session is involved.
@MainActor
@Suite("Needs you: the inbox", .timeLimit(.minutes(1)))
struct NeedsYouInboxTests {
  /// A clock the test moves.
  final class Clock {
    var now = Date(timeIntervalSince1970: 1_790_000_000)
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
  }

  private func request(
    _ id: String, bot: String = "researcher", method: String = "approval", gateway: String = "g1",
    text: String = "", level: PushConfirmLevel? = nil
  ) -> OpenRequest {
    OpenRequest(
      gatewayId: gateway, chat: bot, chatName: bot.capitalized, method: method, requestId: id, level: level,
      text: text)
  }

  private func target(_ name: String, _ state: ConnectionTargetState = .pending) -> ConnectionTarget {
    ConnectionTarget(
      name: name, kind: "connector", action: "authorize", state: state, detail: "", instructions: nil, link: nil,
      linkRefused: false, opened: false)
  }

  private func card(_ opID: String, chat: String = "writer", targets: [ConnectionTarget]) -> ConnectionRequest {
    ConnectionRequest(
      chat: chat, runtimeSessionID: "rt-1", opID: opID, toolCallID: "tc-1", seq: 1,
      deadline: Date(timeIntervalSince1970: 1_790_001_000), targets: targets)
  }

  private func update(
    _ inbox: NeedsYouInbox, gateway: String = "g1", name: String = "Home", _ requests: [OpenRequest],
    connections: [ConnectionRequest] = [], authoritative: Bool = true
  ) {
    inbox.update(
      gatewayId: gateway, gatewayName: name, gatewayKey: "key-\(gateway)", requests: requests,
      connections: connections, chatName: { $0.capitalized }, authoritative: authoritative)
  }

  // MARK: What it lists

  @Test("every kind of request is one row, with its kind, its bot and its gateway")
  func listsEveryKind() {
    let clock = Clock()
    let inbox = NeedsYouInbox(now: { clock.now })

    let all = [
      request("appr-1", method: "approval", text: "Delete the build folder"),
      request("srq-c", bot: "writer", method: "clarify", text: "Which format?"),
      request("srq-s", method: "secret"),
      request("srq-p", method: "sudo"),
      request("srq-conf", method: "confirm", level: .passkey),
      request("srq-f", method: "input.form"),
      request("srq-d", method: "review.draft"),
      request("srq-loc", method: "device.location"),
      request("srq-new", method: "from.the.future")
    ]

    update(inbox, all, connections: [card("op-1", targets: [target("GitHub")])])

    #expect(inbox.count == 10)

    let kinds = Dictionary(uniqueKeysWithValues: inbox.items.map { ($0.requestId, $0.kind) })
    #expect(kinds["appr-1"] == .approval)
    #expect(kinds["srq-c"] == .question)
    #expect(kinds["srq-s"] == .secureInput)
    #expect(kinds["srq-p"] == .secureInput)
    #expect(kinds["srq-conf"] == .confirmation)
    #expect(kinds["srq-f"] == .input)
    #expect(kinds["srq-d"] == .review)
    #expect(kinds["srq-loc"] == .device)
    #expect(kinds["srq-new"] == .other)
    #expect(kinds["op-1"] == .connector)

    let approval = inbox.items.first { $0.requestId == "appr-1" }
    #expect(approval?.gatewayId == "g1")
    #expect(approval?.gatewayName == "Home")
    #expect(approval?.gatewayKey == "key-g1")
    #expect(approval?.bot == "researcher")
    #expect(approval?.displayBot == "Researcher")
  }

  @Test("a connector card is listed while a row of it waits, and not once all of its rows are settled")
  func connectorCards() {
    let inbox = NeedsYouInbox()

    update(inbox, [], connections: [card("op-1", targets: [target("GitHub", .connected), target("Linear", .pending)])])
    #expect(inbox.items.map(\.requestId) == ["op-1"])
    #expect(inbox.items.first?.targets == ["Linear"], "only what still waits is named")
    #expect(inbox.items.first?.bot == "writer")
    #expect(inbox.items.first?.botName == "Writer")

    update(inbox, [], connections: [card("op-1", targets: [target("GitHub", .connected), target("Linear", .skipped)])])
    #expect(inbox.isEmpty)
  }

  // MARK: Ordering

  @Test("the oldest waits at the top, whichever bot or gateway; ties go by bot name, then id")
  func ordering() {
    let clock = Clock()
    let inbox = NeedsYouInbox(now: { clock.now })

    update(inbox, [request("a-1", bot: "writer")])
    clock.advance(60)
    update(inbox, gateway: "g2", name: "Work", [request("b-1", bot: "researcher", gateway: "g2")])
    clock.advance(60)
    // Two that arrive together: the bot's name decides, then the id.
    update(inbox, [request("a-1", bot: "writer"), request("z-9", bot: "writer"), request("y-1", bot: "analyst")])

    #expect(inbox.items.map(\.requestId) == ["a-1", "b-1", "y-1", "z-9"])
    #expect(inbox.gatewayIds == ["g1", "g2"])
  }

  @Test("how long it has waited is from the first time it was seen, and a later list does not restart it")
  func firstSeenSticks() {
    let clock = Clock()
    let inbox = NeedsYouInbox(now: { clock.now })
    let first = clock.now

    update(inbox, [request("appr-1")])
    clock.advance(300)
    update(inbox, [request("appr-1"), request("srq-2", method: "secret")])

    #expect(inbox.items.map(\.requestId) == ["appr-1", "srq-2"])
    #expect(inbox.items[0].since == first)
    #expect(inbox.items[1].since == first.addingTimeInterval(300))

    // Gone and back (a new request under the same id): it starts again.
    update(inbox, [request("srq-2", method: "secret")])
    clock.advance(10)
    update(inbox, [request("srq-2", method: "secret"), request("appr-1")])
    #expect(inbox.items.first { $0.requestId == "appr-1" }?.since == first.addingTimeInterval(310))
  }

  // MARK: Counts across gateways

  @Test("the count is everything waiting, per gateway and in all; the same id on two gateways is two requests")
  func countsAcrossGateways() {
    let inbox = NeedsYouInbox()

    update(inbox, [request("srq-1", method: "secret"), request("srq-2", bot: "writer", method: "input.form")])
    update(inbox, gateway: "g2", name: "Work", [request("srq-1", method: "secret", gateway: "g2")])

    #expect(inbox.count == 3)
    #expect(inbox.count(for: "g1") == 2)
    #expect(inbox.count(for: "g2") == 1)
    #expect(inbox.count(for: "g3") == 0)

    // One gateway's request ends; the other's is untouched.
    update(inbox, [request("srq-2", bot: "writer", method: "input.form")])
    #expect(inbox.count == 2)
    #expect(inbox.items.contains { $0.gatewayId == "g2" && $0.requestId == "srq-1" })

    inbox.sessionEnded(gatewayId: "g2")
    #expect(inbox.items.map(\.gatewayId) == ["g1"])
    #expect(inbox.count == 1)

    inbox.sessionEnded(gatewayId: "g1")
    #expect(inbox.isEmpty)
  }

  @Test("a list that cannot be trusted adds what is new and takes nothing away")
  func notAuthoritative() {
    let inbox = NeedsYouInbox()

    update(inbox, [request("appr-1")])
    update(inbox, [request("srq-2", method: "secret")], authoritative: false)
    #expect(Set(inbox.items.map(\.requestId)) == ["appr-1", "srq-2"])

    update(inbox, [request("srq-2", method: "secret")], authoritative: true)
    #expect(inbox.items.map(\.requestId) == ["srq-2"])
  }

  @Test("a request of another gateway in a list for this one is ignored")
  func ignoresForeignRequests() {
    let inbox = NeedsYouInbox()

    update(inbox, [request("srq-1", method: "secret", gateway: "g9")])
    #expect(inbox.isEmpty)
  }

  // MARK: What a title may say

  @Test("only an approval's or a question's own line reaches a row; a secure prompt, a form and a draft never carry text")
  func textIsBounded() {
    let inbox = NeedsYouInbox()

    update(
      inbox,
      [
        request("appr-1", method: "approval", text: "Delete the build folder"),
        request("srq-s", method: "secret", text: "sk-live-0123456789"),
        request("srq-f", method: "input.form", text: "Social security number"),
        request("srq-d", method: "review.draft", text: "Dear bank, here is my password")
      ])

    let texts = Dictionary(uniqueKeysWithValues: inbox.items.map { ($0.requestId, $0.text) })
    #expect(texts["appr-1"] == "Delete the build folder")
    #expect(texts["srq-s"] == "")
    #expect(texts["srq-f"] == "")
    #expect(texts["srq-d"] == "")

    let titles = inbox.items.map { $0.title(copy: .english) }
    #expect(titles.contains("Needs your approval: Delete the build folder"))
    #expect(titles.contains("Needs a secret"))
    #expect(titles.contains("Has a form for you"))
    #expect(titles.contains("Has a draft to review"))
    #expect(!titles.joined().contains("sk-live"))
    #expect(!titles.joined().contains("password"))
  }

  @Test("a title is one bounded line, and names a connection's connectors")
  func titles() {
    let long = String(repeating: "a long reason ", count: 40)
    let inbox = NeedsYouInbox()

    update(
      inbox, [request("appr-1", text: long + "\nsecond line")],
      connections: [
        card("op-1", targets: [target("GitHub"), target("Linear"), target("Slack"), target("Notion"), target("Jira")])
      ])

    let approval = inbox.items.first { $0.requestId == "appr-1" }
    let title = approval?.title(copy: .english) ?? ""
    #expect(title.hasPrefix("Needs your approval: a long reason"))
    #expect(!title.contains("\n"))
    #expect(title.count <= "Needs your approval: ".count + NeedsYouItem.textLimit + 1, "bounded, with its ellipsis")

    let connector = inbox.items.first { $0.kind == .connector }
    #expect(connector?.title(copy: .english) == "Connect an account to continue: GitHub, Linear, Slack …")
  }

  @Test("a confirm names the passkey when that is the level, and the kinds are told from the wire method")
  func confirmAndKinds() {
    let item = NeedsYouItem(
      id: "x", gatewayId: "g1", bot: "researcher", kind: .confirmation, method: "confirm", requestId: "srq-1",
      level: .passkey, since: Date())
    #expect(item.title(copy: .english) == "Confirm this in the app")

    #expect(NeedsYouKind(method: "vault.unlock_prompt") == .secureInput)
    #expect(NeedsYouKind(method: "vault.something_new") == .secureInput)
    #expect(NeedsYouKind(method: "input.signature") == .input)
    #expect(NeedsYouKind(method: "review.diff") == .review)
    #expect(NeedsYouKind(method: "device.scan") == .device)
    #expect(NeedsYouKind(method: "connection.request") == .connector)
    #expect(NeedsYouKind(method: "") == .other)
  }
}
