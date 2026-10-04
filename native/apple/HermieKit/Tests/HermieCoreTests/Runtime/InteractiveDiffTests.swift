import Foundation
import HermieGateway
import HermieProtocol
import HermieTranscript
import Testing

@testable import HermieCore

private let bot = Fixture.profile

private let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<7 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// The contract's `review.diff` examples: `frames`, `invalid_frames`, `answers`.
private func examples(_ key: String) throws -> [JSONValue] {
  let data = try Data(contentsOf: contractDirectory.appendingPathComponent("requests/examples.json"))
  let root = try JSONValue(parsing: data)
  return try #require(root["methods"]?["review.diff"]?[key]?.arrayValue, "review.diff.\(key)")
}

/// The params of the contract's frame with this request id, for the runtime session of the harness.
private func frame(_ id: String) throws -> JSONObject {
  let match = try #require(try examples("frames").first { $0["id"]?.stringValue == id }, "\(id)")
  var params = try #require(match["params"]?.objectValue)
  params["expires_at"] = .number(Double(InteractiveFrames.expires))
  return params
}

private func prompt(_ params: JSONObject) throws -> InteractivePrompt {
  guard case .content(let content) = InteractivePrompt.read(ServerRequestBody(method: "review.diff", params: params)) else {
    throw ReadFailure()
  }

  return InteractivePrompt(id: "srq-1", content: content, chatKey: bot, sessionID: "s", deadline: nil)
}

private struct ReadFailure: Error {}

@Suite("Review diff: answering and the sheet's model", .timeLimit(.minutes(1))) @MainActor
struct InteractiveDiffTests {
  // MARK: The prompt

  @Test("a valid frame becomes a prompt for the diff, with no Skip and the agent's words cleaned")
  func readsAPrompt() throws {
    let request = try prompt(try frame("req_diff_settings"))
    guard case .diff(let diff) = request.body else {
      Issue.record("not a diff")
      return
    }

    #expect(request.method == "review.diff")
    #expect(request.title == "Changes to settings.py")
    #expect(!request.offersSkip)
    #expect(request.actingUser == "Ada")
    #expect(diff.hunkIDs == ["h1", "h2"])
    #expect(diff.path == "app/settings.py")
  }

  @Test("a frame in another version, or one that is not wholly in the contract, is not shown")
  func refusesWhatItCannotShow() throws {
    var other = try frame("req_diff_settings")
    other["v"] = 2
    #expect(InteractivePrompt.read(ServerRequestBody(method: "review.diff", params: other))
      == .cannotShow(reason: CannotShowReason.unsupportedVersion))

