import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// One chat whose messages matched: the bot, the gateway's snippet and when the conversation last moved.
public struct MessageMatch: Sendable, Equatable, Identifiable {
  /// The bot whose chat matched. Known by construction: that profile was asked.
  public var bot: String
  public var sessionID: String
  /// The gateway's snippet, markers and all. Text, never Markdown: draw it with `MessageSnippet`.
  public var snippet: String
  /// Seconds since the epoch, when the hit carried one.
  public var at: Double?
  public var role: String?

  public var id: String { "\(bot):\(sessionID)" }

  public init(bot: String, sessionID: String, snippet: String, at: Double? = nil, role: String? = nil) {
    self.bot = bot
    self.sessionID = sessionID
    self.snippet = snippet
    self.at = at
    self.role = role
  }
}

/// The numbers the roster search is tuned with (`message-search.ts`).
public enum MessageSearchTuning {
  /// How long the field stays still before a search goes out.
  public static let debounce: Duration = .milliseconds(300)
  /// How many profiles are searched at once.
  public static let concurrency = 4
  /// Hits per profile. One conversation can only produce one, so this is a ceiling on bots.
  public static let limitPerBot = 5
  /// A shorter window than a REST call's default: a search nobody waits for is noise.
  public static let timeoutMs = 8_000
}

/// Searching what the bots have said, from the one field the chat list already has
/// (`features/search/message-search.ts` and `use-message-search.ts`).
///
/// Names are matched on this device and answer instantly (`ChatListFormat.filtered`); messages are a
/// fan-out over one gateway, so they arrive behind a debounce and below the rows they belong under.
///
/// - **One request per bot.** The route searches a single profile, so a roster search is bounded
///   (`MessageSearchTuning.concurrency`): a forty-bot gateway does not get forty requests per
///   keystroke, and one bot's failure (a 404 for a profile the gateway has dropped, a timeout) costs
///   that bot's row and nothing else.
/// - **One hit per conversation.** A bot appears at most once, with the best-ranked snippet.
/// - **A hit that is not the bot's canonical Bot Chat is dropped**: a profile holds sessions Hermie
///   does not show (a cron run, a CLI session, a branch), and opening the forever-chat on the strength
///   of a match in one of those would land the reader in a conversation without what they searched for.
///
/// Three rules, all of them about not lying to the reader while they type:
///
/// - a superseded query is ABANDONED, its requests cancelled, so a slow profile cannot paint its answer
///   over a newer query's;
/// - `searching` is true only while a search for the CURRENT query is in flight;
/// - an emptied field clears the results at once rather than after a round trip.
///
/// The model is driven by one call, `run`, from a view's `.task(id:)`: cancelling the task is how a
/// query is superseded, and a run whose task was cancelled publishes nothing.
@MainActor
@Observable
public final class MessageSearchModel {
  /// One request: a bot's name, the words, the hit ceiling, the timeout.
  public typealias Search = @Sendable (_ profile: String, _ query: String, _ limit: Int, _ timeoutMs: Int) async throws
    -> [SessionSearchHit]

  /// The query `matches` answer; empty while nothing has been answered for the field's words.
  public private(set) var query = ""
  /// Newest first (`MessageSearchModel.order`).
  public private(set) var matches: [MessageMatch] = []
  /// A search for the current query is in flight.
  public private(set) var searching = false
  /// Every bot's search failed (unreachable gateway, signed out, timed out): "nothing found" would be
  /// a lie, and the list says the search could not run instead.
  public private(set) var failed = false

  @ObservationIgnored private let search: Search
  @ObservationIgnored private let debounce: Duration
  @ObservationIgnored private let concurrency: Int
  @ObservationIgnored private let limitPerBot: Int
  @ObservationIgnored private let timeoutMs: Int
  @ObservationIgnored private var generation = 0

  public init(
    debounce: Duration = MessageSearchTuning.debounce,
    concurrency: Int = MessageSearchTuning.concurrency,
    limitPerBot: Int = MessageSearchTuning.limitPerBot,
    timeoutMs: Int = MessageSearchTuning.timeoutMs,
    search: @escaping Search
  ) {
    self.search = search
    self.debounce = debounce
    self.concurrency = max(1, concurrency)
    self.limitPerBot = limitPerBot
    self.timeoutMs = timeoutMs
  }

