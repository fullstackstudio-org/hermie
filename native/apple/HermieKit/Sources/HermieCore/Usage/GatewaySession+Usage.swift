import Foundation
import HermieTranscript

extension GatewaySession {
  /// The gateway calls behind the usage screens, over this session's link.
  public var usageService: UsageService {
    UsageService(link: link)
  }

  /// The model behind one bot's Usage section. A screen builds one per time it is opened.
  public func usage(for bot: String) -> BotUsageModel {
    let store = self.store

    return BotUsageModel(
      bot: bot,
      backend: usageService,
      runtimeID: { await store.sessionIDs()[bot]?.runtime },
      contextMeter: { await store.contextUsage(bot) }
    )
  }

  /// The model behind the usage overview across this gateway's bots, in the roster's order.
  public func usageOverview() -> UsageOverviewModel {
    let store = self.store

    return UsageOverviewModel(
      backend: usageService,
      bots: { [weak self] in self?.chatList.names ?? [] },
      contexts: { await store.contextUsages() }
    )
  }
}

extension TranscriptStore {
  /// How full a bot's context window is, as its chat last heard (`session.usage` ticks, the end of a
  /// turn, a resume). Nil where the chat is not loaded or the gateway never said how big the window is.
  func contextUsage(_ bot: String) -> ContextUsage? {
    chats[bot].flatMap { contextUsageOf($0.state.usage) }
  }

  /// Every loaded chat's context meter.
  func contextUsages() -> [String: ContextUsage] {
    var meters: [String: ContextUsage] = [:]

    for (bot, record) in chats {
      if let meter = contextUsageOf(record.state.usage) {
        meters[bot] = meter
      }
    }

    return meters
  }
}
