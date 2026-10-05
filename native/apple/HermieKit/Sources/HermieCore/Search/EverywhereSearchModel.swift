import Foundation
import HermieProtocol
import Observation

/// The numbers the all-conversations search is tuned with.
public enum EverywhereSearchTuning {
  /// How long the field stays still before a search goes out.
  public static let debounce: Duration = .milliseconds(300)
  /// How many (gateway, bot) searches are out at once, across every gateway.
  public static let concurrency = 4
  /// Conversations asked for per bot: a bot has a handful of chats that mention a word, not hundreds.
  public static let limitPerBot = 10
  /// A search nobody waits for is noise.
  public static let timeoutMs = 8_000
}

/**
 Searching every conversation of every bot on every signed-in gateway, from one field.

 It is the second search the app has. The chat list's field (`MessageSearchModel`) answers "which
 bot's chat mentions this", one hit per bot, for the gateway that is live; this answers "where did we
 talk about this", whichever bot, whichever of its conversations, whichever gateway.

 - **Two halves.** What the gateway's index finds (`GET /api/sessions/search`, one request per bot:
   the route is scoped to a profile) and what this device's own copy of a chat holds
   (`LocalChatSearch`). The local half answers first, so something is on screen while the gateways
   are asked, and it answers when they cannot. They are merged by conversation (`SearchMerge`): a
   chat found twice is one result.
 - **One failure is one missing row.** A bot whose search fails (a profile the gateway dropped, a
   timeout) costs that bot's results and nothing else; a gateway every one of whose bots failed, or
   that is signed out, is named in `unreachable` so the list can say what it did not search instead
   of letting "nothing found" be a lie.
 - **Three rules about not lying while the reader types**, as the chat list's search has them: a
   superseded query is abandoned and its requests cancelled, so a slow gateway cannot paint over a
   newer query's results; `searching` is true only for the current query; and an emptied field
   clears at once.

 Driven by one call, `run`, from a view's `.task(id:)`: cancelling the task is how a query is
 superseded, and a run whose task was cancelled publishes nothing.
 */
@MainActor
@Observable
public final class EverywhereSearchModel {
  /// The gateways to search, read when a search starts: signed-in ones, the live one among them.
  public typealias Gateways = @MainActor @Sendable () async -> [SearchGateway]

  /// The query `results` answer; empty while nothing has been found for the field's words.
  public private(set) var query = ""
  /// Newest first (`SearchMerge.order`).
  public private(set) var results: [SearchResult] = []
  /// A search for the current query is still out. `results` may already hold what this device found.
  public private(set) var searching = false
  /// The names of the gateways the search could not ask.
  public private(set) var unreachable: [String] = []
  /// Not one gateway could be asked: what is listed, if anything, is only what this device kept.
  public private(set) var failed = false

  @ObservationIgnored private let gateways: Gateways
  @ObservationIgnored private let debounce: Duration
  @ObservationIgnored private let concurrency: Int
  @ObservationIgnored private let limitPerBot: Int
  @ObservationIgnored private let timeoutMs: Int
  @ObservationIgnored private var generation = 0

  public init(
    debounce: Duration = EverywhereSearchTuning.debounce,
    concurrency: Int = EverywhereSearchTuning.concurrency,
    limitPerBot: Int = EverywhereSearchTuning.limitPerBot,
    timeoutMs: Int = EverywhereSearchTuning.timeoutMs,
    gateways: @escaping Gateways
  ) {
    self.gateways = gateways
    self.debounce = debounce
    self.concurrency = max(1, concurrency)
    self.limitPerBot = limitPerBot
    self.timeoutMs = timeoutMs
  }

  /// The words as they are searched: the field's text with the whitespace at its ends taken off.
  public nonisolated static func normalized(_ query: String) -> String {
    MessageSearchModel.normalized(query)
  }

