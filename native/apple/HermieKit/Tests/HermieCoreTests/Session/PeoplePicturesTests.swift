import Foundation
import HermieGateway
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// A fetch the test drives: what it answers by path, what it was asked, and an optional gate that
/// holds every answer until the test lets it go.
private final class Gateway: Sendable {
  private struct State {
    var answer: @Sendable (String) -> PictureFetchOutcome = { _ in .missing }
    var calls: [String] = []
    var held: [CheckedContinuation<Void, Never>] = []
    var holding = false
  }

  private let state = Mutex(State())

  var calls: [String] { state.withLock { $0.calls } }
  /// How many answers are being held.
  var heldCount: Int { state.withLock { $0.held.count } }

  func answer(_ answer: @escaping @Sendable (String) -> PictureFetchOutcome) {
    state.withLock { $0.answer = answer }
  }

  func hold() {
    state.withLock { $0.holding = true }
  }

  func release() {
    let waiting = state.withLock { state in
      state.holding = false
      defer { state.held = [] }
      return state.held
    }

    for continuation in waiting {
      continuation.resume()
    }
  }

  func fetch(_ path: String) async -> PictureFetchOutcome {
    let holding = state.withLock { state in
      state.calls.append(path)
      return state.holding
    }

    if holding {
      await withCheckedContinuation { continuation in
        state.withLock { $0.held.append(continuation) }
      }
    }

    return state.withLock { $0.answer(path) }
  }
}

private let ready = PictureFetchOutcome.ready(dataURI: "data:image/png;base64,AAAA")

