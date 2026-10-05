import Foundation

extension GatewaySession {
  /// The reads behind the agents overview, over this session's link, store, roster and cron service (none
  /// for a link with no REST side, which then has no schedule to show).
  public var agentsService: AgentsService {
    AgentsService(link: link, store: store, roster: roster, cron: cronService)
  }

  /// The model behind the agents overview. A screen builds one per time it is opened: what it derives is a
  /// reading of the gateway, never a second copy of it.
  public func agents() -> AgentsModel {
    AgentsModel(backend: agentsService)
  }
}
