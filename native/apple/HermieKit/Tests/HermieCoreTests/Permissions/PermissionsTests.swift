import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

// A bot's permissions: what goes on the wire for each call (always with the bot's profile, exactly the
// contract's keys), how the gateway's answer is read, how a refusal is sorted, and what the page's model does
// with it: list, revoke one or all only after a confirmation, refresh after each revoke, and write a revoke to
// the decision log.

private let bot = "researcher"

private func refusal(_ message: String, code: Int) -> GatewayRPCError {
  GatewayRPCError(.rejected, message, code: code)
}

private func grant(_ id: String, _ label: String, kind: PermissionGrantKind = .pattern, tirith: Bool = false)
  -> PermissionGrant
{
  PermissionGrant(id: id, kind: kind, label: label, tirith: tirith)
}

// MARK: - The wire

@Suite("Permissions on the wire") struct PermissionsWireTests {
  private func service() -> (PermissionsService, ScriptedLink) {
    let link = ScriptedLink()
    link.respond(
      to: "approval.grants",
      with: .object(["mode": .string("manual"), "permanent": .array([]), "sessions": .array([])]))
    link.respond(to: "approval.revoke", with: .object(["revoked": .number(1)]))
    return (PermissionsService(link: link), link)
  }

  @Test func grantsNamesTheBotsProfileAndNothingElse() async throws {
    let (service, link) = service()

    _ = try await service.grants(profile: bot)

    #expect(link.calls.map(\.method) == ["approval.grants"])
    #expect(link.calls.map(\.params) == [.object(["profile": .string(bot)])])
  }

  @Test func aStandingRevokeNamesTheScopeOneIdAndTheProfile() async throws {
    let (service, link) = service()

    let revoked = try await service.revoke(profile: bot, scope: .permanent, target: .one("perm:3f9a0c1d2e4b5a69"))

    #expect(revoked == 1)
    #expect(link.calls.map(\.method) == ["approval.revoke"])
    #expect(
      link.calls.first?.params
        == .object(["profile": .string(bot), "scope": .string("permanent"), "id": .string("perm:3f9a0c1d2e4b5a69")]))
  }

  @Test func revokeAllSendsAllTrueAndNoId() async throws {
    let (service, link) = service()

    _ = try await service.revoke(profile: bot, scope: .permanent, target: .all)

    #expect(
      link.calls.first?.params == .object(["profile": .string(bot), "scope": .string("permanent"), "all": .bool(true)]))
    #expect(link.calls.first?.params["id"] == nil, "exactly one of id and all")
  }

  @Test func aSessionRevokeNamesTheSessionToo() async throws {
    let (service, link) = service()

    _ = try await service.revoke(profile: bot, scope: .session("a1b2c3d4"), target: .one("sess:5b0e2a9c7d1f3e84"))
    _ = try await service.revoke(profile: bot, scope: .session("a1b2c3d4"), target: .all)

    #expect(
      link.calls.map(\.params) == [
        .object([
          "profile": .string(bot), "scope": .string("session"), "session_id": .string("a1b2c3d4"),
          "id": .string("sess:5b0e2a9c7d1f3e84")
        ]),
        .object([
          "profile": .string(bot), "scope": .string("session"), "session_id": .string("a1b2c3d4"),
          "all": .bool(true)
        ])
      ])
  }

  @Test func theRevokedCountIsReadAndAnIdThatIsGoneIsZero() async throws {
    let link = ScriptedLink()
    link.respond(to: "approval.revoke", with: .object(["revoked": .number(0)]))
    let service = PermissionsService(link: link)

    #expect(try await service.revoke(profile: bot, scope: .permanent, target: .one("perm:gone")) == 0)

    link.respond(to: "approval.revoke", with: .object([:]))

    #expect(try await service.revoke(profile: bot, scope: .permanent, target: .all) == 0)
  }

  @Test func aRefusalIsSortedByItsCode() async {
    let link = ScriptedLink()
    link.refuse("approval.grants") { params in
      switch params["profile"]?.stringValue {
      case "agent": refusal("an agent may not read the standing approvals", code: 4033)
      case "nobody": refusal("Profile 'nobody' does not exist.", code: 4064)
      case "old": refusal("unknown method: approval.grants", code: -32601)
      default: nil
      }
    }
    link.refuse("approval.revoke") { params in
      switch params["scope"]?.stringValue {
      case "session": refusal("session not found", code: 4001)
      default: refusal("send exactly one of id or all", code: 4006)
      }
    }
    link.respond(to: "approval.grants", with: .object(["mode": .string("manual")]))
    let service = PermissionsService(link: link)

    await #expect(throws: PermissionFailure.refused) { _ = try await service.grants(profile: "agent") }
    await #expect(throws: PermissionFailure.unknownProfile) { _ = try await service.grants(profile: "nobody") }
    await #expect(throws: PermissionFailure.unsupported) { _ = try await service.grants(profile: "old") }
    await #expect(throws: PermissionFailure.sessionGone) {
      _ = try await service.revoke(profile: bot, scope: .session("gone"), target: .all)
    }
    await #expect(throws: PermissionFailure.failed("send exactly one of id or all")) {
      _ = try await service.revoke(profile: bot, scope: .permanent, target: .all)
    }
  }

  @Test func noConnectionIsOffline() async {
    let link = ScriptedLink()
    await link.shutdown()

    await #expect(throws: PermissionFailure.offline) { _ = try await PermissionsService(link: link).grants(profile: bot) }
  }

  @Test func theClassifierSortsWhatACallCanThrow() {
    #expect(PermissionFailure.classify(GatewayRPCError(.timeout, "request timed out")) == .timedOut)
    #expect(PermissionFailure.classify(GatewayRPCError(.notConnected, "gateway not connected")) == .offline)
    #expect(PermissionFailure.classify(GatewayRPCError(.closed, "closed")) == .offline)
    #expect(PermissionFailure.classify(CancellationError()) == .offline)
    #expect(PermissionFailure.classify(refusal("nope", code: 4033)) == .refused)
    #expect(PermissionFailure.classify(refusal("nope", code: 4064)) == .unknownProfile)
    #expect(PermissionFailure.classify(refusal("nope", code: 4001)) == .sessionGone)
    #expect(PermissionFailure.classify(refusal("unknown method", code: -32601)) == .unsupported)
    #expect(PermissionFailure.classify(refusal("boom", code: 5004)) == .failed("boom"))
    #expect(PermissionFailure.classify(PermissionFailure.refused) == .refused)
    #expect(PermissionFailure.failed("boom").detail == "boom")
    #expect(PermissionFailure.refused.detail == nil)
  }
}