  /// Search for `query` once the field has been still for the debounce. Returns when the answer is in,
  /// or the call was superseded (a newer `run`) or cancelled.
  public func run(query raw: String) async {
    generation += 1
    let mine = generation
    let query = Self.normalized(raw)

    guard !query.isEmpty else {
      clear()
      return
    }

    // What is held answers another query: nothing has been found for this one yet.
    if self.query != query || searching {
      reset()
    }

    if debounce > .zero {
      try? await Task.sleep(for: debounce)
    }

    guard live(mine) else {
      return
    }

    let sources = await gateways()

    guard live(mine) else {
      return
    }

    searching = true

    let local = await localResults(sources, query: query)

    guard live(mine) else {
      return
    }

    if !local.isEmpty {
      self.query = query
      results = SearchMerge.merge(server: [], local: local)
    }

    let outcomes = await fanOut(sources, query: query)

    guard generation == mine else {
      // A newer run owns the state now.
      return
    }

    guard !Task.isCancelled else {
      searching = false
      return
    }

    var server: [SearchResult] = []

    for outcome in outcomes {
      server += outcome.results
    }

    let down = Self.unreachable(sources, outcomes: outcomes)

    self.query = query
    results = SearchMerge.merge(server: server, local: local)
    unreachable = down.map(\.name)
    failed = !sources.isEmpty && down.count == sources.count
    searching = false
  }

  /// Drop everything: the field was emptied, or the screen went.
  public func clear() {
    generation += 1
    reset()
  }

  private func reset() {
    query = ""
    results = []
    searching = false
    unreachable = []
    failed = false
  }

  /// This run is still the current one and was not cancelled.
  private func live(_ mine: Int) -> Bool {
    !Task.isCancelled && generation == mine
  }

  /// The gateways that could not be asked: signed out, or every one of their bots failed.
  nonisolated static func unreachable(_ sources: [SearchGateway], outcomes: [BotOutcome]) -> [SearchGateway] {
    sources.filter { gateway in
      guard gateway.search != nil else {
        return true
      }

      let mine = outcomes.filter { $0.gatewayID == gateway.id }

      return !mine.isEmpty && mine.allSatisfy(\.failed)
    }
  }

  // MARK: The local half

  private func localResults(_ sources: [SearchGateway], query: String) async -> [SearchResult] {
    var found: [SearchResult] = []

    for gateway in sources {
      for bot in gateway.bots {
        if Task.isCancelled {
          return found
        }

        guard let messages = await gateway.cachedChat(bot.name),
          let hit = LocalChatSearch.hit(in: messages, query: query),
          let result = SearchMerge.result(of: hit, bot: bot, in: gateway)
        else {
          continue
        }

        found.append(result)
      }
    }

    return found
  }

  // MARK: The gateways' half

  struct BotOutcome: Sendable {
    var gatewayID: String
    var results: [SearchResult]
    var failed: Bool
  }

  private struct Job: Sendable {
    var gateway: SearchGateway
    var bot: SearchBot
    var search: SearchGateway.Search
  }

  /// Run every bot's search, at most `concurrency` at a time across all gateways, keeping every answer.
  private func fanOut(_ sources: [SearchGateway], query: String) async -> [BotOutcome] {
    let jobs = sources.flatMap { gateway in
      gateway.search.map { search in gateway.bots.map { Job(gateway: gateway, bot: $0, search: search) } } ?? []
    }

    guard !jobs.isEmpty else {
      return []
    }

    let limit = limitPerBot
    let timeout = timeoutMs
    let width = min(concurrency, jobs.count)

    return await withTaskGroup(of: BotOutcome.self) { group in
      var next = 0

      func addNext() {
        guard next < jobs.count else { return }

        let job = jobs[next]
        next += 1
        group.addTask {
          await Self.searchOne(job, query: query, limit: limit, timeoutMs: timeout)
        }
      }

      for _ in 0..<width {
        addNext()
      }

      var outcomes: [BotOutcome] = []

      while let outcome = await group.next() {
        outcomes.append(outcome)
        addNext()
      }

      return outcomes
    }
  }

  private nonisolated static func searchOne(_ job: Job, query: String, limit: Int, timeoutMs: Int) async -> BotOutcome {
    let id = job.gateway.id

    if Task.isCancelled {
      return BotOutcome(gatewayID: id, results: [], failed: false)
    }

    do {
      let hits = try await job.search(job.bot.name, query, limit, timeoutMs)

      return BotOutcome(
        gatewayID: id,
        results: hits.map { SearchMerge.result(of: $0, bot: job.bot, in: job.gateway) },
        failed: false)
    } catch {
      // One bot's gateway error is one missing bot, not a failed search.
      return BotOutcome(gatewayID: id, results: [], failed: !Task.isCancelled)
    }
  }
}
