import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile
private let workspace = "/work/space"

/// A resume that reports the session's working directory, as `session.resume` does.
private func resume(cwd: String?) -> JSONValue {
  var info: JSONObject = ["desktop_contract": .number(7), "model": .string("example-model")]
  if let cwd {
    info["cwd"] = .string(cwd)
  }

  return Fixture.resume(extra: ["info": .object(info)])
}

private func storeHarness(cwd: String? = workspace) async throws -> StoreHarness {
  let harness = StoreHarness()
  await harness.attach()
  await harness.store.connectionChanged(ConnectionStatus(.ready))
  try await harness.open(resume: resume(cwd: cwd))
  return harness
}

private func lastUser(_ state: ChatState) -> UserItem? {
  state.orderedItems.compactMap(\.asUser).last
}

private func picked(_ name: String, _ type: String?, bytes: Int = 3) throws -> PickedFile {
  try AttachmentStaging.stage(data: Data(repeating: 0x42, count: bytes), name: name, mimeType: type)
}

@Suite(.timeLimit(.minutes(1))) struct AttachmentStoreTests {
  @Test func anUploadLandsUnderTheSessionsWorkingDirectoryByDateWithATokenAndKeepsTheNameForTheBubble() async throws {
    let harness = try await storeHarness()
    harness.link.onUpload { $0.path }
    let file = try picked("my notes.txt", "text/plain")

    let uploaded = try await harness.store.uploadAttachment(bot, file: file)

    let upload = try #require(harness.link.uploads.first)
    #expect(upload.path.hasPrefix("\(workspace)/uploads/hermie/"))
    #expect(upload.path.hasSuffix("-my-notes.txt"))
    #expect(upload.name == "my-notes.txt", "the sanitised name travels in the form")
    #expect(upload.mimeType == "text/plain")
    #expect(upload.file == file.url)
    #expect(uploaded == .file(filename: "my notes.txt", path: upload.path))
    await harness.shutdown()
  }

  @Test func aGateway413OnTheUploadIsATooLargeProblemOnTheChip() async throws {
    let harness = try await storeHarness()
    harness.link.onUpload { _ in
      throw GatewayError(.protocol, "too big", status: 413, hint: "File is too large")
    }
    let store = harness.store
    let tray = await MainActor.run {
      AttachmentTray(
        AttachmentTray.Dependencies(upload: { file, progress in
          try await store.uploadAttachment(bot, file: file, onProgress: progress)
        }))
    }

    _ = await MainActor.run { tray.add([try! picked("a.pdf", "application/pdf")]) }
    try await eventually("the chip to fail") { await MainActor.run { tray.items.first?.status == .failed } }

    let problem = await MainActor.run { tray.items.first?.problem }
    #expect(problem == .tooLarge(limitBytes: AttachmentRules.maxFileBytes))
    #expect(await MainActor.run { tray.items.first?.canRetry } == false)
    await harness.shutdown()
  }

  @Test func theGatewaysResolvedPathWinsOverTheOneAskedFor() async throws {
    let harness = try await storeHarness()
    harness.link.onUpload { _ in "/real/home/work/space/uploads/x-a.pdf" }

    let uploaded = try await harness.store.uploadAttachment(bot, file: try picked("a.pdf", "application/pdf"))
    #expect(uploaded == .file(filename: "a.pdf", path: "/real/home/work/space/uploads/x-a.pdf"))
    await harness.shutdown()
  }

  @Test(arguments: [nil, "/", ""] as [String?])
  func withNoWorkspaceNothingIsUploadedAnywhere(cwd: String?) async throws {
    let harness = try await storeHarness(cwd: cwd)

    await #expect(throws: AttachmentUploadError.noWorkspace) {
      try await harness.store.uploadAttachment(bot, file: try picked("a.pdf", nil))
    }
    #expect(harness.link.uploads.isEmpty)
    await harness.shutdown()
  }

  @Test func anImageGoesOverTheSocketBeforeThePromptAndIsNotNamedInIt() async throws {
    let harness = try await storeHarness()

    let sending = Task {
      try await harness.store.send(
        bot, text: "what is this?", outgoing: [.image(filename: "photo.png", base64: "QUJD")])
    }
    let attach = try await harness.link.pendingCall(RPC.ImageAttachBytes.name)
    #expect(attach.params["session_id"] == .string(Fixture.runtime))
    #expect(attach.params["profile"] == .string(bot))
    #expect(attach.params["content_base64"] == "QUJD")
    #expect(attach.params["filename"] == "photo.png")
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty, "the prompt waits for the image")

    harness.link.answer(attach, ["attached": true])
    let submit = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "what is this?")
    harness.link.answer(submit, ["status": "streaming"])
    _ = try await sending.value
    await harness.settle()

    let user = lastUser(await harness.state())
    #expect(user?.text == "what is this?")
    #expect(user?.attachments == ["@image:photo.png"])
    await harness.shutdown()
  }

  @Test func aFileIsNamedInThePromptAndPaintedWithItsReference() async throws {
    let harness = try await storeHarness()
    let path = "\(workspace)/uploads/hermie/2026-10-03/abc12345-report.pdf"

    let sending = Task {
      try await harness.store.send(bot, text: "summarise", outgoing: [.file(filename: "report.pdf", path: path)])
    }
    let submit = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == .string("summarise\n\n@file:\(path)"))
    #expect(harness.link.calls(RPC.ImageAttachBytes.name).isEmpty, "a file is not an image attach")
    harness.link.answer(submit, ["status": "streaming"])
    _ = try await sending.value
    await harness.settle()

    let user = lastUser(await harness.state())
    #expect(user?.attachments == ["@file:\(path)"])
    #expect(user?.text == "summarise", "the reference is shown as a chip, not as words")
    await harness.shutdown()
  }

  @Test func anAttachmentWithNoWordsIsStillASend() async throws {
    let harness = try await storeHarness()

    let sending = Task {
      try await harness.store.send(bot, text: "", outgoing: [.file(filename: "a.pdf", path: "/w/a.pdf")])
    }
    let submit = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "@file:/w/a.pdf")
    harness.link.answer(submit, ["status": "streaming"])
    _ = try await sending.value
    await harness.shutdown()
  }

  @Test func aFailedImageAttachKeepsTheBubbleAndNeverSubmitsThePrompt() async throws {
    let harness = try await storeHarness()

    let sending = Task {
      try await harness.store.send(bot, text: "look", outgoing: [.image(filename: "a.png", base64: "QUJD")])
    }
    let attach = try await harness.link.pendingCall(RPC.ImageAttachBytes.name)
    harness.link.fail(attach, GatewayRPCError(.rejected, "unsupported image", code: 4009))

    await #expect(throws: GatewayRPCError.self) { try await sending.value }
    #expect(harness.link.calls(RPC.PromptSubmit.name).isEmpty)
    let state = await harness.state()
    #expect(lastUser(state)?.text == "look")
    #expect(state.turn.active == false)
    await harness.shutdown()
  }

  @Test func aParkedMessageKeepsItsAttachmentsAndSendsThemWhenTheTurnEnds() async throws {
    let harness = try await storeHarness()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    let parked = try await harness.store.send(
      bot, text: "and this one",
      outgoing: [.image(filename: "a.png", base64: "QUJD"), .file(filename: "b.pdf", path: "/w/b.pdf")])
    #expect(parked == nil)
    #expect(harness.link.calls(RPC.ImageAttachBytes.name).isEmpty, "nothing moves while the turn runs")
    let queued = try #require(await harness.store.chats[bot]?.queue.first)
    #expect(queued.text == "and this one")
    #expect(queued.attachments == ["@image:a.png", "@file:/w/b.pdf"], "the strip shows names, not bytes")

    harness.link.emit("message.complete", session: Fixture.runtime, seq: 2, payload: ["text": "done"])
    harness.link.setREST { _, _ in [] }
    let attach = try await harness.link.pendingCall(RPC.ImageAttachBytes.name)
    #expect(attach.params["content_base64"] == "QUJD")
    harness.link.answer(attach, ["attached": true])
    let submit = try await harness.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"] == "and this one\n\n@file:/w/b.pdf")
    harness.link.answer(submit, ["status": "streaming"])
    await harness.settle()

    #expect(await harness.store.queuedOutgoing.isEmpty)
    await harness.shutdown()
  }

  @Test func aParkedMessageWithAttachmentsIsNotSteeredAndItsPayloadGoesWhenItIsRemoved() async throws {
    let harness = try await storeHarness()
    harness.link.emit("message.start", session: Fixture.runtime, seq: 1)
    await harness.settle()

    _ = try await harness.store.send(
      bot, text: "with image", outgoing: [.image(filename: "a.png", base64: "QUJD")])
    _ = try await harness.store.send(
      bot, text: "second", outgoing: [.image(filename: "b.png", base64: "QUJD")])
    let first = try #require(await harness.store.chats[bot]?.queue.first)
    let second = try #require(await harness.store.chats[bot]?.queue.last)

    #expect(try await harness.store.steerQueued(bot, first.id) == .rejected)
    #expect(await harness.store.chats[bot]?.queue.count == 2, "it stays where it was")
    #expect(harness.link.calls(RPC.SessionSteer.name).isEmpty)

    await harness.store.deleteQueued(bot, first.id)
    _ = await harness.store.editQueued(bot, second.id)
    #expect(await harness.store.queuedOutgoing.isEmpty)
    await harness.shutdown()
  }
}