// MARK: - What the gateway answers

@Suite("A permissions listing") struct PermissionsListingTests {
  /// The shape `approval.grants` documents.
  private static let documented: JSONValue = .object([
    "mode": .string("smart"),
    "permanent": .array([
      .object([
        "id": .string("perm:3f9a0c1d2e4b5a69"), "kind": .string("pattern"),
        "label": .string("script execution via heredoc; tee to a system file")
      ]),
      .object(["id": .string("perm:8c1e77a0b2d94f13"), "kind": .string("glob"), "label": .string("podman *")])
    ]),
    "sessions": .array([
      .object([
        "session_id": .string("a1b2c3d4"), "session_key": .string("20261005_101500_ab12cd"), "yolo": .bool(true),
        "grants": .array([
          .object([
            "id": .string("sess:5b0e2a9c7d1f3e84"), "kind": .string("pattern"),
            "label": .string("tirith:homograph_url"), "tirith": .bool(true)
          ])
        ])
      ]),
      .object(["session_id": .string("e5f6"), "session_key": .string("k"), "yolo": .bool(false), "grants": .array([])])
    ])
  ])

  @Test func theDocumentedAnswerIsRead() {
    let snapshot = PermissionsSnapshot.parse(Self.documented)

    #expect(snapshot.mode == .smart)
    #expect(snapshot.permanent.map(\.id) == ["perm:3f9a0c1d2e4b5a69", "perm:8c1e77a0b2d94f13"])
    #expect(snapshot.permanent.map(\.kind) == [.pattern, .glob])
    #expect(snapshot.permanent.first?.label == "script execution via heredoc; tee to a system file")
    #expect(snapshot.sessions.map(\.sessionID) == ["a1b2c3d4", "e5f6"])
    #expect(snapshot.sessions.map(\.yolo) == [true, false])
    #expect(snapshot.sessions.first?.grants == [grant("sess:5b0e2a9c7d1f3e84", "tirith:homograph_url", tirith: true)])
    #expect(snapshot.sessions.last?.grants == [])
    #expect(snapshot.count == 3)
  }

