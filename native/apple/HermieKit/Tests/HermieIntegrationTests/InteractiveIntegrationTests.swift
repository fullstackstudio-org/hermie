#if os(macOS)
import CoreGraphics
import CryptoKit
import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import ImageIO
import Testing

@testable import HermieCore

private let researcher = "researcher"

@MainActor
func interactiveWait(_ what: String, _ condition: @MainActor () async throws -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(40)

  while !(try await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("Timed out waiting for \(what)")
      throw CancellationError()
    }

    try await Task.sleep(for: .milliseconds(10))
  }
}

/// `FakeGateway.with`, with a body on the main actor, where the models live.
func withInteractiveGateway(_ body: @escaping @MainActor @Sendable (FakeGateway) async throws -> Void) async throws {
  try await FakeGateway.with(FakeGateway.Options()) { gateway in try await body(gateway) }
}

/// A session on the fake gateway with the researcher's chat open, and the interactive model its
/// screen would hold.
@MainActor
struct InteractiveChat {
  let session: GatewaySession
  let model: InteractiveModel

  /// `requests`: the methods this session announces (the device's own list, which is also what a
  /// session announces unless told otherwise).
  static func open(
    _ gateway: FakeGateway,
    requests: [String] = InteractiveCapabilities.deviceMethods()
  ) async throws -> InteractiveChat {
    var options = GatewaySession.Options()
    options.connection.backoff = { _ in .milliseconds(100) }
    options.requests = requests

    let record = GatewayRecord(id: "g-interactive", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
    let session = try GatewaySession(
      record: record,
      credentials: SessionTokenCredentials(token: ""),
      database: try SQLiteStore(.inMemory),
      options: options
    )
    let chat = InteractiveChat(session: session, model: InteractiveModel(session: session, bot: researcher))

    await session.start()
    try await interactiveWait("the socket and the roster") {
      session.status.phase == .ready && session.chatList.rows[researcher] != nil
    }
    try await session.open(researcher)
    // The second `client.capabilities` call goes out after `gateway.ready`: wait until the
    // gateway took the methods, as it hides a request from a connection that did not advertise it.
    try await acceptedAdvertisements(gateway, atLeast: 1)
    return chat
  }

  /// Wait until the gateway took the methods from `count` calls (one per socket).
  static func acceptedAdvertisements(_ gateway: FakeGateway, atLeast count: Int) async throws {
    try await interactiveWait("the methods to be accepted") {
      let state = try await gateway.control("GET", "/__fake/state")
      return (state["clientCapabilities"]?.arrayValue ?? []).filter { !($0["requests"]?.arrayValue ?? []).isEmpty }
        .count >= count
    }
  }

  /// Raise a request through the fake and wait until the sheet would show it. The id the gateway
  /// gave it.
  func raise(_ gateway: FakeGateway, _ method: String, _ params: JSONObject = [:]) async throws -> String {
    let raised = try await gateway.control(
      "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": .string(method), "params": .object(params)]))
    let id = try #require(raised["id"]?.stringValue)
    let model = self.model
    try await interactiveWait("the \(method) request") { model.openPrompts.contains { $0.id == id } }
    model.present(id)
    return id
  }

  /// What the fake holds of one request: `{open, answer?, outcome?, error?, reason?, refusals}`.
  static func view(_ gateway: FakeGateway, _ id: String) async throws -> JSONValue {
    try await gateway.control("GET", "/__fake/request/\(id)")
  }
}

extension Integration {
  /// The interactive requests against the real fake gateway, over real sockets.
  @Suite("Interactive requests") @MainActor
  struct InteractiveIntegrationTests {
    private static let fields: JSONValue = [
      ["id": "name", "kind": "text", "label": "Name on the booking", "required": true, "max_length": 20],
      ["id": "guests", "kind": "number", "label": "Guests", "integer": true, "min": 1, "max": 12]
    ]

