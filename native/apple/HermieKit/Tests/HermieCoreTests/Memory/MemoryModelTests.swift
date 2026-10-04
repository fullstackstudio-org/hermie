import Foundation
import HermieGateway
import HermieProtocol
import Synchronization
import Testing

@testable import HermieCore

/// A gateway's memory as the model sees it: a listing the test sets, a log of what was asked, errors
/// a test can arm, and a read it can hold back.
final class StubMemory: MemoryBackend, Sendable {
  struct State {
    var listing = MemoryListing()
    var results: [MemoryEntry] = []
    var raw = MemoryRaw()
    var calls: [String] = []
    var failing: [String: any Error] = [:]
    var writeAnswer = MemoryWriteAnswer(success: true)
    var armed: String?
    var held: CheckedContinuation<Void, Never>?
    /// Applied to the listing when a write succeeds, so the next read shows it.
    var onWrite: (@Sendable (inout MemoryListing, MemoryOperation, MemoryTarget, String?, MemoryEntry?) -> Void)?
  }

  let state = Mutex(State())

  var calls: [String] { state.withLock { $0.calls } }

  func fail(_ method: String, _ error: any Error) {
    state.withLock { $0.failing[method] = error }
  }

  func heal(_ method: String) {
    state.withLock { $0.failing[method] = nil }
  }

  func hold(_ method: String) {
    state.withLock { $0.armed = method }
  }

  var isHolding: Bool { state.withLock { $0.held != nil } }

  func release() {
    let held = state.withLock { state -> CheckedContinuation<Void, Never>? in
      defer { state.held = nil }
      return state.held
    }

    held?.resume()
  }

  private func record(_ call: String, method: String) async throws {
    let (error, hold) = state.withLock { state -> ((any Error)?, Bool) in
      state.calls.append(call)
      let hold = state.armed == method

      if hold {
        state.armed = nil
      }

      return (state.failing[method], hold)
    }

    if hold {
      await withCheckedContinuation { continuation in
        state.withLock { $0.held = continuation }
      }
    }

    if let error {
      throw error
    }
  }

  func list(profile: String) async throws -> MemoryListing {
    let listing = state.withLock { $0.listing }
    try await record("list \(profile)", method: "list")

    return listing
  }

  func search(profile: String, query: String) async throws -> MemorySearchAnswer {
    let results = state.withLock { $0.results }
    try await record("search \(profile) \(query)", method: "search")

    return MemorySearchAnswer(query: query, results: results)
  }

  func raw(profile: String) async throws -> MemoryRaw {
    let raw = state.withLock { $0.raw }
    try await record("raw \(profile)", method: "raw")

    return raw
  }

  func write(
    profile: String, operation: MemoryOperation, target: MemoryTarget, content: String?, entry: MemoryEntry?
  ) async throws -> MemoryWriteAnswer {
    try await record("\(operation.rawValue) \(profile) \(target.rawValue)", method: "write")

    return state.withLock { state in
      if state.writeAnswer.success {
        state.onWrite?(&state.listing, operation, target, content, entry)
      }

      return state.writeAnswer
    }
  }
}

private func listing(memory: [String] = [], user: [String] = []) -> MemoryListing {
  func section(_ target: MemoryTarget, _ texts: [String]) -> MemorySection {
    MemorySection(
      target: target,
      entries: texts.enumerated().map { MemoryEntry(target: target, index: $0.offset, text: $0.element) },
      chars: texts.joined(separator: "\n§\n").count,
      limit: 2200
    )
  }

  return MemoryListing(profile: "researcher", sections: [section(.memory, memory), section(.user, user)])
}

