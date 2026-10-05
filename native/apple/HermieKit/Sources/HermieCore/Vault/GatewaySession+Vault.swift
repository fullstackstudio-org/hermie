import Foundation

extension GatewaySession {
  /// The model behind one bot's Vault page: that bot's own vault on this gateway, over this session's link.
  /// A page builds one each time it is opened.
  public func vault(for bot: String) -> VaultModel {
    VaultModel(
      bot: bot, backend: VaultService(link: link), countKey: VaultCounts.key(gateway: gatewayID, bot: bot))
  }
}