    @Test("the client advertises the methods, and a raised form reaches the center and the chat's transcript")
    func formReachesTheCenter() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields, "title": "Hotel booking"])

        let state = try await gateway.control("GET", "/__fake/state")
        let last = try #require(state["clientCapabilities"]?.arrayValue?.last)
        #expect(last["server_requests"] == true)
        #expect(
          last["requests"]?.arrayValue?.compactMap(\.stringValue) == InteractiveCapabilities.deviceMethods(),
          "the device's own list: the four, and the device requests it offers")

        let presented = try #require(chat.model.presented)
        #expect(presented.id == id)
        #expect(presented.title == "Hotel booking")
        guard case .form(let params) = presented.body else {
          Issue.record("not a form")
          return
        }
        #expect(params.fields?.map(\.id) == ["name", "guests"])
        #expect(chat.model.secondsLeft.map { $0 > 250 && $0 <= 300 } == true, "from expires_at")

        // The fake saw nobody refuse it.
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["open"] == true)
        #expect(view["outcome"] == nil)

        await chat.session.shutdown()
      }
    }

    @Test("a form answered through the model reaches the gateway, which accepts it")
    func answersAForm() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        #expect(await chat.model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"]?["status"] == "answered")
        #expect(view["answer"]?["values"] == ["name": "Ada Lovelace", "guests": 2])
        #expect(view["refusals"] == [])
        #expect(chat.model.presentedID == nil)
        await chat.session.shutdown()
      }
    }

    @Test("a draft approved with an edit reaches the gateway with its text; one rejected with a comment too")
    func answersADraft() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)

        let first = try await chat.raise(gateway, "review.draft", ["text": "Hi Bram,\n\nSee you Friday.", "editable": true])
        #expect(await chat.model.answer(.approve(text: "Hi Bram,\n\nSee you Saturday.")))
        let approved = try await InteractiveChat.view(gateway, first)
        #expect(approved["outcome"] == "answered")
        #expect(approved["answer"]?["decision"] == "approved")
        #expect(approved["answer"]?["text"] == "Hi Bram,\n\nSee you Saturday.")
        #expect(approved["answer"]?["edited"] == true)

        let second = try await chat.raise(gateway, "review.draft", ["text": "Hello"])
        #expect(await chat.model.answer(.reject(comment: "too short")))
        let rejected = try await InteractiveChat.view(gateway, second)
        #expect(rejected["answer"]?["decision"] == "rejected")
        #expect(rejected["answer"]?["comment"] == "too short")
        await chat.session.shutdown()
      }
    }

    /// The unified diff of `app/settings.py` the gateway's own parser reads (two hunks, neither pinned).
    private static let settingsDiff = [
      "--- a/app/settings.py", "+++ b/app/settings.py",
      "@@ -3,4 +3,4 @@ class Settings:",
      "     name = \"booking\"", "-    currency = \"USD\"", "+    currency = \"EUR\"", "     locale = \"nl-NL\"", "     debug = False",
      "@@ -20,3 +20,4 @@ def retry():",
      "     attempts = 0", "-    limit = 3", "+    limit = 5", "+    backoff = 2", "     return attempts",
      ""
    ].joined(separator: "\n")

    /// A Go file indented with tabs: the first hunk starts the file, the last one ends it.
    private static let goDiff = [
      "--- a/cmd/main.go", "+++ b/cmd/main.go",
      "@@ -1,5 +1,5 @@",
      " package main", " ", "-import \"fmt\"", "+import \"log\"", " ", " func main() {",
      "@@ -20,2 +20,3 @@ func tail() {",
      " \ta()", " \tb()", "+\tc()",
      ""
    ].joined(separator: "\n")

    @Test("a diff the gateway's own parser read is shown as it numbered it, decided hunk by hunk, and the agent gets the patch of the approved ones")
    func answersADiff() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "review.diff", ["diff": .string(Self.settingsDiff)])

        let presented = try #require(chat.model.presented)
        guard case .diff(let diff) = presented.body else {
          Issue.record("not a diff")
          return
        }

        #expect(presented.method == "review.diff" && !presented.offersSkip)
        #expect(diff.kind == .modify && diff.path == "app/settings.py")
        #expect(diff.hunkIDs == ["h1", "h2"])
        #expect(diff.hunks[0].header == "@@ -3,4 +3,4 @@ class Settings:" && diff.hunks[0].section == "class Settings:")
        #expect(diff.hunks[0].lines.map(\.mark) == [.context, .removed, .added, .context, .context])
        #expect(diff.hunks[0].lines[1].text == "    currency = \"USD\"", "verbatim, the marker off")
        #expect(diff.hunks.map(\.anchor) == [nil, nil], "neither is pinned")

        // Every hunk has to be decided: one left out is never sent.
        #expect(await chat.model.answer(.diff(["h1": .approved])) == false)
        let open = try await InteractiveChat.view(gateway, id)
        #expect(open["open"] == true && open["refusals"] == [])

        #expect(await chat.model.answer(.diff(["h1": .approved, "h2": .rejected])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered" && view["refusals"] == [])
        #expect(view["answer"]?["decision"] == "approved")
        #expect(view["answer"]?["hunks"] == ["h1": "approved", "h2": "rejected"])

        let patch = try #require(view["answer"]?["approved_patch"]?.stringValue)
        #expect(patch.contains("+    currency = \"EUR\""))
        #expect(!patch.contains("backoff"), "the rejected hunk is not in the patch")
        #expect(chat.model.presentedID == nil)

        // The transcript keeps counts, never a line.
        let card = try #require(
          await chat.session.store.state(of: researcher)?.orderedItems.compactMap(\.asRequest).last { $0.requestID == id })
        #expect(card.answerSummary?.approvedHunks == 1 && card.answerSummary?.rejectedHunks == 1)
        await chat.session.shutdown()
      }
    }

    @Test("a diff of a tab-indented file is shown with its tabs, the start and the end of the file named, and rejecting everything sends no patch")
    func tabsAndAnchors() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "review.diff", ["diff": .string(Self.goDiff)])

        guard case .diff(let diff) = try #require(chat.model.presented).body else {
          Issue.record("not a diff")
          return
        }

        // The gateway pins the first hunk to the start of the file and the last to its end.
        #expect(diff.hunks.map(\.anchor) == [.start, .end])
        #expect(diff.hunks[1].lines.map(\.text) == ["\ta()", "\tb()", "\tc()"], "tabs kept")
        #expect(DiffTextRules.rendered(diff.hunks[1].lines[2].text) == "\u{2192}       c()", "drawn as a marker and the stop")

        #expect(await chat.model.answer(.diff(["h1": .rejected, "h2": .rejected])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["answer"]?["decision"] == "rejected")
        #expect(view["answer"]?["approved_patch"] == nil)
        await chat.session.shutdown()
      }
    }

    @Test("the contract's example diff, a new file, a rename and a deletion are shown and decided")
    func theExamplesAreShown() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)

        // The contract's frame, as the gateway raises it without a diff of its own.
        let example = try await chat.raise(gateway, "review.diff")
        guard case .diff(let diff) = try #require(chat.model.presented).body else {
          Issue.record("not a diff")
          return
        }
        #expect(diff.hunkIDs == ["h1", "h2"] && diff.path == "app/settings.py")
        #expect(await chat.model.answer(.diff(["h1": .approved, "h2": .rejected])))
        #expect(try await InteractiveChat.view(gateway, example)["outcome"] == "answered")

        let new = try await chat.raise(
          gateway, "review.diff", ["diff": "--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,2 @@\n+one\n+two\n"])
        guard case .diff(let created) = try #require(chat.model.presented).body else { return }
        #expect(created.kind == .new && created.hunks[0].anchor == .both)
        #expect(await chat.model.answer(.diff(["h1": .approved])))
        #expect(try await InteractiveChat.view(gateway, new)["answer"]?["approved_patch"]?.stringValue?.contains("+two") == true)

        let renamed = try await chat.raise(
          gateway, "review.diff",
          ["diff": "diff --git a/a.txt b/b.txt\nsimilarity index 90%\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1,3 +1,3 @@\n x\n-y\n+z\n w\n"]
        )
        guard case .diff(let moved) = try #require(chat.model.presented).body else { return }
        #expect(moved.kind == .rename && moved.oldPath == "a.txt" && moved.path == "b.txt")
        #expect(await chat.model.answer(.diff(["h1": .rejected])))
        #expect(try await InteractiveChat.view(gateway, renamed)["outcome"] == "answered")

        let deleted = try await chat.raise(
          gateway, "review.diff", ["diff": "--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n"])
        guard case .diff(let removed) = try #require(chat.model.presented).body else { return }
        #expect(removed.kind == .delete && removed.hunks[0].anchor == .both)
        #expect(await chat.model.answer(.diff(["h1": .approved])))
        #expect(try await InteractiveChat.view(gateway, deleted)["outcome"] == "answered")
        await chat.session.shutdown()
      }
    }

    @Test("a frame the gateway never sends (a hunk id that is not h<n>) is declined 4041 and none of it shown")
    func aBrokenDiffIsDeclined() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let raised = try await gateway.control(
          "POST", "/__fake/request",
          body: .object([
            "profile": .string(researcher), "method": "review.diff",
            "params": ["hunks": [["id": "intro", "header": "@@ -1 +1 @@", "lines": ["-a", "+b"]]]]
          ]))
        let id = try #require(raised["id"]?.stringValue)

        let deadline = ContinuousClock.now + .seconds(10)
        var view = try await InteractiveChat.view(gateway, id)

        while view["outcome"] == nil, ContinuousClock.now < deadline {
          try await Task.sleep(for: .milliseconds(20))
          view = try await InteractiveChat.view(gateway, id)
        }

        #expect(view["outcome"] == "unavailable")
        #expect(view["reason"] == "not_supported_on_device")
        #expect(view["error"]?["code"] == 4041)
        #expect(model.openPrompts.isEmpty && model.presented == nil, "none of it was shown")
        await chat.session.shutdown()
      }
    }

    @Test("Skip answers {status: skipped}; the sheet that cannot go on answers 4041 with its reason")
    func skipAndCannotShow() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)

        let skipped = try await chat.raise(gateway, "input.form", ["fields": Self.fields, "optional": true])
        #expect(await chat.model.skip())
        let skippedView = try await InteractiveChat.view(gateway, skipped)
        #expect(skippedView["outcome"] == "answered")
        #expect(skippedView["answer"]?["status"] == "skipped")

        let declined = try await chat.raise(gateway, "input.file")
        #expect(await chat.model.cannotShow(reason: CannotShowReason.permissionDenied))
        let declinedView = try await InteractiveChat.view(gateway, declined)
        #expect(declinedView["outcome"] == "unavailable")
        #expect(declinedView["reason"] == "permission_denied")
        #expect(declinedView["error"]?["code"] == 4041)
        await chat.session.shutdown()
      }
    }

    @Test("a request the gateway stops waiting for closes the sheet's request with a notice, and nothing is sent")
    func expired() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        _ = try await gateway.control("POST", "/__fake/request/\(id)/expire")
        try await interactiveWait("the request to close") { model.presented == nil }
        #expect(model.presentedOutcome == .expired)
        #expect(await model.answer(.form(["name": .text("too late")])) == false)
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "timeout")
        #expect(view["answer"] == nil)
        await chat.session.shutdown()
      }
    }

    @Test("a request still open at shutdown is answered 4041 shutting_down before the socket closes")
    func shutdownAnswers() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])
        await chat.session.shutdown()

        // The fake logs what it read; give its socket a moment to drain.
        let deadline = ContinuousClock.now + .seconds(5)
        var view = try await InteractiveChat.view(gateway, id)
        while view["outcome"] == nil, ContinuousClock.now < deadline {
          try await Task.sleep(for: .milliseconds(20))
          view = try await InteractiveChat.view(gateway, id)
        }
        #expect(view["outcome"] == "unavailable")
        #expect(view["reason"] == "shutting_down")
      }
    }

    @Test("a client that advertises nothing is sent nothing: the gateway has no capable client")
    func nothingAdvertised() async throws {
      try await withInteractiveGateway { gateway in
        var options = GatewaySession.Options()
        options.requests = []
        let record = GatewayRecord(id: "g-none", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        await session.start()
        try await interactiveWait("the socket") { session.status.phase == .ready && session.chatList.rows[researcher] != nil }
        try await session.open(researcher)

        await #expect(throws: FakeGatewayError.self) {
          try await gateway.control(
            "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": "input.form"]))
        }
        #expect(session.interactive.prompts.isEmpty)
        await session.shutdown()
      }
    }

    @Test("a socket that drops while a form is open: after the reconnect the form is still open, and answerable")
    func formSurvivesAReconnect() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let session = chat.session
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await interactiveWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }
        await session.retryNow()
        try await interactiveWait("the socket to come back") { session.status.phase == .ready }
        try await InteractiveChat.acceptedAdvertisements(gateway, atLeast: 2)
        // Let the recovery's resume and replay (and the read again after the acceptance) land.
        try await Task.sleep(for: .milliseconds(500))

        #expect(model.presented?.id == id, "still open: no list read before the acceptance closed it")
        #expect(model.presentedOutcome == nil)
        #expect(chat.session.interactive.notices.isEmpty)

        #expect(await model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["answer"]?["values"] == ["name": "Ada Lovelace", "guests": 2])
        await session.shutdown()
      }
    }

    @Test("a reconnect whose capability calls fail: the lists it reads leave the form out, and it stays open and answerable")
    func formSurvivesFailedAdvertisement() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let session = chat.session
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        let replays = { () async throws -> Int in
          let state = try await gateway.control("GET", "/__fake/state")
          return (state["methodLog"]?.arrayValue ?? []).filter { $0 == "session.events.since" }.count
        }
        let before = try await replays()

        // The new socket never gets its methods accepted, so the gateway hides the form from the
        // resume's and the replay's `open_requests`: those lists say nothing about it.
        _ = try await gateway.control("POST", "/__fake/deny", body: ["methods": ["client.capabilities"]])
        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await interactiveWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }
        await session.retryNow()
        try await interactiveWait("the socket to come back") { session.status.phase == .ready }
        try await interactiveWait("the replay") { try await replays() > before }
        try await Task.sleep(for: .milliseconds(300))

        #expect(model.presented?.id == id, "still open: no list closed it")
        #expect(model.presentedOutcome == nil)

        // `request.answer` reaches it from any connection.
        #expect(await model.answer(.form(["name": .text("Ada Lovelace"), "guests": .number(2)])))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        await session.shutdown()
      }
    }

    @Test("a form answered on another device while the socket is down closes as lapsed after the reconnect")
    func answeredElsewhereWhileDown() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let session = chat.session
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        _ = try await gateway.control("POST", "/__fake/drop-sockets")
        try await interactiveWait("the socket to drop") {
          let state = try await gateway.control("GET", "/__fake/state")
          return session.status.phase != .ready && state["openSockets"] == 0
        }

        // Another device answers it meanwhile (the fake sends no request.cancel for that).
        let other = try LiveConnection(gateway: gateway, credentials: SessionTokenCredentials(token: ""))
        await other.connection.start()
        try await other.waitFor(.ready)
        let taken = try await other.connection.request(
          "request.answer",
          params: ["id": .string(id), "result": ["status": "answered", "values": ["name": "Bram", "guests": 3]]])
        await other.connection.shutdown()
        #expect(taken["status"] == "ok")
        #expect(model.presented?.id == id, "the client heard nothing: the sheet is still up")

        await session.retryNow()
        try await interactiveWait("the request to close") { model.presented == nil }
        #expect(model.presentedOutcome == .lapsed)
        #expect(await model.answer(.form(["name": .text("too late"), "guests": .number(2)])) == false)
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["answer"]?["values"]?["name"] == "Bram", "only the other device's answer")
        await session.shutdown()
      }
    }

    @Test("a refused answer (4034) keeps the form open with the gateway's reason; the corrected one is taken")
    func refusedAnswer() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
        #expect(model.refusal == "field:guests:below_min")
        #expect(model.presented?.id == id, "the sheet stays up")
        let refused = try await InteractiveChat.view(gateway, id)
        #expect(refused["open"] == true)
        #expect(refused["refusals"] == ["field:guests:below_min"])

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])))
        #expect(model.refusal == nil)
        let taken = try await InteractiveChat.view(gateway, id)
        #expect(taken["outcome"] == "answered")
        await chat.session.shutdown()
      }
    }

    @Test("the tenth refused answer withdraws the request")
    func refusalCap() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        for attempt in 1...9 {
          #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
          #expect(model.refusal == "field:guests:below_min", "attempt \(attempt)")
        }

        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
        try await interactiveWait("the request to close") { model.presented == nil }
        #expect(model.presentedOutcome == .withdrawn)
        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])) == false)
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "too_many_attempts")
        #expect(view["refusals"]?.arrayValue?.count == 10)
        await chat.session.shutdown()
      }
    }

    @Test("by default a session announces the device's own list, and a request for it reaches the center")
    func advertisedByDefault() async throws {
      try await withInteractiveGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        let record = GatewayRecord(id: "g-default", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        await session.start()
        try await interactiveWait("the socket") { session.status.phase == .ready && session.chatList.rows[researcher] != nil }
        try await session.open(researcher)
        try await InteractiveChat.acceptedAdvertisements(gateway, atLeast: 1)

        // What is advertised is the device's list, nothing more and nothing less.
        let state = try await gateway.control("GET", "/__fake/state")
        let last = try #require(state["clientCapabilities"]?.arrayValue?.last)
        #expect(last["requests"]?.arrayValue?.compactMap(\.stringValue) == InteractiveCapabilities.deviceMethods())

        let raised = try await gateway.control(
          "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": "input.form"]))
        let id = try #require(raised["id"]?.stringValue)
        try await interactiveWait("the form") { session.interactive.isOpen(id) }
        await session.shutdown()
      }
    }

    @Test("a session told to announce nothing is sent nothing, whatever the default is")
    func announcingNothing() async throws {
      try await withInteractiveGateway { gateway in
        var options = GatewaySession.Options()
        options.connection.backoff = { _ in .milliseconds(100) }
        options.requests = []
        let record = GatewayRecord(id: "g-quiet", name: "fake", address: gateway.baseURL, authKind: .sessionToken, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: SessionTokenCredentials(token: ""),
          database: try SQLiteStore(.inMemory),
          options: options
        )
        await session.start()
        try await interactiveWait("the socket") { session.status.phase == .ready && session.chatList.rows[researcher] != nil }
        try await session.open(researcher)
        try await Task.sleep(for: .milliseconds(200))

        let state = try await gateway.control("GET", "/__fake/state")
        let advertised = (state["clientCapabilities"]?.arrayValue ?? []).contains { !($0["requests"]?.arrayValue ?? []).isEmpty }
        #expect(!advertised)
        await #expect(throws: FakeGatewayError.self) {
          try await gateway.control(
            "POST", "/__fake/request", body: .object(["profile": .string(researcher), "method": "input.form"]))
        }
        #expect(session.interactive.prompts.isEmpty)
        await session.shutdown()
      }
    }

    // MARK: The sheets' own models

    /// Every kind of field of the contract, in one form.
    private static let everyKind: JSONValue = [
      ["id": "name", "kind": "text", "label": "Name on the booking", "required": true, "max_length": 20],
      ["id": "notes", "kind": "text", "label": "Notes", "multiline": true],
      ["id": "guests", "kind": "number", "label": "Guests", "integer": true, "min": 1, "max": 12, "default": 2],
      ["id": "budget", "kind": "amount", "label": "Budget", "currency": "EUR", "min": "0", "max": "5000"],
      ["id": "arrival", "kind": "date", "label": "Arrival", "tz": "Europe/Amsterdam", "min": "2026-10-05"],
      ["id": "check_in", "kind": "time", "label": "Check-in", "min": "08:00", "max": "18:00"],
      ["id": "call_at", "kind": "datetime", "label": "Call", "tz": "Europe/Amsterdam", "min": "2026-10-05T00:00:00+02:00"],
      ["id": "stay", "kind": "daterange", "label": "Stay", "required": true, "min": "2026-10-05", "max": "2026-12-31"],
      ["id": "room", "kind": "choice", "label": "Room",
        "options": [["value": "single", "label": "Single"], ["value": "double", "label": "Double"]]],
      ["id": "extras", "kind": "choice", "label": "Extras", "multiple": true, "max_selected": 2,
        "options": [["value": "breakfast", "label": "Breakfast"], ["value": "parking", "label": "Parking"],
          ["value": "late", "label": "Late check-out"]]],
      ["id": "news", "kind": "toggle", "label": "Send me offers", "default": false]
    ]

    @Test("a form with every kind of field, filled in through the sheet's model, is taken by the gateway as it is written")
    func everyKindOfField() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.everyKind])
        guard case .form(let params)? = chat.model.presented?.body else {
          Issue.record("not a form")
          return
        }

        let form = InteractiveFormModel(params: params, device: TimeZone(identifier: "America/New_York") ?? .current)

        // Nothing sent for a form that is not filled in: the required fields say so.
        #expect(form.submit() == nil)
        #expect(form.shownProblem(of: "name") == .missing)
        #expect(form.shownProblem(of: "stay") == .missing)

        form.set(.text("Ada Lovelace"), for: "name")
        form.set(.text("Arriving late.\nNo nuts, please."), for: "notes")
        form.set(.number("4"), for: "guests")
        form.set(.amount("1250,50"), for: "budget")
        form.set(.date("2026-11-14"), for: "arrival")
        form.set(.time("14:30"), for: "check_in")
        let call = try #require(FormInstant.parse("2026-11-07T08:00:00+00:00"))
        form.set(.datetime(call), for: "call_at")
        form.set(.range(start: "2026-11-14", end: "2026-11-16"), for: "stay")
        form.set(.choice("double"), for: "room")
        form.toggle(option: "parking", in: "extras")
        form.toggle(option: "breakfast", in: "extras")
        form.set(.toggle(true), for: "news")

        let values = try #require(form.submit())
        #expect(await chat.model.answer(.form(values)))

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["refusals"] == [])
        #expect(
          view["answer"]?["values"] == [
            "name": "Ada Lovelace", "notes": "Arriving late.\nNo nuts, please.", "guests": 4, "budget": "1250.50",
            "arrival": "2026-11-14", "check_in": "14:30", "call_at": "2026-11-07T09:00+01:00[Europe/Amsterdam]",
            "stay": ["start": "2026-11-14", "end": "2026-11-16"], "room": "double",
            "extras": ["breakfast", "parking"], "news": true
          ])
        form.wipe()
        await chat.session.shutdown()
      }
    }

    @Test("an answer the gateway refuses is shown next to its field, and the corrected one is taken")
    func refusalNextToTheField() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])
        guard case .form(let params)? = model.presented?.body else {
          Issue.record("not a form")
          return
        }

        let form = InteractiveFormModel(params: params)
        form.set(.text("Ada"), for: "name")
        // The sheet's own check would stop this one; what the gateway says about an answer the
        // sheet let through is the same thing, and that is what is shown.
        form.set(.number("0"), for: "guests")
        #expect(form.problem(of: "guests") == .belowMin)
        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(0)])) == false)
        form.noteRefusal(model.refusal)
        #expect(model.refusal == "field:guests:below_min")
        #expect(form.shownProblem(of: "guests") == .belowMin, "next to the field, before it is edited")
        #expect(form.shownProblem(of: "name") == nil)
        #expect(model.presented?.id == id, "the sheet stays up")

        form.set(.number("2"), for: "guests")
        #expect(form.shownProblem(of: "guests") == nil, "an edited field is not blamed again")
        let values = try #require(form.submit())
        #expect(await model.answer(.form(values)))
        form.noteRefusal(model.refusal)

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["refusals"] == ["field:guests:below_min"])
        #expect(view["answer"]?["values"] == ["name": "Ada", "guests": 2])
        await chat.session.shutdown()
      }
    }

    /// The upload directory the fake's `input.file` frame names, with room for what the tests send.
    private static func fileParams(strip: Bool = false, multiple: Bool = true) -> JSONObject {
      [
        "title": "Receipts", "summary": "Upload the receipts.", "accept": "any", "multiple": .bool(multiple),
        "upload": [
          "dir": "/home/ada/work/uploads/hermie/2026-10-04", "max_bytes": 1_048_576, "max_total_bytes": 2_097_152,
          "max_files": 3, "strip_metadata": .bool(strip)
        ]
      ]
    }

    /// What the fake's upload route stored: path, name, mime, size and SHA-256.
    private static func stored(_ gateway: FakeGateway) async throws -> [JSONValue] {
      try await gateway.control("GET", "/__fake/files")["files"]?.arrayValue ?? []
    }

    @Test("files chosen in the sheet's model land flat in upload.dir with the SHA-256 and size the answer quotes")
    func filesLandInTheUploadDirectory() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.file", Self.fileParams())
        guard case .file(let params)? = model.presented?.body else {
          Issue.record("not a file request")
          return
        }

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("interactive-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = Data("first receipt".utf8)
        let second = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        let urls = [folder.appendingPathComponent("Receipt (1).txt"), folder.appendingPathComponent("scan.pdf")]
        try first.write(to: urls[0])
        try second.write(to: urls[1])

        let files = InteractiveFileModel(params: params)
        await files.importFiles(urls)
        #expect(files.items.count == 2)

        let references = try #require(await files.upload(through: model.uploader))
        #expect(await model.answer(.files(references, text: nil)))
        files.discardAll()

        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "answered")
        #expect(view["refusals"] == [])

        let answered = try #require(view["answer"]?["files"]?.arrayValue)
        let landed = try await Self.stored(gateway)
        #expect(landed.count == 2)
        #expect(answered.count == 2)

        for (reference, file) in zip(references, landed) {
          let path = try #require(reference.path)
          // Flat: directly in the directory, a 16 hex token and a safe name.
          #expect(params.upload?.contains(path: path) == true)
          #expect(path.range(of: #"^/home/ada/work/uploads/hermie/2026-10-04/[0-9a-f]{16}-[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil, "\(path)")
          // What the gateway stored is what the answer says it is.
          #expect(file["path"]?.stringValue == path)
          #expect(file["sha256"]?.stringValue == reference.sha256)
          #expect(file["bytes"]?.intValue == reference.bytes)
        }

        let hashes = SHA256Hex.of
        #expect(landed.map { $0["sha256"]?.stringValue } == [hashes(first), hashes(second)])
        #expect(landed.map { $0["bytes"]?.intValue } == [first.count, second.count])
        #expect(answered.map { $0["name"]?.stringValue } == ["Receipt (1).txt", "scan.pdf"])
        #expect(answered.map { $0["sha256"]?.stringValue } == [hashes(first), hashes(second)])
        #expect(answered.map { $0["path"]?.stringValue } == landed.map { $0["path"]?.stringValue })
        await chat.session.shutdown()
      }
    }

    @Test("with strip_metadata the bytes that go out have no location, and the SHA-256 is of those bytes")
    func strippedBytesAreWhatIsHashed() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        _ = try await chat.raise(gateway, "input.file", Self.fileParams(strip: true, multiple: false))
        guard case .file(let params)? = model.presented?.body else {
          Issue.record("not a file request")
          return
        }

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("interactive-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let photo = folder.appendingPathComponent("receipt.jpg")
        try located().write(to: photo)
        let original = try Data(contentsOf: photo)
        #expect(try gps(in: original))

        let files = InteractiveFileModel(params: params)
        await files.importFiles([photo])
        let references = try #require(await files.upload(through: model.uploader))
        #expect(await model.answer(.files(references, text: nil)))
        files.discardAll()

        let landed = try await Self.stored(gateway)
        let file = try #require(landed.first)
        #expect(file["sha256"]?.stringValue == references[0].sha256)
        #expect(file["sha256"]?.stringValue != SHA256Hex.of(original), "not the original's bytes")
        #expect(file["mime"]?.stringValue == "image/jpeg")
        await chat.session.shutdown()
      }
    }

    @Test("an upload that fails is said to the person; giving up answers 4041 upload_failed, and nothing else was answered")
    func failedUploadIsCannotShow() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.file", Self.fileParams(multiple: false))
        guard case .file(let params)? = model.presented?.body else {
          Issue.record("not a file request")
          return
        }

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("interactive-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("a.txt")
        try Data("a".utf8).write(to: url)

        let files = InteractiveFileModel(params: params)
        await files.importFiles([url])
        let failing: InteractiveUploader = { _, _, _, _, _ in throw GatewayError(.network, "Could not reach the gateway.") }
        #expect(await files.upload(through: failing) == nil)
        #expect(files.phase == .failed, "the person sees it before anything is sent")
        #expect(files.failure == .failed(message: "Could not reach the gateway."))
        #expect(try await InteractiveChat.view(gateway, id)["outcome"] == nil, "nothing answered yet")

        #expect(await model.cannotShow(reason: CannotShowReason.uploadFailed))
        files.discardAll()
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "unavailable")
        #expect(view["reason"] == "upload_failed")
        #expect(view["error"]?["code"] == 4041)
        #expect(view["answer"] == nil)
        #expect(try await Self.stored(gateway).isEmpty)
        await chat.session.shutdown()
      }
    }

    @Test("a draft edited in the sheet's model is approved with its text; a rejection carries the comment")
    func draftsThroughTheModel() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model

        let first = try await chat.raise(
          gateway, "review.draft",
          ["kind": "mail", "subject": "Friday", "recipients": ["bram@example.com"], "text": "Hi Bram,\n\nSee you Friday.\n"])
        guard case .draft(let params)? = model.presented?.body else {
          Issue.record("not a draft")
          return
        }

        let draft = InteractiveDraftModel(params: params)
        #expect(!draft.isEdited)
        draft.text = "Hi Bram,\n\nSee you Saturday.\n"
        #expect(draft.isEdited && draft.canApprove)
        #expect(await model.answer(draft.approval))
        let approved = try await InteractiveChat.view(gateway, first)
        #expect(approved["answer"]?["decision"] == "approved")
        #expect(approved["answer"]?["edited"] == true)
        draft.wipe()

        // Text the gateway would refuse never goes out: the sheet will not approve it.
        let second = try await chat.raise(gateway, "review.draft", ["text": "Pay now", "editable": true])
        guard case .draft(let again)? = model.presented?.body else {
          Issue.record("not a draft")
          return
        }
        let bad = InteractiveDraftModel(params: again)
        bad.text = "Pay now\u{202E}gnp.exe"
        #expect(!bad.canApprove)
        bad.comment = "Not like this"
        #expect(await model.answer(bad.rejection))
        let rejected = try await InteractiveChat.view(gateway, second)
        #expect(rejected["answer"]?["decision"] == "rejected")
        #expect(rejected["answer"]?["comment"] == "Not like this")
        #expect(rejected["answer"]?["text"] == nil)
        await chat.session.shutdown()
      }
    }

    @Test("a draft that cannot be changed: the model will not send a changed text, and takes it back as it came")
    func fixedDraft() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "review.draft", ["text": "As written.", "editable": false])
        guard case .draft(let params)? = model.presented?.body else {
          Issue.record("not a draft")
          return
        }

        let draft = InteractiveDraftModel(params: params)
        draft.text = "Changed."
        #expect(!draft.canApprove)
        #expect(!model.canAnswer(draft.approval))
        #expect(await model.answer(draft.approval) == false)
        #expect(try await InteractiveChat.view(gateway, id)["answer"] == nil)

        draft.revert()
        #expect(await model.answer(draft.approval))
        #expect(try await InteractiveChat.view(gateway, id)["outcome"] == "answered")
        await chat.session.shutdown()
      }
    }

    @Test("Don't share answers 4041 declined, which the gateway reports as unavailable, never as an answer")
    func declined() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields, "optional": false])

        #expect(await model.cannotShow(reason: CannotShowReason.declined))
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["outcome"] == "unavailable")
        #expect(view["reason"] == "declined")
        #expect(view["error"]?["code"] == 4041)
        #expect(view["answer"] == nil)
        await chat.session.shutdown()
      }
    }

    @Test("Later puts a form away without answering; the request stays open at the gateway and opens again")
    func laterIsNotAnAnswer() async throws {
      try await withInteractiveGateway { gateway in
        let chat = try await InteractiveChat.open(gateway)
        let model = chat.model
        let id = try await chat.raise(gateway, "input.form", ["fields": Self.fields])

        model.later()
        #expect(model.presentedID == nil)
        #expect(model.nextToPresent == nil, "it does not come back by itself")
        let view = try await InteractiveChat.view(gateway, id)
        #expect(view["open"] == true)
        #expect(view["outcome"] == nil)

        model.present(id)
        #expect(await model.answer(.form(["name": .text("Ada"), "guests": .number(2)])))
        await chat.session.shutdown()
      }
    }
  }
}

/// A JPEG that says where it was taken, as ImageIO writes it.
private func located() throws -> Data {
  let context = try #require(
    CGContext(
      data: nil, width: 32, height: 24, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
  context.setFillColor(red: 0.2, green: 0.5, blue: 0.9, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: 32, height: 24))

  let output = NSMutableData()
  let destination = try #require(CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil))
  let properties: [CFString: Any] = [
    kCGImagePropertyGPSDictionary: [
      kCGImagePropertyGPSLatitude: 52.3676, kCGImagePropertyGPSLatitudeRef: "N",
      kCGImagePropertyGPSLongitude: 4.9041, kCGImagePropertyGPSLongitudeRef: "E"
    ]
  ]
  CGImageDestinationAddImage(destination, try #require(context.makeImage()), properties as CFDictionary)
  #expect(CGImageDestinationFinalize(destination))
  return output as Data
}

/// Whether the JPEG carries a GPS dictionary.
private func gps(in data: Data) throws -> Bool {
  let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  return properties?[kCGImagePropertyGPSDictionary] != nil
}

private enum SHA256Hex {
  static func of(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
#endif