@MainActor
private func opened(
  _ availability: MemoryAvailability = .editable, memory: [String] = ["Prefers short answers.", "Lives in Utrecht."]
) async -> (MemoryModel, StubMemory) {
  let backend = StubMemory()
  backend.state.withLock { $0.listing = listing(memory: memory) }
  let model = MemoryModel(backend: backend, profile: "researcher", availability: availability)
  await model.load()

  return (model, backend)
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct MemoryModelTests {
  // MARK: Reading

  @Test func startsLoadingAndThenHoldsTheListing() async {
    let backend = StubMemory()
    backend.state.withLock { $0.listing = listing(memory: ["a"]) }
    let model = MemoryModel(backend: backend, profile: "researcher", availability: .editable)

    #expect(model.phase == .loading)
    await model.load()

    #expect(model.phase == .ready)
    #expect(model.listing?.section(.memory)?.entries.map(\.text) == ["a"])
    #expect(backend.calls == ["list researcher"])
  }

  @Test func aMissingRouteIsAStateNotAFailure() async {
    let backend = StubMemory()
    backend.fail("list", GatewayError(.protocol, "no endpoint", status: 404))
    let model = MemoryModel(backend: backend, profile: "researcher", availability: .editable)

    await model.load()

    #expect(model.phase == .missing)
  }

  @Test func aRouteSwitchedOffForThisProfileIsAStateToo() async {
    let backend = StubMemory()
    backend.fail("list", GatewayError(.auth, "The gateway refused GET /x (HTTP 403).", status: 403))
    let model = MemoryModel(backend: backend, profile: "researcher", availability: .readOnly)

    await model.load()

    #expect(model.phase == .switchedOff)
  }

  @Test func aFailedFirstReadIsAFailureAndAFailedRefreshKeepsTheListing() async {
    let backend = StubMemory()
    backend.fail("list", GatewayError(.network, "no connection"))
    let model = MemoryModel(backend: backend, profile: "researcher", availability: .editable)

    await model.load()
    #expect(model.phase == .failed("no connection"))

    backend.heal("list")
    backend.state.withLock { $0.listing = listing(memory: ["a"]) }
    await model.load()
    #expect(model.phase == .ready)

    backend.fail("list", GatewayError(.network, "no connection"))
    await model.load()

    #expect(model.phase == .ready, "a list already on screen is not blanked by a failed refresh")
    #expect(model.listing?.section(.memory)?.entries.count == 1)
    #expect(model.notice == .words("no connection"))
  }

  @Test func aReadThatANewerOneOvertookIsDropped() async {
    let backend = StubMemory()
    backend.state.withLock { $0.listing = listing(memory: ["old"]) }
    let model = MemoryModel(backend: backend, profile: "researcher", availability: .editable)
    backend.hold("list")

    let first = Task { await model.load() }
    await eventually { backend.isHolding }

    backend.state.withLock { $0.listing = listing(memory: ["new"]) }
    await model.load()
    backend.release()
    await first.value

    #expect(model.listing?.section(.memory)?.entries.map(\.text) == ["new"])
  }

  // MARK: Search

  @Test func anEmptyQueryIsNotSentAndClearsTheResults() async {
    let (model, backend) = await opened()
    backend.state.withLock { $0.results = [MemoryEntry(target: .memory, index: 1, text: "Lives in Utrecht.")] }

    await model.search("utrecht")
    #expect(model.search == .results(MemorySearchAnswer(query: "utrecht", results: backend.state.withLock { $0.results })))
    #expect(model.isSearching)

    await model.search("   ")

    #expect(model.search == .idle)
    #expect(!model.isSearching)
    #expect(backend.calls.filter { $0.hasPrefix("search") } == ["search researcher utrecht"])
  }

  @Test func aSearchThatFailsSaysSoAndTheNextOneRecovers() async {
    let (model, backend) = await opened()
    backend.fail("search", GatewayError(.server, "HTTP 500", status: 500))

    await model.search("x")
    #expect(model.search == .failed("HTTP 500"))

    backend.heal("search")
    await model.search("x")

    if case .results = model.search {
    } else {
      Issue.record("expected results, got \(model.search)")
    }
  }

  @Test func aSearchThatANewerOneOvertookIsDropped() async {
    let (model, backend) = await opened()
    backend.hold("search")
    backend.state.withLock { $0.results = [MemoryEntry(target: .memory, index: 0, text: "stale")] }

    let first = Task { await model.search("old") }
    await eventually { backend.isHolding }

    backend.state.withLock { $0.results = [MemoryEntry(target: .memory, index: 0, text: "fresh")] }
    await model.search("new")
    backend.release()
    await first.value

    #expect(model.query == "new")
    #expect(model.search == .results(MemorySearchAnswer(query: "new", results: [MemoryEntry(target: .memory, index: 0, text: "fresh")])))
  }

  // MARK: Raw

  @Test func theRawSideIsReadOnDemandAndAGatewayWithoutItIsAState() async {
    let (model, backend) = await opened()

    #expect(model.raw == .idle)

    backend.fail("raw", GatewayError(.protocol, "no endpoint", status: 404))
    await model.loadRaw()
    #expect(model.raw == .missing)

    backend.heal("raw")
    backend.state.withLock { $0.raw = MemoryRaw(profile: "researcher") }
    await model.loadRaw()
    #expect(model.raw == .loaded(MemoryRaw(profile: "researcher")))
  }

  // MARK: Writing

  @Test func addingAnEntryWritesItAndReadsTheListingAgain() async {
    let (model, backend) = await opened()
    backend.state.withLock {
      $0.onWrite = { listing, _, _, content, _ in
        listing = MemoryListing(
          profile: "researcher",
          sections: [
            MemorySection(
              target: .memory,
              entries: [MemoryEntry(target: .memory, index: 0, text: content ?? "")], chars: 5, limit: 2200),
            MemorySection(target: .user)
          ])
      }
    }

    let done = await model.add(.memory, content: "  Likes tea.  ")

    #expect(done)
    #expect(backend.calls.suffix(2) == ["add researcher memory", "list researcher"])
    #expect(model.listing?.section(.memory)?.entries.map(\.text) == ["Likes tea."])
    #expect(model.notice == nil)
  }

  @Test func aBlankEntryIsNotSent() async {
    let (model, backend) = await opened()

    #expect(await model.add(.user, content: "  \n ") == false)
    #expect(backend.calls == ["list researcher"])
  }

  @Test func aReplaceNamesTheEntryByItsTextAndAnUnchangedTextIsNotSent() async {
    let (model, backend) = await opened()
    let entry = MemoryEntry(target: .memory, index: 1, text: "Lives in Utrecht.")

    #expect(await model.replace(entry, with: "Lives in Utrecht.") == false)
    #expect(await model.replace(entry, with: "Lives in Delft.") == true)

    #expect(backend.calls.contains("replace researcher memory"))
  }

  @Test func aRemoveIsAWriteToo() async {
    let (model, backend) = await opened()

    #expect(await model.remove(MemoryEntry(target: .memory, index: 0, text: "Prefers short answers.")))
    #expect(backend.calls.contains("remove researcher memory"))
  }

  @Test func aReadOnlyGatewayNeverWrites() async {
    let (model, backend) = await opened(.readOnly)

    #expect(model.canWrite == false)
    #expect(await model.add(.memory, content: "x") == false)
    #expect(await model.remove(MemoryEntry(target: .memory, index: 0, text: "a")) == false)
    #expect(backend.calls == ["list researcher"])
  }

  @Test func aRefusalIsShownInTheStoresWordsAndTheListingIsReadAnyway() async {
    let (model, backend) = await opened()
    backend.state.withLock {
      $0.writeAnswer = MemoryWriteAnswer(
        success: false, error: "that would exceed the character limit for this file", currentEntries: ["a"])
    }

    let done = await model.add(.memory, content: "too much")

    #expect(done == false)
    #expect(model.notice == .words("that would exceed the character limit for this file"))
    #expect(backend.calls.last == "list researcher", "a stale index means what is on screen is stale")

    model.dismissNotice()
    #expect(model.notice == nil)
  }

  @Test func aRefusalWithNoWordsHasSomeAnyway() async {
    let (model, backend) = await opened()
    backend.state.withLock { $0.writeAnswer = MemoryWriteAnswer(success: false) }

    #expect(await model.add(.memory, content: "x") == false)
    #expect(model.notice != nil)
  }

  @Test func aWriteThatThrowsIsReportedAndLeavesTheListingAlone() async {
    let (model, backend) = await opened()
    backend.fail("write", GatewayError(.server, "HTTP 502", status: 502))

    #expect(await model.add(.memory, content: "x") == false)
    #expect(model.notice == .words("HTTP 502"))
    #expect(backend.calls.filter { $0.hasPrefix("list") }.count == 1)
  }

  @Test func aWriteTheGatewayRefusesWith403SaysEditingIsSwitchedOff() async {
    let (model, backend) = await opened()
    backend.fail("write", GatewayError(.auth, "The gateway refused POST /x (HTTP 403).", status: 403))

    #expect(await model.add(.memory, content: "x") == false)
    #expect(model.notice == .editSwitchedOff)
  }

  @Test func oneWriteRunsAtATime() async {
    let (model, backend) = await opened()
    backend.hold("write")

    let first = Task { await model.add(.memory, content: "one") }
    await eventually { backend.isHolding }

    #expect(model.busy)
    #expect(await model.add(.memory, content: "two") == false, "a second write while one runs is not started")

    backend.release()
    #expect(await first.value)
    #expect(!model.busy)
    #expect(backend.calls.filter { $0.hasPrefix("add") }.count == 1)
  }

  @Test func aWriteWhileSearchingReadsTheSearchAgainToo() async {
    let (model, backend) = await opened()
    await model.search("utrecht")

    #expect(await model.add(.memory, content: "x"))
    #expect(backend.calls.filter { $0.hasPrefix("search") }.count == 2)
  }

  @Test func theAvailabilityCanMoveWhenTheRosterIsReadAgain() async {
    let (model, _) = await opened(.unknown)

    #expect(model.canWrite == false)
    model.setAvailability(.editable)
    #expect(model.canWrite)
  }
}
