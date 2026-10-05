import Foundation
import HermieCore
import HermieShared
import HermieStore
import SwiftUI
import Testing

@testable import HermieUI

private let home = GatewayIndex.Entry(id: "g0011223344556677", key: "aaaaaaaaaaaaaaaa")
private let work = GatewayIndex.Entry(id: "g8899aabbccddeeff", key: "bbbbbbbbbbbbbbbb")
private let both = GatewayIndex(entries: [home, work], activeId: home.id)

@MainActor
@Suite("Router: Handoff and Ask a bot")
struct HandoffRoutingTests {
  // MARK: What is advertised

  @Test("nothing is advertised before a chat is open or the gateway list is read")
  func nothingOpen() {
    let router = AppRouter()

    #expect(router.handoffLink == nil)

    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))
    #expect(router.handoffLink == nil, "no gateway list yet, so no key to name the gateway by")

    router.gatewaysChanged(both)
    #expect(router.handoffLink == .chat(bot: "alice", gatewayKey: home.key))
  }

  @Test("the open chat is advertised under its gateway's key")
  func openChat() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(url: URL(string: "hermie://chat/alice?gateway=\(work.key)")!)

    #expect(router.handoffLink == .chat(bot: "alice", gatewayKey: work.key))

    router.closeChat()
    #expect(router.handoffLink == nil)
  }

  @Test("a conversation open in the viewer is advertised with its session, and the chat again once it is closed")
  func conversation() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: home.id, bot: "alice")

    router.gatewaysChanged(both)
    router.openChat(chat)
    router.showConversation(chat, id: "20260930_101500_ab12cd", resolvedID: "20260930_101500_ab12cd", title: "Past")

    #expect(router.handoffLink == .conversation(bot: "alice", session: "20260930_101500_ab12cd", gatewayKey: home.key))

    router.pop()
    #expect(router.handoffLink == .chat(bot: "alice", gatewayKey: home.key))
  }

  @Test("a conversation id outside the link's alphabet falls back to the chat")
  func unnameableConversation() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: home.id, bot: "alice")

    router.gatewaysChanged(both)
    router.openChat(chat)
    router.showConversation(chat, id: "a/b", resolvedID: "a/b", title: "")

    #expect(router.handoffLink == .chat(bot: "alice", gatewayKey: home.key))
  }

  @Test("the advertised link never holds a title or any words of the conversation")
  func noWords() throws {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: home.id, bot: "alice")

    router.gatewaysChanged(both)
    router.openChat(chat)
    router.showConversation(chat, id: "s1", resolvedID: "s1", title: "Passwords for the bank")
    router.openChat(chat, finding: "my secret words")

    let userInfo = try #require(HandoffActivity.userInfo(for: router.handoffLink))
    let payload = try #require(userInfo[HandoffActivity.linkKey])

    #expect(!payload.localizedCaseInsensitiveContains("password"))
    #expect(!payload.localizedCaseInsensitiveContains("secret"))
  }

  @Test("a chat hidden behind the Crons section is not what is on screen, so it is not advertised")
  func cronsOnScreen() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.openChat(ChatRef(gatewayId: home.id, bot: "alice"))
    router.openCron(CronRef(gatewayId: home.id, id: "c1"))

    #expect(router.handoffLink == nil)

    router.section = .chats
    #expect(router.handoffLink == .chat(bot: "alice", gatewayKey: home.key))
  }

  // MARK: What is continued

  @Test("continuing opens the chat the other device had open, through the router")
  func continuingAChat() throws {
    let sender = AppRouter()

    sender.gatewaysChanged(both)
    sender.handle(url: URL(string: "hermie://chat/alice?gateway=\(work.key)")!)

    let userInfo = try #require(HandoffActivity.userInfo(for: sender.handoffLink))

    // The receiving device, with the same gateways: it follows what arrived, as any link.
    let receiver = AppRouter()

    receiver.gatewaysChanged(both)

    let link = try #require(HandoffActivity.link(from: userInfo))
    let effects = receiver.handle(link)

    #expect(receiver.selectedChat == ChatRef(gatewayId: work.id, bot: "alice"))
    #expect(effects == [.activateGateway(work.id)])
    #expect(receiver.composeRequest == nil, "continuing is not asking: no caret is moved")
  }

  @Test("continuing a conversation opens it in the viewer over the bot's conversations")
  func continuingAConversation() throws {
    let receiver = AppRouter()

    receiver.gatewaysChanged(both)
    receiver.handle(.conversation(bot: "alice", session: "s1", gatewayKey: home.key))

    #expect(receiver.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
    #expect(receiver.detailPath.count == 2)
  }

  @Test("a chat on a gateway this device does not have opens nothing and says so")
  func unknownGateway() {
    let receiver = AppRouter()

    receiver.gatewaysChanged(GatewayIndex(entries: [home], activeId: home.id))
    receiver.handle(.chat(bot: "alice", gatewayKey: work.key))

    #expect(receiver.selectedChat == nil)
    #expect(receiver.notice == .gatewayNotConfigured)
  }

  @Test("an activity that arrives before the gateway list is read waits for it")
  func coldLaunch() {
    let receiver = AppRouter()

    receiver.handle(.chat(bot: "alice", gatewayKey: home.key))
    #expect(receiver.selectedChat == nil)
    #expect(receiver.pendingLinks == [.chat(bot: "alice", gatewayKey: home.key)])

    receiver.gatewaysChanged(both)
    #expect(receiver.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
  }

  // MARK: The app lock

  /// Renders a gate over `built`, which counts how often its content was asked for.
  private func render(_ launch: AppLaunch, built: @escaping () -> Void) {
    let gate = LockGate<EmptyView> {
      built()
      return EmptyView()
    }
    let renderer = ImageRenderer(content: gate.environment(launch).frame(width: 200, height: 200))

    _ = renderer.cgImage
  }

  @Test("continuing with the app locked keeps the chat for after the unlock, and builds none of it")
  func lockedContinuation() async throws {
    let launch = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))

    try await launch.keyValues.setString(#"{"threshold":"5m"}"#, forKey: StoreKeys.lock)
    await launch.start()

    #expect(LockGate<EmptyView>.face(for: launch.lock) == .plate)

    // The window's router, outside the gate: the activity reaches it whether or not the app is locked.
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(.chat(bot: "alice", gatewayKey: home.key))
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))

    // Still the plate: the router never opens the gate, and nothing under the gate is built, which is
    // also where the activity is advertised from (`RootView`): a locked app advertises no chat.
    var built = 0

    render(launch) { built += 1 }
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .plate)
    #expect(built == 0, "the content is not built while the app is locked")

    // The owner unlocks, and only then is the chat drawn.
    await launch.lock.unlock(reason: "test")
    render(launch) { built += 1 }
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .content)
    #expect(built > 0)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"), "the continuation was kept")
  }

  @Test("the same holds for an ask link: the caret waits, with the chat, for the unlock")
  func lockedAsk() async throws {
    let launch = AppLaunch(environment: LaunchEnvironment.inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))

    try await launch.keyValues.setString(#"{"threshold":"5m"}"#, forKey: StoreKeys.lock)
    await launch.start()

    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(.ask(bot: "alice", gatewayKey: home.key))

    #expect(LockGate<EmptyView>.face(for: launch.lock) == .plate)
    #expect(router.composeRequest?.chat == ChatRef(gatewayId: home.id, bot: "alice"))

    await launch.lock.unlock(reason: "test")
    #expect(LockGate<EmptyView>.face(for: launch.lock) == .content)
    #expect(router.composeRequest != nil, "nothing took it while the gate was closed")
  }

  // MARK: Ask a bot

  @Test("an ask link opens the bot's chat and asks for the caret in its composer")
  func askOpensAndFocuses() {
    let router = AppRouter()

    router.gatewaysChanged(both)

    let effects = router.handle(AskBotRoute.link(forBotIdentifier: "\(work.key)/alice")!)

    #expect(effects == [.activateGateway(work.id)])
    #expect(router.selectedGatewayId == work.id)
    #expect(router.selectedChat == ChatRef(gatewayId: work.id, bot: "alice"))
    #expect(router.section == .chats)
    #expect(router.composeRequest == ComposeRequest(id: router.composeRequest!.id, chat: ChatRef(gatewayId: work.id, bot: "alice")))
  }

  @Test("an ask link over a page pushed on the chat brings the chat back, so the field is on screen")
  func askClosesPages() {
    let router = AppRouter()
    let chat = ChatRef(gatewayId: home.id, bot: "alice")

    router.gatewaysChanged(both)
    router.openChat(chat)
    router.showBotSettings(chat)
    router.present(.settings)

    router.handle(.ask(bot: "alice", gatewayKey: home.key))

    #expect(router.detailPath.isEmpty)
    #expect(router.sheet == nil)
    #expect(router.composeRequest?.chat == chat)
  }

  @Test("the chat that takes the request settles it, and a newer request is left alone")
  func settling() throws {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(.ask(bot: "alice", gatewayKey: home.key))

    let first = try #require(router.composeRequest)

    router.handle(.ask(bot: "alice", gatewayKey: home.key))

    let second = try #require(router.composeRequest)

    #expect(second.id != first.id, "asking twice focuses twice")

    router.settleCompose(first.id)
    #expect(router.composeRequest == second)

    router.settleCompose(second.id)
    #expect(router.composeRequest == nil)
  }

  @Test("closing the chat drops a request nobody took, so it cannot focus another chat later")
  func closing() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(.ask(bot: "alice", gatewayKey: home.key))
    router.closeChat()

    #expect(router.composeRequest == nil)
  }

  @Test("an ask for a gateway this device does not have opens nothing and asks for nothing")
  func askUnknownGateway() {
    let router = AppRouter()

    router.gatewaysChanged(GatewayIndex(entries: [home], activeId: home.id))
    router.handle(.ask(bot: "alice", gatewayKey: work.key))

    #expect(router.selectedChat == nil)
    #expect(router.composeRequest == nil)
    #expect(router.notice == .gatewayNotConfigured)
  }

  @Test("an ask link from the system is routed like any link, and one that arrives early waits")
  func askFromTheSystem() {
    let router = AppRouter()

    router.handle(url: URL(string: "hermie://ask/alice?gateway=\(home.key)")!)
    #expect(router.composeRequest == nil)
    #expect(router.pendingLinks == [.ask(bot: "alice", gatewayKey: home.key)])

    router.gatewaysChanged(both)
    #expect(router.selectedChat == ChatRef(gatewayId: home.id, bot: "alice"))
    #expect(router.composeRequest?.chat == ChatRef(gatewayId: home.id, bot: "alice"))
  }

  @Test("a plain chat link asks for no caret")
  func chatLinkDoesNotFocus() {
    let router = AppRouter()

    router.gatewaysChanged(both)
    router.handle(.chat(bot: "alice", gatewayKey: home.key))

    #expect(router.composeRequest == nil)
  }
}
