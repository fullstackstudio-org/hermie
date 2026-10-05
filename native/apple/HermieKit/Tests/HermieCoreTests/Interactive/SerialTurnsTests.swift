import Foundation
import Testing

@testable import HermieCore

/// A section that stays open until the test lets it go, so the callers can be seen to queue.
@MainActor
private final class Section {
  private(set) var running = 0
  private(set) var mostAtOnce = 0
  private(set) var started: [Int] = []
  private var open: [Int: CheckedContinuation<Void, Never>] = [:]

  func enter(_ number: Int) async -> Int {
    running += 1
    mostAtOnce = max(mostAtOnce, running)
    started.append(number)

    await withCheckedContinuation { open[number] = $0 }

    running -= 1
    return number
  }

  func finish(_ number: Int) {
    open.removeValue(forKey: number)?.resume()
  }
}

@Suite("Serial turns: one location request at a time, none lost", .timeLimit(.minutes(1))) @MainActor
struct SerialTurnsTests {
  private func eventually(_ what: String, _ condition: @MainActor () -> Bool) async throws {
    await waitUntil(what) { condition() }
  }

  @Test("two callers at once never overlap, and both are answered, the second when the first is done")
  func twoAtOnce() async throws {
    let turns = SerialTurns()
    let section = Section()

    let first = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(1) } }
    let second = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(2) } }

    try await eventually("the first to be in") { section.started == [1] }
    try await eventually("the second to wait") { turns.waiting == 1 }
    #expect(section.running == 1, "the second does not start while the first is in flight")

    section.finish(1)
    try await eventually("the second to be in") { section.started == [1, 2] }
    section.finish(2)

    #expect(await first.value == 1)
    #expect(await second.value == 2, "a continuation is never dropped: the second caller got its answer")
    #expect(section.mostAtOnce == 1 && turns.waiting == 0)
  }

  @Test("many callers all come back, in the order they asked")
  func manyInOrder() async throws {
    let turns = SerialTurns()
    let section = Section()

    var tasks: [Task<Int, Never>] = []
    for number in 1...6 {
      tasks.append(Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(number) } })
      try await eventually("caller \(number) to be in line") { section.started.count + turns.waiting == number }
    }

    for number in 1...6 {
      try await eventually("caller \(number) to be in") { section.started.last == number }
      section.finish(number)
    }

    var results: [Int] = []
    for task in tasks {
      results.append(await task.value)
    }

    #expect(results == [1, 2, 3, 4, 5, 6] && section.started == [1, 2, 3, 4, 5, 6] && section.mostAtOnce == 1)
  }

  @Test("a waiter that is cancelled leaves the line without running, and the one behind it still gets its turn")
  func cancelledWaiter() async throws {
    let turns = SerialTurns()
    let section = Section()

    let first = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(1) } }
    try await eventually("the first to be in") { section.started == [1] }
    let second = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(2) } }
    try await eventually("the second to wait") { turns.waiting == 1 }
    let third = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(3) } }
    try await eventually("the third to wait") { turns.waiting == 2 }

    second.cancel()
    #expect(await second.value == -1, "cancelled while waiting: it never ran")
    #expect(turns.waiting == 1)

    section.finish(1)
    try await eventually("the third to be in") { section.started == [1, 3] }
    section.finish(3)
    let results = [await first.value, await third.value]
    #expect(results == [1, 3])
    #expect(!section.started.contains(2))
  }

  @Test("the turn is free again once everyone is through")
  func freeAgain() async throws {
    let turns = SerialTurns()
    let section = Section()

    let one = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(1) } }
    try await eventually("the first to be in") { section.started == [1] }
    section.finish(1)
    #expect(await one.value == 1)

    let two = Task { @MainActor in await turns.run(ifCancelled: -1) { await section.enter(2) } }
    try await eventually("a later caller to get in at once") { section.started == [1, 2] && turns.waiting == 0 }
    section.finish(2)
    #expect(await two.value == 2)
  }
}
