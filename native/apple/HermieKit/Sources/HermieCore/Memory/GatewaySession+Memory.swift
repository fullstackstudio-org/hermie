import Foundation

extension GatewaySession {
  /// What the gateway's Hermie plugin lets this person do with a bot's memory, from the last roster
  /// read: unknown until the roster has been read once.
  public var memoryAvailability: MemoryAvailability {
    MemoryAvailability.of(capabilities: chatList.pluginCapabilities, refreshed: chatList.refreshed)
  }

  /// The model behind one bot's memory page; nil for a link with no REST side (a test's scripted one),
  /// which has no memory to show. The caller keeps it: it holds what was read.
  public func memory(for profile: String) -> MemoryModel? {
    (link as? any GatewayREST).map {
      MemoryModel(backend: MemoryService(rest: $0), profile: profile, availability: memoryAvailability)
    }
  }
}
