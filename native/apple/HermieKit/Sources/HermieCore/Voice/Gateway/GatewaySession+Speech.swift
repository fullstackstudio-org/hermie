import Foundation

extension GatewaySession {
  /// This gateway's text-to-speech as `profile` (a bot's handle; nil is the gateway's default) sees it,
  /// or nil for a connection with no REST side. The same object for the same profile.
  public func speechAccess(profile: String?) -> GatewaySpeechAccess? {
    let key = profile ?? ""

    if let known = speechAccesses[key] {
      return known
    }

    guard let transport = link.speech else {
      return nil
    }

    let access = GatewaySpeechAccess(transport: transport, profile: profile)
    speechAccesses[key] = access
    return access
  }
}
