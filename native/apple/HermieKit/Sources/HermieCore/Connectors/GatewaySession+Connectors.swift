import Foundation

extension GatewaySession {
  /// The model behind the Connectors page, over this session's link, about one bot's account (the
  /// gateway's own where `profile` is nil). The caller keeps it: it holds what was read.
  public func connectors(for profile: String?) -> ConnectorsModel {
    ConnectorsModel(service: ConnectorsService(gateway: .link(link)), profile: profile)
  }
}
