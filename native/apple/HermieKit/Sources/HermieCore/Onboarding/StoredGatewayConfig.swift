import Foundation
import HermieGateway
import HermieStore

/**
 The non-secret half of one gateway's setup, under `hermie.gateway.config@<id>`.

 The shape of `StoredGatewayConfig` in `expo/hermie/src/gateway/config.ts`, field for field, so either
 build reads what the other wrote: `{ baseUrl, authMode, provider?, providerDisplayName?, version?,
 userDisplayName?, userEmail?, userPictureUrl? }`. Absent fields are left out of the JSON, as
 `JSON.stringify` leaves out `undefined`. The secrets are in the keychain (`GatewaySecrets`).
 */
public struct StoredGatewayConfig: Codable, Sendable, Equatable {
  public var baseUrl: String
  /// `GatewayAuthMode`'s raw value; kept as text so a mode from a newer build survives a rewrite.
  public var authMode: String
  public var provider: String?
  public var providerDisplayName: String?
  public var version: String?
  public var userDisplayName: String?
  public var userEmail: String?
  public var userPictureUrl: String?

  public init(
    baseUrl: String,
    authMode: GatewayAuthMode,
    provider: String? = nil,
    providerDisplayName: String? = nil,
    version: String? = nil,
    userDisplayName: String? = nil,
    userEmail: String? = nil,
    userPictureUrl: String? = nil
  ) {
    self.baseUrl = baseUrl
    self.authMode = authMode.rawValue
    self.provider = provider
    self.providerDisplayName = providerDisplayName
    self.version = version
    self.userDisplayName = userDisplayName
    self.userEmail = userEmail
    self.userPictureUrl = userPictureUrl
  }

  /// The mode, or nil for one this build does not know.
  public var mode: GatewayAuthMode? {
    GatewayAuthMode(rawValue: authMode)
  }

  /// The key-value key of one gateway's config.
  public static func key(gatewayId: String) -> String {
    GatewayNamespace(gatewayId).key(StoreKeys.gatewayConfig)
  }

  /// The JSON the store keeps: keys in a stable order, absent fields omitted.
  public func encoded() throws -> String {
    let encoder = JSONEncoder()

    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

    return String(decoding: try encoder.encode(self), as: UTF8.self)
  }

  /// A stored config, or nil when there is none or it is not one (an empty address included).
  public static func decode(_ text: String?) -> StoredGatewayConfig? {
    guard let text, let config = try? JSONDecoder().decode(StoredGatewayConfig.self, from: Data(text.utf8)),
      !config.baseUrl.isEmpty
    else {
      return nil
    }

    return config
  }
}