/// The people's pictures: one request per person, a refusal remembered for a while, the stored copy
/// that paints at once, and a sign-out that leaves nothing behind.
@Suite(.timeLimit(.minutes(1))) @MainActor struct PeoplePicturesTests {
  private func makeCache(
    _ gateway: Gateway,
    clock: ManualClock = ManualClock(),
    keyValues: KeyValueStore? = nil
  ) -> PeoplePictures {
    PeoplePictures(gatewayID: "g1", keyValues: keyValues, clock: clock) { path in await gateway.fetch(path) }
  }

  @Test func fetchesThroughThePictureRouteAndKeepsTheDataURIUnderTheID() async {
    let gateway = Gateway()
    gateway.answer { _ in ready }
    let people = makeCache(gateway)

    await people.load("authentik:robin")

    #expect(gateway.calls == ["/api/auth/picture?id=authentik%3Arobin"])
    #expect(people.slot(for: "authentik:robin").dataURI == "data:image/png;base64,AAAA")
    #expect(people.slot(for: "authentik:dana").dataURI == nil)
  }

  @Test func asksOncePerPersonHoweverManyRowsNameThem() async {
    let gateway = Gateway()
    gateway.answer { _ in ready }
    gateway.hold()
    let people = makeCache(gateway)

    // Three rows ask while the first answer is still on its way.
    async let first: Void = people.load("authentik:robin")
    async let second: Void = people.load("authentik:robin")
    async let third: Void = people.load("authentik:robin")
    await waitUntil("the first answer to be on its way") { gateway.heldCount == 1 }
    gateway.release()
    _ = await (first, second, third)

    // And again after it is held.
    await people.load("authentik:robin")

    #expect(gateway.calls.count == 1)
  }

  @Test func usesThePathTheGatewayNamedOnlyWhenItIsThePictureRoute() async {
    let gateway = Gateway()
    gateway.answer { _ in ready }
    let people = makeCache(gateway)

    await people.load("self-hosted:sam", path: "/api/auth/picture?id=self-hosted%3Asam")
    await people.load("self-hosted:lee", path: "/somewhere/else?id=self-hosted%3Alee")
    await people.load("self-hosted:kim", path: "https://idp.example/photo.png")

    #expect(
      gateway.calls == [
        "/api/auth/picture?id=self-hosted%3Asam",
        "/api/auth/picture?id=self-hosted%3Alee",
        "/api/auth/picture?id=self-hosted%3Akim",
      ])
  }

  @Test func aPersonWithNoPictureStaysAnInitialAndIsNotAskedAgainForAWhile() async {
    let gateway = Gateway()
    let clock = ManualClock()
    let people = makeCache(gateway, clock: clock)

    await people.load("authentik:nobody")
    await people.load("authentik:nobody")
    await clock.advance(by: PeoplePictures.missingRetry - .seconds(1))
    await people.load("authentik:nobody")

    #expect(people.slot(for: "authentik:nobody").dataURI == nil)
    #expect(gateway.calls.count == 1, "a 404 is remembered, not retried on every row")

    await clock.advance(by: .seconds(2))
    await people.load("authentik:nobody")

    #expect(gateway.calls.count == 2, "and tried again once the window has passed")
  }

  @Test func aFailedFetchBacksOffForShorterThanA404ThenTriesAgain() async {
    let gateway = Gateway()
    let clock = ManualClock()
    gateway.answer { _ in .error }
    let people = makeCache(gateway, clock: clock)

    await people.load("authentik:robin")
    await people.load("authentik:robin")
    #expect(gateway.calls.count == 1)

    gateway.answer { _ in ready }
    await clock.advance(by: PeoplePictures.errorRetry + .seconds(1))
    await people.load("authentik:robin")

    #expect(gateway.calls.count == 2)
    #expect(people.slot(for: "authentik:robin").dataURI != nil)
  }

  @Test func refusesAnAbsurdPictureAndAnAbsurdID() async {
    let gateway = Gateway()
    gateway.answer { _ in .ready(dataURI: String(repeating: "A", count: PeoplePictures.maxDataURILength + 1)) }
    let people = makeCache(gateway)

    await people.load("authentik:robin")
    await people.load(String(repeating: "x", count: PeoplePictures.maxIDLength + 1))
    await people.load("")

    #expect(people.slot(for: "authentik:robin").dataURI == nil)
    #expect(gateway.calls.count == 1, "only the first was asked, and the answer was not kept")
  }

  @Test func aStoredPicturePaintsBeforeTheGatewayAnswersAndAnErrorKeepsIt() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let gateway = Gateway()
    gateway.answer { _ in ready }

    let first = makeCache(gateway, keyValues: keyValues)
    await first.load("authentik:robin")

    // A new launch: the gateway is away, and the stored copy is what shows.
    let second = Gateway()
    second.answer { _ in .error }
    let relaunched = makeCache(second, keyValues: keyValues)
    await relaunched.load("authentik:robin")

    #expect(relaunched.slot(for: "authentik:robin").dataURI == "data:image/png;base64,AAAA")
    #expect(second.calls.count == 1, "asked once whether it changed")
  }

  @Test func aFourOhFourRemovesTheStoredCopy() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let gateway = Gateway()
    gateway.answer { _ in ready }
    await makeCache(gateway, keyValues: keyValues).load("authentik:robin")

    let gone = Gateway()
    let relaunched = makeCache(gone, keyValues: keyValues)
    await relaunched.load("authentik:robin")

    #expect(relaunched.slot(for: "authentik:robin").dataURI == nil)

    let third = makeCache(Gateway(), keyValues: keyValues)
    await third.load("authentik:robin")

    #expect(third.slot(for: "authentik:robin").dataURI == nil, "nothing left on disk to paint")
  }

  @Test func theStoredKeyHoldsAnAtSignInAnIDAndStaysInTheGatewaysNamespace() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let gateway = Gateway()
    gateway.answer { _ in ready }

    await makeCache(gateway, keyValues: keyValues).load("telegram:a@b")

    let keys = try await keyValues.keys().filter { $0.hasPrefix("hermie.person.") }

    #expect(keys.count == 1)
    #expect(GatewayNamespace.split(try #require(keys.first))?.id == "g1", "a purge of g1 finds it")
  }

  @Test func clearForgetsMemoryAndDiskAndDropsAnAnswerStillOnItsWay() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let gateway = Gateway()
    gateway.answer { _ in ready }
    let people = makeCache(gateway, keyValues: keyValues)

    await people.load("authentik:robin")
    await people.clear()

    #expect(people.slot(for: "authentik:robin").dataURI == nil)
    #expect(try await keyValues.keys().filter { $0.hasPrefix("hermie.person.") }.isEmpty)

    // A fetch that was on its way when the sign-out happened lands nowhere.
    gateway.hold()
    let loading = Task { await people.load("authentik:dana") }
    await waitUntil("the fetch to be on its way") { gateway.heldCount == 1 }
    await people.clear()
    gateway.release()
    await loading.value

    #expect(people.slot(for: "authentik:dana").dataURI == nil)
    #expect(try await keyValues.keys().filter { $0.hasPrefix("hermie.person.") }.isEmpty)
  }

  @Test func refreshAsksAgainWhatWasHeldAndNoteNoneDropsIt() async throws {
    let keyValues = KeyValueStore(store: try SQLiteStore(.inMemory))
    let gateway = Gateway()
    gateway.answer { _ in ready }
    let people = makeCache(gateway, keyValues: keyValues)

    await people.load("self-hosted:sam")
    await people.load("self-hosted:sam")
    #expect(gateway.calls.count == 1)

    gateway.answer { _ in .ready(dataURI: "data:image/png;base64,BBBB") }
    await people.refresh("self-hosted:sam", path: "/api/auth/picture?id=self-hosted%3Asam")

    #expect(gateway.calls.count == 2)
    #expect(people.slot(for: "self-hosted:sam").dataURI == "data:image/png;base64,BBBB")

    await people.noteNone("self-hosted:sam")

    #expect(people.slot(for: "self-hosted:sam").dataURI == nil)
    #expect(try await keyValues.keys().filter { $0.hasPrefix("hermie.person.") }.isEmpty)
  }
}
