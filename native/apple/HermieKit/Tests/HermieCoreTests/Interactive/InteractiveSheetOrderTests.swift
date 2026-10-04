import Foundation
import HermieGateway
import HermieProtocol
import Testing

@testable import HermieCore

/// One sheet at a time on a chat: an approval or a secure prompt first, a form giving way to it.
@Suite("Chat sheets: which has the screen", .timeLimit(.minutes(1))) @MainActor
struct InteractiveSheetOrderTests {
  @MainActor private struct Chat {
    let h: InteractiveHarness
    let order: ChatSheetOrder
    let interactive: InteractiveModel
    let requests: RequestsModel
    let secure: SecureInputModel

    static func open() async throws -> Chat {
      let h = InteractiveHarness()
      h.link.respond(to: RPC.ApprovalReceived.name, with: ["acknowledged": true])
      h.link.respond(to: RPC.ApprovalPending.name, with: ["approvals": [["request_id": "appr-1"]]])
      try await h.open()
      let requests = RequestsModel(chat: h.session.chat(Fixture.profile))
      let secure = SecureInputModel(session: h.session, bot: Fixture.profile)
      let interactive = InteractiveModel(session: h.session, bot: Fixture.profile)
      return Chat(
        h: h, order: ChatSheetOrder(requests: requests, secureInput: secure, interactive: interactive),
        interactive: interactive, requests: requests, secure: secure)
    }

    func raiseApproval() async throws {
      h.link.raise(
        id: "srq-appr", method: "approval",
        params: [
          "session_id": .string(Fixture.runtime), "request_id": "appr-1", "command": "rm -rf ./build",
          "choices": ["once", "deny"]
        ])
      try await h.harness.frame()
    }
  }

  @Test("nothing waits: the form is free to come up, and nothing holds an approval back")
  func idle() async throws {
    let chat = try await Chat.open()
    try await chat.h.raiseOpen("srq-f")

    #expect(!chat.order.interactiveBlocked)
    #expect(!chat.order.holdForInteractive)
    chat.interactive.present("srq-f")
    #expect(chat.order.holdForInteractive, "an approval would wait while the form is up")
  }

  @Test("an approval that arrives while a form is up blocks the form, which steps aside without being put away and returns afterwards")
  func approvalOverAForm() async throws {
    let chat = try await Chat.open()
    try await chat.h.raiseOpen("srq-f")
    chat.interactive.present("srq-f")
    #expect(!chat.order.interactiveBlocked)

    try await chat.raiseApproval()
    #expect(chat.requests.nextToPresent == "srq-appr")
    #expect(chat.order.interactiveBlocked, "the sheet must step aside")

    // What the modifier does the moment it is blocked.
    chat.interactive.yield()
    #expect(chat.interactive.presentedID == nil)
    #expect(!chat.order.holdForInteractive, "the approval can be raised now")
    #expect(chat.h.link.answers.isEmpty, "stepping aside is never an answer")
    #expect(chat.h.center.isOpen("srq-f"))
    #expect(!chat.interactive.putAway.contains("srq-f"), "not put away: it returns by itself")

    chat.requests.present("srq-appr")
    #expect(chat.order.interactiveBlocked, "the approval has the screen")

    await chat.requests.answerApproval("srq-appr", choice: "once")
    chat.requests.dismissSheet()
    let requests = chat.requests
    try await chat.h.harness.frame()
    try await eventually("the approval to close") { await requests.nextToPresent == nil }
    #expect(!chat.order.interactiveBlocked, "the approval is done")
    #expect(chat.interactive.nextToPresent == "srq-f", "the form comes back")
  }

  @Test("a form is not raised while an approval waits, and an approval put away with Later no longer blocks it")
  func approvalFirst() async throws {
    let chat = try await Chat.open()
    try await chat.raiseApproval()
    try await chat.h.raiseOpen("srq-f")
    #expect(chat.order.interactiveBlocked)

    chat.requests.present("srq-appr")
    chat.requests.dismissSheet()
    #expect(!chat.order.interactiveBlocked, "Later: the approval stays open in the transcript, the form may come up")
  }