/// The composer over a session on a scripted link, with a working directory.
@MainActor
private struct ComposerRig {
  let harness: SessionHarness
  let composer: ComposerModel

  static func opened(cwd: String? = workspace) async throws -> ComposerRig {
    let harness = SessionHarness()
    try await harness.start()
    let composer = ComposerModel(session: harness.session, bot: bot)
    try await harness.open(resume: resume(cwd: cwd))
    try await harness.frame()
    return ComposerRig(harness: harness, composer: composer)
  }

  var link: ScriptedLink { harness.link }

  func shutdown() async {
    await harness.session.shutdown()
  }

  /// Stage a file through the composer's own tray and wait until it is ready.
  func stage(_ file: PickedFile) async throws {
    composer.tray.add([file])
    let tray = composer.tray
    try await eventually("the chip to be ready") { await MainActor.run { !tray.items.isEmpty && !tray.blocked } }
  }
}

@Suite(.timeLimit(.minutes(1))) @MainActor struct AttachmentComposerTests {
  @Test func theSendButtonWaitsForAnUploadAndThenSendsTheFile() async throws {
    let rig = try await ComposerRig.opened()
    let gate = AsyncStream<Void>.makeStream()
    rig.link.onUpload { upload in
      for await _ in gate.0 { break }
      return upload.path
    }

    rig.composer.draft = "here you go"
    rig.composer.tray.add([try picked("report.pdf", "application/pdf")])
    #expect(rig.composer.tray.blocked)
    #expect(!rig.composer.canSubmit, "an upload is still going")

    await rig.composer.submit()
    #expect(rig.link.calls(RPC.PromptSubmit.name).isEmpty, "a send while it uploads does nothing")
    #expect(rig.composer.draft == "here you go", "and the words stay in the field")

    gate.1.yield()
    let composer = rig.composer
    try await eventually("the upload to finish") { await MainActor.run { composer.canSubmit } }

    let sending = Task { await composer.submit() }
    let submit = try await rig.link.pendingCall(RPC.PromptSubmit.name)
    let text = try #require(submit.params["text"]?.stringValue)
    #expect(text.hasPrefix("here you go\n\n@file:\(workspace)/uploads/hermie/"))
    #expect(composer.draft.isEmpty)
    #expect(composer.tray.isEmpty)
    rig.link.answer(submit, ["status": "streaming"])
    await sending.value
    #expect(composer.lastEvent?.event == .sent)
    await rig.shutdown()
  }

  @Test func aSecondSendWhileTheFirstIsInFlightSendsNothingMore() async throws {
    let rig = try await ComposerRig.opened()
    let composer = rig.composer
    try await rig.stage(try picked("photo.png", "image/png"))
    composer.draft = "look at this"

    let first = Task { await composer.submit() }
    // The first press has taken the draft and the tray in its first synchronous step; the call
    // that gets to the gateway first is the image.
    let attach = try await rig.link.pendingCall(RPC.ImageAttachBytes.name)
    #expect(composer.tray.isEmpty)
    #expect(composer.draft.isEmpty)
    #expect(!composer.canSubmit)

    // Return again, and the send button: nothing is left to send.
    await composer.submit()
    await composer.submit()

    rig.link.answer(attach, ["attached": true])
    let submit = try await rig.link.pendingCall(RPC.PromptSubmit.name)
    rig.link.answer(submit, ["status": "streaming"])
    await first.value

    #expect(rig.link.calls(RPC.ImageAttachBytes.name).count == 1, "the image went once")
    #expect(rig.link.calls(RPC.PromptSubmit.name).count == 1, "and so did the turn")
    await rig.shutdown()
  }

  @Test func sendWaitsForAPickedItemStillBeingCopied() async throws {
    let rig = try await ComposerRig.opened()
    let composer = rig.composer

    composer.draft = "see this"
    let id = composer.tray.prepare([("Photo", .image)])[0]
    #expect(!composer.canSubmit, "the chip is there, its copy is not")

    await composer.submit()
    #expect(rig.link.calls(RPC.PromptSubmit.name).isEmpty)
    #expect(composer.draft == "see this")

    composer.tray.provide(id, .success(try picked("photo.png", "image/png")))
    let tray = composer.tray
    try await eventually("the chip to be ready") { await MainActor.run { !tray.blocked } }
    #expect(composer.canSubmit)
    await rig.shutdown()
  }

  @Test func aSendWithOnlyAFileAndNoWordsGoes() async throws {
    let rig = try await ComposerRig.opened()
    let composer = rig.composer
    try await rig.stage(try picked("a.pdf", "application/pdf"))

    #expect(composer.draft.isEmpty)
    #expect(composer.canSubmit)
    let sending = Task { await composer.submit() }
    let submit = try await rig.link.pendingCall(RPC.PromptSubmit.name)
    #expect(submit.params["text"]?.stringValue?.hasPrefix("@file:\(workspace)/uploads/hermie/") == true)
    rig.link.answer(submit, ["status": "streaming"])
    await sending.value
    await rig.shutdown()
  }

  @Test func aFailedChipHoldsTheSendUntilItIsRemoved() async throws {
    let rig = try await ComposerRig.opened(cwd: nil)
    let composer = rig.composer

    composer.draft = "see attached"
    composer.tray.add([try picked("a.pdf", "application/pdf")])
    let tray = composer.tray
    try await eventually("the chip to fail") { await MainActor.run { tray.items.first?.status == .failed } }
    #expect(tray.items.first?.problem == .noWorkspace)
    #expect(!composer.canSubmit)

    await composer.submit()
    #expect(rig.link.calls(RPC.PromptSubmit.name).isEmpty)

    tray.remove(try #require(tray.items.first).id)
    #expect(composer.canSubmit, "the words alone can go")
    await rig.shutdown()
  }

  @Test func aSendRefusedBeforeItIsPaintedKeepsTheFilesToo() async throws {
    // The socket is up but the chat is not bound to a session: nothing is painted, nothing is taken.
    let harness = SessionHarness()
    try await harness.start()
    let tray = AttachmentTray(
      AttachmentTray.Dependencies(upload: { file, _ in .file(filename: file.name, path: "/w/\(file.name)") }))
    let composer = ComposerModel(
      chat: harness.session.chat(bot), gatewayID: "g1", session: harness.session, drafts: nil, debounce: .zero,
      tray: tray)

    tray.add([try picked("a.pdf", "application/pdf")])
    try await eventually("the chip to be ready") { await MainActor.run { !tray.items.isEmpty && !tray.blocked } }
    composer.draft = "are you there?"

    await composer.submit()
    #expect(composer.draft == "are you there?")
    #expect(tray.items.count == 1, "the file is still staged")
    guard case .notSent? = composer.notice else {
      Issue.record("expected a not-sent notice, got \(String(describing: composer.notice))")
      return
    }
    await harness.session.shutdown()
  }
}