  @Test func theSessionKeyIsReadSoTheBotsOwnChatCanBeToldApart() {
    let snapshot = PermissionsSnapshot.parse(Self.documented)

    #expect(snapshot.sessions.map(\.sessionKey) == ["20261005_101500_ab12cd", "k"])
  }

  @Test func theModesAreRead() {
    for (word, mode) in [("manual", ApprovalMode.manual), ("smart", .smart), ("off", .off), ("odd", .other("odd"))] {
      #expect(PermissionsSnapshot.parse(.object(["mode": .string(word)])).mode == mode)
    }

    #expect(PermissionsSnapshot.parse(.object([:])).mode == .manual, "no mode reads as the default")
  }

  @Test func aLabelWithSeveralRulesStaysOneTextAndAKindItDoesNotKnowIsOther() {
    let snapshot = PermissionsSnapshot.parse(
      .object([
        "permanent": .array([
          .object(["id": .string("perm:1"), "kind": .string("future"), "label": .string("a; b; c")])
        ])
      ]))

    #expect(snapshot.permanent == [grant("perm:1", "a; b; c", kind: .other)])
  }

  @Test func rowsWithoutAnIdOrWithARepeatedOrOverlongIdAreLeftOut() {
    let snapshot = PermissionsSnapshot.parse(
      .object([
        "permanent": .array([
          .object(["label": .string("no id")]),
          .object(["id": .string(""), "label": .string("empty id")]),
          .object(["id": .string("perm:1"), "kind": .string("pattern"), "label": .string("first")]),
          .object(["id": .string("perm:1"), "kind": .string("pattern"), "label": .string("second")]),
          .object(["id": .string(String(repeating: "x", count: 101)), "label": .string("long id")])
        ]),
        "sessions": .array([
          .object(["yolo": .bool(true)]),
          .object(["session_id": .string("s1")]),
          .object(["session_id": .string("s1"), "yolo": .bool(true)])
        ])
      ]))

    #expect(snapshot.permanent == [grant("perm:1", "first")])
    #expect(snapshot.sessions == [SessionPermissions(sessionID: "s1", yolo: false, grants: [])])
  }

  @Test func aLabelIsOneCleanBoundedLine() {
    let long = String(repeating: "a", count: 5_000)
    let snapshot = PermissionsSnapshot.parse(
      .object([
        "permanent": .array([
          .object(["id": .string("perm:1"), "label": .string("one\ntwo\u{202E}three")]),
          .object(["id": .string("perm:2"), "label": .string(long)])
        ])
      ]))

    #expect(snapshot.permanent.first?.label == "one twothree", "a break is a space, a direction mark is dropped")
    #expect((snapshot.permanent.last?.label.count ?? 0) <= PermissionGrant.labelLimit)
  }

  @Test func aListIsCapped() {
    let rows = (0..<(PermissionGrant.listLimit + 20)).map {
      JSONValue.object(["id": .string("perm:\($0)"), "label": .string("rule \($0)")])
    }

    #expect(PermissionsSnapshot.parse(.object(["permanent": .array(rows)])).permanent.count == PermissionGrant.listLimit)
  }

  @Test func anEmptyOrOddAnswerIsAnEmptyList() {
    #expect(PermissionsSnapshot.parse(.object([:])) == PermissionsSnapshot())
    #expect(PermissionsSnapshot.parse(.string("nope")) == PermissionsSnapshot())
    #expect(PermissionsSnapshot.parse(.object(["permanent": .string("x"), "sessions": .number(1)])).count == 0)
  }
}

// MARK: - The page's model

/// The gateway's side of the approval calls, scripted and recording what reached it. A revoke changes what the
/// next list says, as the gateway does.
final class StubPermissions: PermissionsBackend, Sendable {
  struct Revoke: Equatable, Sendable {
    var profile: String
    var scope: PermissionScope
    var target: PermissionTarget
  }

  private struct State {
    var snapshot = PermissionsSnapshot()
    var revokes: [Revoke] = []
    var reads = 0
    var readProfiles: [String] = []
    var readError: (any Error)?
    var revokeError: (any Error)?
    /// An answer to every revoke regardless of what was stored.
    var forcedCount: Int?
  }

  private let state = Mutex(State())

  var revokes: [Revoke] { state.withLock { $0.revokes } }
  var reads: Int { state.withLock { $0.reads } }
  var readProfiles: [String] { state.withLock { $0.readProfiles } }