  @Test("a secure prompt blocks a form too, and holds nothing back once it has the screen")
  func securePrompt() async throws {
    let chat = try await Chat.open()
    try await chat.h.raiseOpen("srq-f")
    chat.interactive.present("srq-f")

    var params: JSONObject = ["env_var": "API_KEY", "prompt": "Key?"]
    params["session_id"] = .string(Fixture.runtime)
    chat.h.link.raise(id: "srq-s", method: "secret", params: params)
    let secure = chat.secure
    try await eventually("the prompt") { await secure.nextToPresent != nil }
    #expect(chat.order.interactiveBlocked)

    chat.interactive.yield()
    #expect(!chat.order.holdForInteractive)
    chat.secure.present("srq-s")
    #expect(chat.order.interactiveBlocked)
    #expect(await chat.secure.skip())
    #expect(!chat.order.interactiveBlocked)
    #expect(chat.interactive.nextToPresent == "srq-f")
  }

  @Test("a sheet that already ended closes for an approval, and its outcome stays as the chat's notice")
  func yieldOfAnEndedRequest() async throws {
    let chat = try await Chat.open()
    try await chat.h.raiseOpen("srq-f")
    chat.interactive.present("srq-f")
    chat.h.link.emit(
      "request.cancel", session: Fixture.runtime,
      payload: ["id": "srq-f", "method": "input.form", "reason": "timeout"])
    let center = chat.h.center
    try await eventually("srq-f to close") { await !center.isOpen("srq-f") }
    #expect(chat.interactive.presentedOutcome == .expired)
    #expect(chat.order.holdForInteractive, "an ended sheet would still hold an approval back")

    chat.interactive.yield()
    #expect(chat.interactive.presentedID == nil)
    #expect(!chat.order.holdForInteractive)
    #expect(chat.interactive.notice?.notice == .expired, "the outcome is kept as the chat banner")
  }

  @Test("an upload or an answer on its way is not cut off: the sheet yields once it is done")
  func noYieldWhileWorking() async throws {
    let chat = try await Chat.open()
    try await chat.h.raiseOpen("srq-u", "input.file", params: InteractiveFrames.file())
    chat.interactive.present("srq-u")
    chat.interactive.setWorking(true)
    #expect(!chat.interactive.canYield)

    try await chat.raiseApproval()
    #expect(chat.order.interactiveBlocked)
    chat.interactive.yield()
    #expect(chat.interactive.presentedID == "srq-u", "the upload goes on; the approval waits")
    #expect(chat.order.holdForInteractive)

    chat.interactive.setWorking(false)
    #expect(chat.interactive.canYield)
    chat.interactive.yield()
    #expect(chat.interactive.presentedID == nil)
    #expect(chat.h.center.isOpen("srq-u"), "stepping aside is never an answer")
  }
}

@Suite("Interactive sheets: Don't share", .timeLimit(.minutes(1))) @MainActor
struct InteractiveDeclineTests {
  @Test("Don't share answers 4041 declined for a form, a file request and a draft; never a skip")
  func declined() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let model = InteractiveModel(session: h.session, bot: Fixture.profile)

    // A form that cannot be skipped: this is the person's refusal.
    try await h.raiseOpen("srq-f", params: InteractiveFrames.form(optional: false))
    model.present("srq-f")
    #expect(model.presented?.offersSkip == false)
    #expect(await model.cannotShow(reason: CannotShowReason.declined))
    #expect(h.cannotShowReason("srq-f") == "declined")
    #expect(h.link.answers.isEmpty, "not a made-up skip")
    #expect(model.presentedID == nil)
    #expect(await h.card("srq-f")?.state == .cancelled)

    try await h.raiseOpen("srq-u", "input.file", params: InteractiveFrames.file())
    model.present("srq-u")
    #expect(await model.cannotShow(reason: CannotShowReason.declined))
    #expect(h.cannotShowReason("srq-u") == "declined")

    try await h.raiseOpen("srq-d", "review.draft", params: InteractiveFrames.draft())
    model.present("srq-d")
    #expect(await model.cannotShow(reason: CannotShowReason.declined))
    #expect(h.cannotShowReason("srq-d") == "declined")
    #expect(h.link.answers.isEmpty)
  }
}
