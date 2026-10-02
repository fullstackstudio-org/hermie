import CryptoKit
import Foundation

/**
 The push relay as this device sees it: where it is, what it hands out, and the few rules about
 the strings it hands out that the client checks before it stores or sends one.

 A device registers once per gateway and gets a capability (D26): a public `handle`, a `sendSecret`
 the gateway is given so it can send to this one device, and a `manageSecret` that only this device
 ever holds, which retargets or revokes the registration. The relay's code is the reference for the
 shapes (`src/server/push/{protocol,crypto,http}.ts` in the hermie.dev repository).
 */
public enum PushRelay {
  /// The relay every build talks to. A test injects a loopback origin instead; there is no setting.
  public static let defaultOrigin = "https://push.hermie.dev"

  /// The `v` of every request body.
  public static let protocolVersion = 1

  /// The relay's own log prefix length: `h_` and four characters, enough to correlate, not to send.
  public static let handlePrefixLength = 6

  /// What the relay issues: `h_` and base64url. The relay's own pattern is exactly 22 characters
  /// after the prefix; any length up to 128 is accepted here, so a longer handle in a later relay is
  /// not refused, while anything that could escape a URL path segment is.
  public static func isValidHandle(_ handle: String) -> Bool {
    guard handle.hasPrefix("h_") else {
      return false
    }

    let rest = handle.unicodeScalars.dropFirst(2)
    return (1...128).contains(rest.count) && rest.allSatisfy(isBase64URLScalar)
  }

  /// A send or manage secret: base64url, as the relay's bearer pattern reads it (1 to 200
  /// characters), and at least 16 characters, so an empty or toy value is never stored as one.
  public static func isValidSecret(_ secret: String) -> Bool {
    (16...200).contains(secret.unicodeScalars.count) && secret.unicodeScalars.allSatisfy(isBase64URLScalar)
  }

  /// The part of a handle a log line or a settings row may show.
  public static func handlePrefix(_ handle: String) -> String {
    isValidHandle(handle) ? String(handle.prefix(handlePrefixLength)) : "invalid"
  }

  /**
   The origin a client may be pointed at, normalised to `scheme://host[:port]`, or nil.

   https only, with no path, query, fragment or user info, which is the form the default has. The
   one exception is plain http to a loopback address, which is what a test's fake relay listens on;
   a device token and a bearer secret never travel in the clear to anything else.
   */
  public static func validatedOrigin(_ origin: String) -> String? {
    guard let components = URLComponents(string: origin),
      let scheme = components.scheme?.lowercased(),
      let host = components.host?.lowercased(), !host.isEmpty,
      components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil,
      components.path.isEmpty || components.path == "/"
    else {
      return nil
    }

    let loopback = host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"

    guard scheme == "https" || (scheme == "http" && loopback) else {
      return nil
    }

    let bracketed = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let port = components.port.map { ":\($0)" } ?? ""

    return "\(scheme)://\(bracketed)\(port)"
  }

  private static func isBase64URLScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "a"..."z", "A"..."Z", "0"..."9", "-", "_": true
    default: false
    }
  }
}

/// Which APNs endpoint a token belongs to. A development-signed build gets sandbox tokens; App Store,
/// TestFlight and Developer ID builds get production ones. The relay needs to know which.
public enum APNsEnvironment: String, Sendable, Hashable, Codable, CaseIterable {
  case sandbox
  case production
}

/**
 An APNs device token, as lowercase hex.

 The token is an address rather than a credential, but it is also a stable identifier for this
 device, so it is never logged or shown: the description says only that there is one, and what is
 kept on disk is `fingerprint`, which is enough to notice a change.
 */
public struct APNsDeviceToken: Sendable, Hashable {
  public let hex: String

  /// From the bytes `didRegisterForRemoteNotificationsWithDeviceToken` hands over.
  public init?(data: Data) {
    self.init(hex: data.map { String(format: "%02x", $0) }.joined())
  }

  /// From hex. Apple says not to assume a length; the relay accepts 16 to 200 bytes.
  public init?(hex: String) {
    let lower = hex.lowercased()
    let bytes = lower.utf8.count / 2

    guard lower.utf8.count % 2 == 0, (16...200).contains(bytes),
      lower.unicodeScalars.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) })
    else {
      return nil
    }

    self.hex = lower
  }

  /// SHA-256 of the hex, as hex: what a registration remembers about the token it was made with.
  public var fingerprint: String {
    SHA256.hash(data: Data(hex.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

extension APNsDeviceToken: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "APNsDeviceToken(<redacted>)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["hex": "<redacted>"]) }
}

/// What `POST /v1/registrations` answers: the capability for one gateway on this device.
public struct PushCapability: Sendable, Equatable {
  public var handle: String
  public var sendSecret: String
  public var manageSecret: String

  public init(handle: String, sendSecret: String, manageSecret: String) {
    self.handle = handle
    self.sendSecret = sendSecret
    self.manageSecret = manageSecret
  }
}

extension PushCapability: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "PushCapability(handle: \(PushRelay.handlePrefix(handle))…, sendSecret: <redacted>, manageSecret: <redacted>)"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}

/**
 Everything a gateway needs to send to this device through the relay, and nothing it must not hold:
 what the ui_meta push row (`transport: "relay"`) is written from.

 The management secret is deliberately not here. It stays in this device's keychain and is never
 sent to a gateway; only this device can retarget or revoke its registration (D26).
 */
public struct PushRelayAddress: Sendable, Equatable {
  /// The relay origin the registration was made at, which is the one this build is configured
  /// with, never one a response named.
  public var relay: String
  public var handle: String
  /// The row's `secret`.
  public var sendSecret: String
  /// The row's `platform`: `ios` or `macos`.
  public var platform: String
  /// When the registration was last made or confirmed, in Unix seconds.
  public var updatedAt: Double

  public init(relay: String, handle: String, sendSecret: String, platform: String, updatedAt: Double) {
    self.relay = relay
    self.handle = handle
    self.sendSecret = sendSecret
    self.platform = platform
    self.updatedAt = updatedAt
  }

  /// The row's `transport`.
  public var transport: String { "relay" }

  /// The four fields the ui_meta sync layer's push row is keyed on. The writer adds what is not
  /// the relay's (types, preview, platform, timestamps) and keeps the row's carried keys.
  public var pushRow: UIMetaPushRow {
    UIMetaPushRow(transport: transport, relay: relay, handle: handle, sendSecret: sendSecret)
  }

  /// The platform this build registers as.
  public static var currentPlatform: String {
    #if os(macOS)
      "macos"
    #else
      "ios"
    #endif
  }
}

extension PushRelayAddress: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "PushRelayAddress(relay: \(relay), handle: \(PushRelay.handlePrefix(handle))…, sendSecret: <redacted>, "
      + "platform: \(platform), updatedAt: \(updatedAt))"
  }

  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["description": description]) }
}