  func set(_ snapshot: PermissionsSnapshot) { state.withLock { $0.snapshot = snapshot } }
  func failRead(_ error: (any Error)?) { state.withLock { $0.readError = error } }
  func failRevoke(_ error: (any Error)?) { state.withLock { $0.revokeError = error } }
  func answer(revoked: Int?) { state.withLock { $0.forcedCount = revoked } }

  func grants(profile: String) async throws -> PermissionsSnapshot {
    try state.withLock { state in
      state.reads += 1
      state.readProfiles.append(profile)
      if let error = state.readError { throw error }
      return state.snapshot
    }
  }

  func revoke(profile: String, scope: PermissionScope, target: PermissionTarget) async throws -> Int {
    try state.withLock { state in
      state.revokes.append(Revoke(profile: profile, scope: scope, target: target))
      if let error = state.revokeError { throw error }

      var removed = 0

      func drop(_ grants: inout [PermissionGrant]) {
        let before = grants.count

        switch target {
        case .all: grants = []
        case .one(let id): grants.removeAll { $0.id == id }
        }

        removed = before - grants.count
      }

      switch scope {
      case .permanent:
        drop(&state.snapshot.permanent)
      case .session(let id):
        if let index = state.snapshot.sessions.firstIndex(where: { $0.sessionID == id }) {
          drop(&state.snapshot.sessions[index].grants)
        }
      }

      return state.forcedCount ?? removed
    }
  }
}

private let standing = [grant("perm:1", "recursive delete; force delete"), grant("perm:2", "podman *", kind: .glob)]
private let live = [
  SessionPermissions(sessionID: "rt-chat", yolo: true, grants: [grant("sess:1", "script execution via heredoc")]),
  SessionPermissions(sessionID: "rt-other", yolo: false, grants: [])
]

@MainActor
private func model(
  _ backend: StubPermissions, decisions: DecisionRecorder = .discarding(), chat: Set<String> = ["rt-chat"]
) -> PermissionsModel {
  PermissionsModel(bot: bot, backend: backend, decisions: decisions, chatSessionIDs: { chat })
}

@Suite("The permissions model") @MainActor struct PermissionsModelTests {
  private func stub(_ snapshot: PermissionsSnapshot = PermissionsSnapshot(mode: .smart, permanent: standing, sessions: live))
    -> StubPermissions
  {
    let stub = StubPermissions()
    stub.set(snapshot)
    return stub
  }

  // MARK: Listing