    for entry in try examples("invalid_frames") {
      let params = try #require(entry["params"]?.objectValue)
      #expect(
        InteractivePrompt.read(ServerRequestBody(method: "review.diff", params: params))
          == .cannotShow(reason: CannotShowReason.notSupportedOnDevice),
        "\(entry["name"]?.stringValue ?? "")")
    }
  }

  @Test("every valid answer of the contract is what the prompt composes from the decisions, and its summary keeps only counts")
  func composesTheContractsAnswers() throws {
    for answer in try examples("answers") {
      let name = answer["name"]?.stringValue ?? "?"
      let request = try prompt(try frame(try #require(answer["request"]?.stringValue)))
      let result = try #require(answer["result"], "\(name)")
      let decisions = try #require(ReviewDiffResult(jsonValue: result)?.hunks, "\(name)")

      let reply = try #require(request.reply(to: .diff(decisions)), "\(name)")
      #expect(.object(reply.result) == result, "\(name)")

      let approved = decisions.values.filter { $0 == .approved }.count
      #expect(reply.summary["decision"] == result["decision"], "\(name)")
      #expect(reply.summary["approvedHunks"] == .number(Double(approved)), "\(name)")
      #expect(reply.summary["rejectedHunks"] == .number(Double(decisions.count - approved)), "\(name)")
      #expect(Set(reply.summary.keys) == ["decision", "approvedHunks", "rejectedHunks"], "no hunk id, no line")
    }
  }

  @Test("an answer that does not decide exactly every hunk, or is another method's, never goes out")
  func refusesAnIncompleteAnswer() throws {
    let request = try prompt(try frame("req_diff_settings"))

    #expect(request.reply(to: .diff([:])) == nil)
    #expect(request.reply(to: .diff(["h1": .approved])) == nil, "a hunk left out")
    #expect(request.reply(to: .diff(["h1": .approved, "h2": .rejected, "h3": .approved])) == nil, "a hunk the request lacks")
    #expect(request.reply(to: .diff(["h1": .approved, "h3": .rejected])) == nil, "one that is not the request's")
    #expect(request.reply(to: .skip) == nil, "no skip for a diff")
    #expect(request.reply(to: .approve(text: "x")) == nil)
    #expect(request.reply(to: .reject(comment: "no")) == nil, "a diff review carries no comment")
    #expect(request.reply(to: .form([:])) == nil)
    #expect(request.reply(to: .diff(["h1": .unknown("skipped"), "h2": .rejected])) == nil, "a hunk is approved or rejected")
  }

  @Test("approved when some hunk is approved, rejected when none is: the pairings the gateway refuses are never built")
  func decisionFollowsTheHunks() throws {
    let request = try prompt(try frame("req_diff_settings"))

    #expect(request.reply(to: .diff(["h1": .rejected, "h2": .rejected]))?.result["decision"] == "rejected")
    #expect(request.reply(to: .diff(["h1": .approved, "h2": .rejected]))?.result["decision"] == "approved")
    #expect(request.reply(to: .diff(["h1": .rejected, "h2": .approved]))?.result["decision"] == "approved")
    #expect(request.reply(to: .diff(["h1": .approved, "h2": .approved]))?.result["decision"] == "approved")
  }

  // MARK: The sheet's model

  @Test("the model starts with nothing decided; every hunk decided makes it sendable, and its answer decides each hunk")
  func modelDecides() throws {
    guard case .diff(let diff) = try prompt(try frame("req_diff_settings")).body else {
      Issue.record("not a diff")
      return
    }

    let model = InteractiveDiffModel(diff: diff)
    #expect(model.decidedCount == 0 && model.hunkCount == 2 && !model.canSend && !model.isComplete)
    #expect(model.decision(of: "h1") == nil)

    model.decide("h1", .approved)
    #expect(model.decidedCount == 1 && !model.canSend, "send only when every hunk is decided")

    model.decide("h2", .rejected)
    #expect(model.canSend && model.approvedCount == 1 && model.rejectedCount == 1)
    #expect(model.answer == .diff(["h1": .approved, "h2": .rejected]))

    // Changed after the fact.
    model.decide("h1", .rejected)
    #expect(model.approvedCount == 0 && model.rejectedCount == 2)

    // An id the diff does not have is ignored.
    model.decide("h9", .approved)
    #expect(model.decidedCount == 2 && model.decision(of: "h9") == nil)

    model.wipe()
    #expect(model.decidedCount == 0 && !model.canSend)
  }

  @Test("approve all and reject all decide every hunk, and each can be changed one by one afterwards")
  func modelBulk() throws {
    guard case .diff(let diff) = try prompt(try frame("req_diff_settings")).body else {
      Issue.record("not a diff")
      return
    }

    let model = InteractiveDiffModel(diff: diff)
    model.decideAll(.approved)
    #expect(model.canSend && model.approvedCount == 2)
    model.decide("h2", .rejected)
    #expect(model.answer == .diff(["h1": .approved, "h2": .rejected]))
    model.decideAll(.rejected)
    #expect(model.answer == .diff(["h1": .rejected, "h2": .rejected]))
    #expect(model.approvedCount == 0)
  }

  // MARK: Through the center

  @Test("a diff is shown, decided hunk by hunk and answered through request.answer; the card keeps only counts")
  func answeredThroughTheCenter() async throws {
    let h = InteractiveHarness()
    try await h.open()
    let opened = try await h.raiseOpen("srq-d", "review.diff", params: try frame("req_diff_settings"))
    #expect(opened.method == "review.diff" && !opened.offersSkip)
    #expect(await h.card("srq-d")?.state == .open)
    #expect(await h.card("srq-d")?.method == "review.diff")

    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-d")

    #expect(await model.answer(.diff(["h1": .approved])) == false, "a hunk left undecided is not sent")
    #expect(h.link.answers.isEmpty)
    #expect(await model.skip() == false)

    #expect(await model.answer(.diff(["h1": .approved, "h2": .rejected])))
    let sent = h.answers("srq-d")
    #expect(sent == [["decision": "approved", "hunks": ["h1": "approved", "h2": "rejected"]]])
    #expect(!h.center.isOpen("srq-d"))

    let card = try #require(await h.card("srq-d"))
    #expect(card.state == .answered)
    #expect(card.answerSummary?.decision == "approved")
    #expect(card.answerSummary?.approvedHunks == 1 && card.answerSummary?.rejectedHunks == 1)

    // Nothing of the diff is in the transcript.
    let canonical = try #require(await h.session.store.state(of: bot)).canonicalJSON
    #expect(!canonical.contains("nl-NL") && !canonical.contains("backoff"), "no line of the diff")
    #expect(!canonical.contains("app/settings.py"), "no path")
  }

  @Test("a refusal of the gateway (4034) stays next to the sheet and the corrected answer goes through")
  func refusedStaysOpen() async throws {
    let h = InteractiveHarness()
    try await h.open()
    try await h.raiseOpen("srq-r", "review.diff", params: try frame("req_diff_settings"))
    let model = InteractiveModel(session: h.session, bot: bot)
    model.present("srq-r")
    h.link.onRequestAnswer { _, result in
      guard result["decision"] != "rejected" else {
        throw GatewayRPCError(.rejected, "answer refused", code: 4034, data: ["reason": "decision:inconsistent"])
      }

      return ["status": "ok"]
    }

    #expect(await model.answer(.diff(["h1": .rejected, "h2": .rejected])) == false)
    #expect(h.center.isOpen("srq-r"))
    #expect(model.refusal == "decision:inconsistent")

    #expect(await model.answer(.diff(["h1": .approved, "h2": .rejected])))
    #expect(!h.center.isOpen("srq-r"))
  }

  @Test("a frame that is not wholly in the contract is declined 4041 and none of it is shown")
  func declinesAnInvalidDiff() async throws {
    let h = InteractiveHarness()
    try await h.open()

    var params = try frame("req_diff_settings")
    var hunks = try #require(params["hunks"]?.arrayValue)
    var first = try #require(hunks[0].objectValue)
    first["id"] = "intro"
    hunks[0] = .object(first)
    params["hunks"] = .array(hunks)
    params["session_id"] = .string(Fixture.runtime)

    let link = h.link
    link.raise(id: "srq-bad", method: "review.diff", params: params)
    let center = h.center
    try await eventually("the notice") { await center.notices[bot] != nil }
    #expect(h.cannotShowReason("srq-bad") == CannotShowReason.notSupportedOnDevice)
    #expect(center.prompts.isEmpty)
    #expect(h.link.answers.isEmpty)
  }

  @Test("a session that did not advertise review.diff is sent none")
  func notAdvertised() async throws {
    let h = InteractiveHarness(requests: ["input.form"])
    try await h.open()

    var params = try frame("req_diff_settings")
    params["session_id"] = .string(Fixture.runtime)
    h.link.raise(id: "srq-n", method: "review.diff", params: params)
    try await h.harness.frame()
    try await Task.sleep(for: .milliseconds(30))
    #expect(h.center.prompts.isEmpty && h.link.declines.isEmpty && h.link.answers.isEmpty)
  }

  @Test("the device announces the four interactive methods, the diff among them, and the device requests it offers")
  func announcesTheDiff() {
    #expect(
      InteractiveCapabilities.deviceMethods(availability: .none)
        == ["input.form", "input.file", "review.draft", "review.diff"])
    // The signature pad and the code scan join with the device's own availability (a camera for the scan).
    #expect(
      InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(signature: true, scan: false))
        == ["input.form", "input.file", "review.draft", "review.diff", "input.signature"])
    #expect(InteractiveCapabilities.deviceMethods(availability: DeviceAvailability(signature: true, scan: true)).last == "device.scan")
    #expect(InteractiveCapabilities.defaultMethods() == InteractiveCapabilities.deviceMethods())
  }
}
