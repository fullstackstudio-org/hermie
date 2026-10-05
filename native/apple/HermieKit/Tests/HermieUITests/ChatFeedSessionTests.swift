import Foundation
import HermieGateway
import HermieProtocol
import HermieShared
import HermieTranscript
import Testing

@testable import HermieCore
@testable import HermieUI

/// A link that never connects: every call fails with an error that names the gateway's address,
/// as a real one does when it cannot be reached.
final class UnreachableLink: GatewayLink, Sendable {
  static let address = "https://gateway.private-host.example:8443/api/ws"
  static var error: GatewayError { GatewayError(.network, "Could not reach \(address): connection refused") }

  let events: AsyncStream<WireEvent>
  let statuses: AsyncStream<ConnectionStatus>
  private let requests: AsyncStream<InboundRequest>

  /// What the gateway's files route answers, by path: nothing, unless a test serves something.
  private let files: @Sendable (String) -> Data?

  init(files: @escaping @Sendable (String) -> Data? = { _ in nil }) {
    events = AsyncStream { _ in }
    statuses = AsyncStream { _ in }
    requests = AsyncStream { _ in }
    self.files = files
  }

  func fetchFile(_ path: String) async -> Data? { files(path) }

  var serverRequests: any AsyncSequence<InboundRequest, Never> & Sendable { requests }
  func requestReply(_ method: String, params: JSONValue) async throws -> RPCReply<JSONValue> { throw Self.error }
  func fetchMessages(_ resolvedSessionID: String, _ window: MessageWindow) async -> [HermieProtocol.TranscriptRow]? { nil }
  func seqWatermarks() async -> [String: Double] { [:] }
  func claimTurn(_ runtimeSessionID: String) async {}
  func start() async {}
  func stop() async {}
  func pause() async {}
  func resume() async {}
  func retryNow() async {}
  func setOnline(_ online: Bool) async {}
  func shutdown() async {}
}

/// Polls `condition` on the main actor until it holds, or fails after `timeout` (generous: a loaded CI runner is slow).
///
/// The limit counts only the waiting that is the test's own. The test run is one process whose suites lay windows out on
/// the main actor for seconds on a quiet machine and for far longer on a loaded runner (a CI run recorded a stall of
/// nearly forty seconds), and a test that is merely queued behind them has not hung. Time that a pause overran by is
/// given back.
@MainActor
func eventually(_ what: String, timeout: Duration = .seconds(30), _ condition: () -> Bool) async {
  let pause = Duration.milliseconds(10)
  var deadline = ContinuousClock.now + timeout

  while !condition() {
    let before = ContinuousClock.now

    guard before < deadline else {
      Issue.record("timed out waiting for \(what)")
      return
    }

    try? await Task.sleep(for: pause)

    let overrun = ContinuousClock.now - before - pause

    if overrun > .milliseconds(250) {
      deadline += overrun
    }
  }
}

/// The chat screen's feed over a real session (on a link that never connects): what the
/// diagnostics leave out, read marks under a cover, and the model going back with the last lease.
@MainActor
@Suite struct ChatFeedSessionTests {
  let session = GatewaySession(gatewayID: "gateway-under-test", link: UnreachableLink())

  private func feedOf(_ bot: String, owner: ChatFeedOwner<ChatFeed>) -> ChatFeed? {
    let session = self.session
    owner.appeared {
      let feed = ChatFeed(chat: ChatRef(gatewayId: "gateway-under-test", bot: bot), session: session) { _ in .none }
      feed.readMarkDelay = .zero
      return feed
    }
    return owner.feed
  }

  private func live(_ model: ChatModel, text: String) {
    let item = VisibleItem(
      item: .assistant(AssistantItem(base: ItemBase(id: "a1", seq: 1, ts: 1, origin: .history, version: 1), text: text, streaming: false, interim: false)),
      presentation: .full)
    model.apply(
      ChatSnapshot(
        key: model.key, items: [item], hydration: .live, busy: false, turnActive: false, activity: .idle,
        openRequests: [], queue: [], attached: true, canLoadOlder: false, revision: 1))
  }

  // MARK: Diagnostics