  @Test func loadListsTheModeTheStandingGrantsAndTheSessionsForTheBot() async {
    let backend = stub()
    let model = model(backend)

    #expect(model.phase == .idle)
    #expect(model.count == nil)

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.mode == .smart)
    #expect(model.permanent == standing)
    #expect(model.sessions == live)
    #expect(model.count == 3)
    #expect(backend.readProfiles == [bot], "the bot's own profile")
  }

  @Test func theBotsOwnChatIsToldFromAnotherSessionByEitherOfItsIds() async {
    let byRuntime = model(stub())
    await byRuntime.load()

    #expect(byRuntime.isChat(live[0]))
    #expect(!byRuntime.isChat(live[1]))

    let keyed = PermissionsSnapshot(
      sessions: [
        SessionPermissions(sessionID: "rt-a", sessionKey: "stored-chat", yolo: false, grants: []),
        SessionPermissions(sessionID: "rt-b", sessionKey: "stored-other", yolo: false, grants: [])
      ])
    let byStored = model(stub(keyed), chat: ["stored-chat"])
    await byStored.load()

    #expect(byStored.isChat(keyed.sessions[0]))
    #expect(!byStored.isChat(keyed.sessions[1]))
    #expect(!model(stub(keyed), chat: []).isChat(keyed.sessions[0]), "no chat known, no chat told")
  }

  @Test func aFailedFirstReadIsAFailureAndALaterOneKeepsWhatWasRead() async {
    let backend = stub()
    let model = model(backend)

    backend.failRead(refusal("an agent may not read", code: 4033))
    await model.load()
    #expect(model.phase == .failed(.refused))

    backend.failRead(nil)
    await model.load()
    #expect(model.phase == .loaded)

    backend.failRead(GatewayRPCError(.notConnected, "gateway not connected"))
    await model.load()
    #expect(model.phase == .loaded, "a failed refresh keeps the list")
    #expect(model.permanent == standing)
  }

  @Test func eachFailureOfTheFirstReadIsSorted() async {
    let cases: [(any Error, PermissionFailure)] = [
      (refusal("Profile 'x' does not exist.", code: 4064), .unknownProfile),
      (refusal("unknown method", code: -32601), .unsupported),
      (GatewayRPCError(.timeout, "timed out"), .timedOut),
      (GatewayRPCError(.notConnected, "not connected"), .offline)
    ]

    for (error, failure) in cases {
      let backend = stub()
      backend.failRead(error)
      let model = model(backend)

      await model.load()

      #expect(model.phase == .failed(failure))
    }
  }

  @Test func refreshReadsAgainAndShowsWhatChanged() async {
    let backend = stub()
    let model = model(backend)

    await model.load()
    backend.set(PermissionsSnapshot(mode: .off, permanent: [grant("perm:9", "new")], sessions: []))
    await model.load()

    #expect(backend.reads == 2)
    #expect(model.mode == .off)
    #expect(model.permanent.map(\.id) == ["perm:9"])
    #expect(model.sessions.isEmpty)
  }

  @Test func emptyListsAreEmpty() async {
    let model = model(stub(PermissionsSnapshot()))

    await model.load()

    #expect(model.phase == .loaded)
    #expect(model.permanent.isEmpty)
    #expect(model.sessions.isEmpty)
    #expect(model.count == 0)
  }

  // MARK: Confirmation

  @Test func askingSendsNothingAndCancellingDropsTheQuestion() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let question = PermissionRevocation(scope: .permanent, grant: standing[0])
    model.ask(question)

    #expect(model.pending == question)
    #expect(backend.revokes.isEmpty, "a question is not a revoke")

    model.cancel()

    #expect(model.pending == nil)
    #expect(backend.revokes.isEmpty)
    #expect(model.permanent == standing)
  }

  @Test func onlyAYesRevokesAndAnswersTheQuestion() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let question = PermissionRevocation(scope: .permanent, grant: standing[0])
    model.ask(question)
    let done = await model.confirm(question)

    #expect(done)
    #expect(model.pending == nil)
    #expect(backend.revokes == [.init(profile: bot, scope: .permanent, target: .one("perm:1"))])
  }

  // MARK: Revoking

  @Test func revokingOneStandingGrantTakesItAwayAndReadsAgain() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let done = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))

    #expect(done)
    #expect(model.permanent == [standing[1]])
    #expect(backend.reads == 2, "the list is read again after the revoke")
    #expect(model.actionFailure == nil)
    #expect(model.revoking.isEmpty)
  }

  @Test func revokeAllTakesEveryStandingGrantButNoSessionGrant() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let done = await model.confirm(PermissionRevocation(scope: .permanent, grant: nil))

    #expect(done)
    #expect(backend.revokes == [.init(profile: bot, scope: .permanent, target: .all)])
    #expect(model.permanent.isEmpty)
    #expect(model.sessions == live)
  }

  @Test func aSessionRevokeNamesTheSessionAndLeavesTheOthers() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let one = await model.confirm(
      PermissionRevocation(scope: .session("rt-chat"), grant: live[0].grants[0]))

    #expect(one)
    #expect(
      backend.revokes == [.init(profile: bot, scope: .session("rt-chat"), target: .one("sess:1"))])
    #expect(model.sessions.first?.grants.isEmpty == true)
    #expect(model.sessions.first?.yolo == true, "YOLO is not revoked here")
    #expect(model.permanent == standing)
  }

  @Test func revokeAllOfASessionTakesThatSessionsGrants() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    let done = await model.confirm(PermissionRevocation(scope: .session("rt-chat"), grant: nil))

    #expect(done)
    #expect(backend.revokes == [.init(profile: bot, scope: .session("rt-chat"), target: .all)])
    #expect(model.sessions.map(\.grants.count) == [0, 0])
  }

  @Test func anIdThatWasAlreadyGoneRevokesNothingButTheListIsStillRead() async {
    let backend = stub()
    let model = model(backend)
    await model.load()
    backend.set(PermissionsSnapshot(mode: .smart, permanent: [standing[1]], sessions: []))

    let done = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))

    #expect(!done, "nothing was removed")
    #expect(model.actionFailure == nil, "not an error")
    #expect(model.permanent == [standing[1]])
    #expect(backend.reads == 2)
  }

  @Test func eachRefusalIsKeptAndTheListIsReadAgain() async {
    let cases: [(any Error, PermissionFailure)] = [
      (refusal("an agent may not revoke", code: 4033), .refused),
      (refusal("Profile 'x' does not exist.", code: 4064), .unknownProfile),
      (refusal("session not found", code: 4001), .sessionGone),
      (refusal("send exactly one of id or all", code: 4006), .failed("send exactly one of id or all")),
      (GatewayRPCError(.notConnected, "not connected"), .offline),
      (GatewayRPCError(.timeout, "timed out"), .timedOut)
    ]

    for (error, failure) in cases {
      let backend = stub()
      let model = model(backend)
      await model.load()
      backend.failRevoke(error)

      let done = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))

      #expect(!done)
      #expect(model.actionFailure == failure)
      #expect(model.permanent == standing, "nothing was taken off the page")
      #expect(backend.reads == 2, "the list is read again")
      #expect(model.revoking.isEmpty)

      model.dismissActionFailure()

      #expect(model.actionFailure == nil)
    }
  }

  @Test func aNewRevokeClearsTheLastFailure() async {
    let backend = stub()
    let model = model(backend)
    await model.load()

    backend.failRevoke(refusal("no", code: 4033))
    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))
    #expect(model.actionFailure == .refused)

    backend.failRevoke(nil)
    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))

    #expect(model.actionFailure == nil)
  }

  // MARK: The decision log

  @Test func aRevokeIsWrittenToTheDecisionLogWithTheLabel() async throws {
    let log = try DecisionFixture.log()
    let recorder = DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home")
    let backend = stub()
    let model = model(backend, decisions: recorder)
    await model.load()

    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))

    let entries = await log.entries()
    let entry = try #require(entries.first)

    #expect(entries.count == 1)
    #expect(entry.kind == .permissionRevoked)
    #expect(entry.outcome == .revoked)
    #expect(entry.method == .tap)
    #expect(entry.bot == bot)
    #expect(entry.session == "")
    #expect(entry.gatewayID == "g1")
    #expect(entry.summary == "recursive delete; force delete")
  }

  @Test func aSessionRevokeIsLoggedWithItsSession() async throws {
    let log = try DecisionFixture.log()
    let model = model(stub(), decisions: DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home"))
    await model.load()

    _ = await model.confirm(PermissionRevocation(scope: .session("rt-chat"), grant: live[0].grants[0]))

    let entry = try #require(await log.entries().first)

    #expect(entry.session == "rt-chat")
    #expect(entry.summary == "script execution via heredoc")
  }

  @Test func revokeAllIsLoggedOnceWithTheLabelsItTook() async throws {
    let log = try DecisionFixture.log()
    let model = model(stub(), decisions: DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home"))
    await model.load()

    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: nil))

    let entries = await log.entries()

    #expect(entries.count == 1)
    #expect(entries.first?.summary == "recursive delete; force delete; podman *")
  }

  @Test func theLoggedLabelIsCutAt120Characters() async throws {
    let log = try DecisionFixture.log()
    let long = String(repeating: "x", count: 400)
    let backend = stub(PermissionsSnapshot(permanent: [grant("perm:1", long)]))
    let model = model(backend, decisions: DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home"))
    await model.load()

    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: grant("perm:1", long)))

    let summary = try #require(await log.entries().first?.summary)

    #expect(summary.count == DecisionSummary.limit, "120 characters in all, the ellipsis included")
    #expect(summary.hasPrefix("xxxx") && summary.hasSuffix("…"))
  }

  @Test func aRevokeThatRemovedNothingOrFailedLeavesNoEntry() async throws {
    let log = try DecisionFixture.log()
    let recorder = DecisionRecorder(log: log, gatewayID: "g1", gatewayName: "Home")
    let backend = stub()
    let model = model(backend, decisions: recorder)
    await model.load()

    backend.answer(revoked: 0)
    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[0]))
    backend.answer(revoked: nil)
    backend.failRevoke(refusal("no", code: 4033))
    _ = await model.confirm(PermissionRevocation(scope: .permanent, grant: standing[1]))

    #expect(await log.count() == 0)
  }

  @Test func theLogCarriesTheKindAndOutcomeInItsExport() async throws {
    let log = try DecisionFixture.log()
    await log.record(
      DecisionFixture.entry("a", kind: .permissionRevoked, outcome: .revoked, summary: "podman *"))

    let csv = String(decoding: DecisionExport.data(await log.entries(), as: .csv), as: UTF8.self)

    #expect(csv.contains(",permissionRevoked,revoked,tap,podman *"))
  }
}
