import Foundation

extension GatewaySession {
  /// The model behind one bot's Permissions page: that bot's own approvals on this gateway, over this
  /// session's link, with a revoke written to this device's decision log. A page builds one each time it is
  /// opened.
  public func permissions(for bot: String) -> PermissionsModel {
    let store = self.store

    return PermissionsModel(
      bot: bot,
      backend: PermissionsService(link: link),
      decisions: decisions,
      chatSessionIDs: {
        guard let ids = await store.sessionIDs()[bot] else {
          return []
        }

        return Set([ids.runtime, ids.stored, ids.resolved].compactMap { $0 }.filter { !$0.isEmpty })
      }
    )
  }
}