  /// Search every bot's chat for `query`, once the field has been still for the debounce.
  ///
  /// Returns when the answer is in, or the call was superseded (a newer `run`) or cancelled. Nothing
  /// is searched for a blank query, a connection that is not ready, or an empty roster, and any answer
  /// held for another query goes at once.
  public func run(query raw: String, bots: [Bot], ready: Bool) async {
    generation += 1
    let mine = generation
    let query = Self.normalized(raw)

    guard !query.isEmpty, ready, !bots.isEmpty else {
      clear()
      return
    }

    // What is held answers another query: nothing has been found for this one yet.
    if self.query != query || searching {
      self.query = ""
      matches = []
      failed = false
      searching = false
    }

    if debounce > .zero {
      try? await Task.sleep(for: debounce)
    }

    guard !Task.isCancelled, generation == mine else {
      return
    }

    searching = true

    let outcomes = await fanOut(query: query, bots: bots)

    guard generation == mine else {
      // A newer run owns the state now.
      return
    }

    guard !Task.isCancelled else {
      searching = false
      return
    }

    let found = outcomes.compactMap(\.match)
    self.query = query
    matches = Self.order(found)
    failed = !outcomes.isEmpty && outcomes.allSatisfy(\.failed)
    searching = false
  }

  /// The words as they are searched, and as `query` holds them once answered: the field's text with
  /// the whitespace at its ends taken off, in the reference's sense of whitespace.
  public nonisolated static func normalized(_ query: String) -> String {
    JSSpace.trim(query)
  }

  /// Drop everything: the field was emptied, or the screen went.
  public func clear() {
    generation += 1
    query = ""
    matches = []
    searching = false
    failed = false
  }

  /// Newest first, then by name, so an order never depends on which request landed first.
  public nonisolated static func order(_ matches: [MessageMatch]) -> [MessageMatch] {
    matches.sorted { lhs, rhs in
      let (a, b) = (lhs.at ?? 0, rhs.at ?? 0)

      if a != b {
        return a > b
      }

      return lhs.bot.localizedCompare(rhs.bot) == .orderedAscending
    }
  }

  /// Whether a hit is the bot's forever-chat.
  ///
  /// The roster knows that chat under two ids (the durable stored one and the compression-lineage
  /// tip), and the search answers with the tip plus the root it came from. Any of those agreeing is
  /// the same conversation; nothing else is.
  public nonisolated static func isCanonical(_ hit: SessionSearchHit, of bot: Bot) -> Bool {
    guard let canonical = bot.canonical else {
      return false
    }

    let known = [canonical.id, canonical.resolvedID].filter { !$0.isEmpty }

    return known.contains(hit.sessionID) || (hit.lineageRoot.map { known.contains($0) } ?? false)
  }

  // MARK: Fan-out

  private struct BotOutcome: Sendable {
    var match: MessageMatch?
    var failed: Bool
  }

  /// Run `search` over the bots, at most `concurrency` at a time, keeping every answer.
  private func fanOut(query: String, bots: [Bot]) async -> [BotOutcome] {
    let search = self.search
    let limit = limitPerBot
    let timeout = timeoutMs
    let width = min(concurrency, bots.count)

    return await withTaskGroup(of: BotOutcome.self) { group in
      var next = 0

      func addNext() {
        guard next < bots.count else { return }

        let bot = bots[next]
        next += 1
        group.addTask {
          await Self.searchOne(bot: bot, query: query, limit: limit, timeoutMs: timeout, search: search)
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

  private nonisolated static func searchOne(
    bot: Bot, query: String, limit: Int, timeoutMs: Int, search: Search
  ) async -> BotOutcome {
    if Task.isCancelled {
      return BotOutcome(match: nil, failed: false)
    }

    let hits: [SessionSearchHit]

    do {
      hits = try await search(bot.name, query, limit, timeoutMs)
    } catch {
      // One bot's gateway error is one missing row. A roster search that fails whole because a
      // profile was renamed under it is worse than a short list.
      return BotOutcome(match: nil, failed: !Task.isCancelled)
    }

    guard let hit = hits.first(where: { isCanonical($0, of: bot) }) else {
      return BotOutcome(match: nil, failed: false)
    }

    return BotOutcome(
      match: MessageMatch(bot: bot.name, sessionID: hit.sessionID, snippet: hit.snippet, at: hit.at, role: hit.role),
      failed: false
    )
  }
}
