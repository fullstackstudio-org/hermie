import Foundation

extension GatewaySession {
  /// The model behind the Skills page, over this session's link, about one bot's skills (the
  /// gateway's own where `profile` is nil). The caller keeps it: it holds what was read.
  public func skills(for profile: String?) -> SkillsModel {
    SkillsModel(service: SkillsService(gateway: .link(link)), profile: profile)
  }
}