  @Test func theDiagnosticsNameNoDraftNoMessageAndNoErrorText() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf("writer", owner: owner))
    let draft = "my unsent draft about the quarterly numbers"
    let message = "the reply with the secret plan in it"

    feed.model.draft = draft
    live(feed.model, text: message)
    await eventually("the rows") { feed.rows.count == 1 }
    feed.recordOpenFailure(UnreachableLink.error)
    feed.model.record(UnreachableLink.error)
    ChatLifecycleLog.note("an event")

    let report = ChatDiagnostics.report(
      chat: feed.chat, session: session, screen: owner.screen, owner: owner, live: nil)

    for secret in [draft, message, UnreachableLink.address, "private-host", "connection refused", "Could not reach"] {
      #expect(!report.contains(secret), "the diagnostics hold \"\(secret)\"")
    }
    #expect(report.contains("openError=gateway.network"), "the failure by its kind")
    #expect(report.contains("lastError=gateway.network"))
    #expect(report.contains("rows=1"))
  }

  @Test func aFailedGatewayIsNamedByItsKindOnly() {
    let phase = ChatDiagnostics.phase(.failed("Could not reach \(UnreachableLink.address)"), kind: "gateway.network")
    #expect(phase == "failed(gateway.network)")
    #expect(ChatDiagnostics.phase(.failed(UnreachableLink.address), kind: nil) == "failed(unknown)")
  }

  @Test func errorCategoriesCarryNoWords() {
    let categories = [
      ChatResolver.category(UnreachableLink.error),
      ChatResolver.category(GatewayError(.server, "500 from \(UnreachableLink.address)", status: 500)),
      ChatResolver.category(GatewayRPCError(.rejected, "denied at \(UnreachableLink.address)", code: -32601)),
      ChatResolver.category(ChatResolver.ResolutionError(message: UnreachableLink.address)),
      ChatResolver.category(URLError(.cannotConnectToHost, userInfo: [NSURLErrorFailingURLErrorKey: URL(string: UnreachableLink.address) as Any]))
    ]

    #expect(categories[0] == "gateway.network")
    #expect(categories[1] == "gateway.server 500")
    #expect(categories[2] == "rpc.rejected -32601")
    #expect(categories[3] == "resolution")

    for category in categories {
      #expect(!category.contains("private-host"), "\(category)")
    }
  }

  // MARK: Read marks

  @Test func nothingIsMarkedReadWhileCoveredAndTheNewestRowIsOnceUncovered() async throws {
    let owner = ChatFeedOwner<ChatFeed>()
    let feed = try #require(feedOf("writer", owner: owner))
    feed.coverChanged(covered: true)

    live(feed.model, text: "a reply that came while a page stood over the chat")
    await eventually("the rows") { feed.rows.count == 1 && feed.hydration == .live }
    try await Task.sleep(for: .milliseconds(100))
    #expect(feed.readMarks == 0, "a page or a sheet over the chat: nothing is marked read")

    feed.coverChanged(covered: false)
    await eventually("the read mark") { feed.readMarks == 1 }

    // Covered again with nothing new: nothing more to mark.
    feed.coverChanged(covered: true)
    feed.coverChanged(covered: false)
    try await Task.sleep(for: .milliseconds(100))
    #expect(feed.readMarks == 1)
  }

  @Test func theRouterCoversOnlyTheChatItShowsWithAPageOrASheetOverIt() {
    let router = AppRouter()
    let shown = ChatRef(gatewayId: "g", bot: "writer")
    let other = ChatRef(gatewayId: "g", bot: "researcher")

    router.openChat(shown)
    #expect(!router.covers(shown))

    router.push(.botProfile(shown))
    #expect(router.covers(shown), "a page pushed on the chat")
    #expect(!router.covers(other), "another window's chat")

    router.detailPath = []
    router.sheet = .settings
    #expect(router.covers(shown), "a sheet over it")

    router.sheet = nil
    #expect(!router.covers(shown))
  }

  // MARK: Leases

  @Test func theLastScreensStopGivesItsLeaseBackAndReleasesTheModel() async throws {
    var first: ChatFeedOwner<ChatFeed>? = ChatFeedOwner<ChatFeed>()
    var second: ChatFeedOwner<ChatFeed>? = ChatFeedOwner<ChatFeed>()
    _ = feedOf("writer", owner: first!)
    _ = feedOf("writer", owner: second!)
    #expect(ChatLeases.holders(session, "writer") == 2)
    #expect(session.models["writer"] != nil)

    first = nil
    await eventually("the first lease back") { ChatLeases.holders(session, "writer") == 1 }
    #expect(session.models["writer"] != nil, "the second screen still holds the model")

    second = nil
    await eventually("the last lease back") { ChatLeases.holders(session, "writer") == 0 }
    #expect(session.models["writer"] == nil, "released to the session with the last lease")
  }
}
