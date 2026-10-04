import Foundation
import HermieProtocol
import HermieShared
import Testing

@testable import HermieCore

/// What a tap, an action and a clearing push do with a notification this app posted itself: the same
/// as with a remote one, because it carries the same data bag.
@MainActor
@Suite("Local notifications for requests: taps and clearing")
struct RequestAlertsRoutingTests {
  typealias G = PushGateways

  private func content(
    _ id: String, _ method: String, level: PushConfirmLevel? = nil, gateway: PushGatewayRef = G.one,
    chat: String = "scout", session: String = "rt-1"
  ) -> LocalNotificationContent {
    RequestAlertContent.make(
      openRequest(id, method, chat: chat, gateway: gateway.id, level: level, session: session),
      gatewayKey: gateway.key, preview: false, copy: .english, interruption: .active, badge: nil)
  }

  private static let tap = "com.apple.UNNotificationDefaultActionIdentifier"

  @Test("a tap opens the gateway and chat the notification names, and every kind but an approval opens its request")
  func tapsOpenTheRequest() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    await rig.controller.setGateways([G.one, G.two])

    for method in PushRequestMethod.allCases {
      opened = []
      let level: PushConfirmLevel? = method == .confirm ? .passkey : nil
      let notification = content("srq-7", method.rawValue, level: level, gateway: G.two)

      await rig.controller.handleResponse(actionIdentifier: Self.tap, payload: notification.payload)

      let link = DeepLink.chat(bot: "scout", gatewayKey: G.two.key)

      if method == .approval {
        #expect(opened == [.chat(link)], "an approval opens its chat")
      } else {
        #expect(
          opened == [
            .request(
              link,
              PushOpenRequest(
                bot: "scout", gatewayKey: G.two.key, method: method.rawValue, requestId: "srq-7", sessionId: "rt-1",
                level: level))
          ], "\(method)")
      }
    }
  }

  @Test("a passkey confirmation can only be opened, never answered, from its notification")
  func passkeyIsOnlyOpened() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    var answered = 0
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { _ in [] }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one])

    let notification = content("srq-3", "confirm", level: .passkey)
    #expect(notification.categoryIdentifier == nil, "no Allow or Deny")

    await rig.controller.handleResponse(actionIdentifier: "hermie.request.allow", payload: notification.payload)

    #expect(answered == 0)
    guard case .request(_, let request)? = opened.first else {
      Issue.record("not opened as a request: \(opened)")
      return
    }
    #expect(request.needsDeviceAuthentication)
  }

  @Test("Allow and Deny on an approval answer it by its queue id, through the same re-read as a remote one")
  func actionsAnswerAnApproval() async throws {
    let rig = try PushControllerTests.Rig()
    var opened: [PushRoute] = []
    var answers: [PushApprovalAnswer] = []
    rig.controller.attachLinkHandler(UUID()) { opened.append($0) }
    rig.controller.pendingApprovals = { _ in
      [PushOpenApproval(bot: "scout", sessionId: "rt-1", requestId: "appr-1", choices: ["once", "always", "deny"])]
    }
    rig.controller.respond = { answers.append($0) }
    await rig.controller.setGateways([G.one])

    let notification = content("appr-1", "approval")
    #expect(notification.categoryIdentifier == PushContract.requestCategory)

    await rig.controller.handleResponse(actionIdentifier: PushContract.Action.allow.rawValue, payload: notification.payload)
    await rig.controller.handleResponse(actionIdentifier: PushContract.Action.deny.rawValue, payload: notification.payload)

    #expect(
      answers == [
        PushApprovalAnswer(gatewayId: "g1", bot: "scout", sessionId: "rt-1", requestId: "appr-1", choice: "once"),
        PushApprovalAnswer(gatewayId: "g1", bot: "scout", sessionId: "rt-1", requestId: "appr-1", choice: "deny")
      ])
    #expect(opened.count == 2, "the chat opens either way")
  }

  @Test("an Allow whose request is no longer open answers nothing")
  func staleAllow() async throws {
    let rig = try PushControllerTests.Rig()
    var answered = 0
    rig.controller.attachLinkHandler(UUID()) { _ in }
    rig.controller.pendingApprovals = { _ in [] }
    rig.controller.respond = { _ in answered += 1 }
    await rig.controller.setGateways([G.one])

    await rig.controller.handleResponse(
      actionIdentifier: PushContract.Action.allow.rawValue, payload: content("appr-1", "approval").payload)

    #expect(answered == 0)
  }

  @Test("a clearing push from the relay withdraws a local notification, by request id")
  func remoteClearWithdraws() async {
    let local = content("appr-1", "approval")
    let other = content("srq-2", "input.form")
    let center = FakeDeliveredNotifications([
      PushDeliveredNotification(identifier: local.identifier, payload: local.payload),
      PushDeliveredNotification(identifier: other.identifier, payload: other.payload)
    ])

    let clear = PushPayload(
      shape: .relay,
      data: [
        "type": "request", "clear": true, "bot": "scout", "method": "approval", "requestId": "appr-1",
        "reason": "answered", "gatewayKey": .string(G.one.key),
        "replaces": "request:e73f568f3575f6b525d031267d258a0b"
      ])

    let removed = await PushClearing.apply(clear, to: center)

    #expect(removed == 1)
    #expect(center.removed == [local.identifier])
  }
}
