import Foundation
import HermieGateway
import HermieShared

/**
 A gateway that somebody offers to this device, as a QR code or a `hermie://add-gateway` link holds
 it (NX-14): where it is, what to call it and, as a hint, how it signs in. Nothing else.

 **An offer is not an add.** It names an address the person has not typed, so it is read as hostile
 until proven otherwise: it is shown ("Add this gateway?", the name and the host), it is added only
 when the person says so, and the person then signs in as for any gateway, so the code carries no
 credential, token or header to steal and none that could be planted. Extra parameters never get
 this far (`DeepLink` drops them).

 **The address rule is stricter than the keyboard's.** A typed address may be plain http and is then
 described and, on a public host, confirmed (ADR-0014). An address that arrives in a code is
 accepted only over `https://`, or over `http://` for a gateway on this machine or this network's
 own `.local` name, where no one else is on the path: anything else is refused here, not softened.
 The sign-in hint is only for the person to read; the gateway itself says how it signs in, and the
 setup flow asks it.
 */
public struct GatewayPairingOffer: Sendable, Hashable {
  /// Why an offer cannot be taken.
  public enum Problem: Error, Sendable, Hashable {
    /// What was scanned or opened is not a Hermie gateway code at all.
    case notAnOffer
    /// It is one, but its address is not an address this app can use.
    case notAnAddress
    /// The address is plain `http://` on a host that is not this machine or a `.local` name.
    case notSecure(host: String)
  }

  /// The address, normalised (`https://host[:port][/prefix]`): no user name, password, query or fragment.
  public let address: String
  /// The name the offering side gave the gateway, cleaned; empty when it gave none.
  public let name: String
  /// How the offering side says the gateway signs in. A hint, never acted on.
  public let authHint: GatewayAuthMode?

  public init(address: String, name: String = "", authHint: GatewayAuthMode? = nil) {
    self.address = address
    self.name = name
    self.authHint = authHint
  }

  /// The host the person is shown: what the address goes by.
  public var host: String { HostClassification.host(ofAddress: address) }

  /// The name to show: the offered one, else the host.
  public var displayName: String { name.isEmpty ? host : name }

  public var isSecure: Bool { address.lowercased().hasPrefix("https://") }

  /// Whether `other` is the same gateway address as this offer's, as setup would store it.
  public func matches(address other: String) -> Bool {
    guard let normalized = try? GatewayAddress.normalizeBaseURL(other) else {
      return false
    }

    return normalized.lowercased() == address.lowercased()
  }

  // MARK: Reading an offer

  /// An offer from an address, a name and a sign-in kind as a link spells them, or why not.
  public static func validate(address: String, name: String = "", auth: String = "") -> Result<Self, Problem> {
    guard let accepted = DeepLink.acceptedAddress(address.trimmingCharacters(in: .whitespacesAndNewlines)),
      let normalized = try? GatewayAddress.normalizeBaseURL(accepted)
    else {
      return .failure(.notAnAddress)
    }

    // The normal form can only be http or https, with a host; it is that form that is judged.
    if normalized.lowercased().hasPrefix("http://") {
      let host = HostClassification.host(ofAddress: normalized)

      guard isLocal(host: host) else {
        return .failure(.notSecure(host: host))
      }
    }

    return .success(
      Self(address: normalized, name: DeepLink.cleanedName(name), authHint: GatewayAuthMode(rawValue: auth)))
  }

  /// The offer a link holds. Anything other than an add-gateway link is not one.
  public static func offer(from link: DeepLink) -> Result<Self, Problem> {
    guard case let .addGateway(url, name, auth) = link else {
      return .failure(.notAnOffer)
    }

    return validate(address: url, name: name, auth: auth)
  }

  /// The offer a scanned code's text holds: a link, and an add-gateway link at that. Anything else a
  /// QR code can say (a web address, a Wi-Fi sign-in, a chat link of this app) is not an offer.
  public static func offer(fromPayload text: String) -> Result<Self, Problem> {
    guard let link = DeepLink(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      return .failure(.notAnOffer)
    }

    return offer(from: link)
  }

  /// The first offer among what an image's codes say, or the reason the first code that tried to be
  /// one was refused; `notAnOffer` when none of them was.
  public static func offer(fromPayloads payloads: [String]) -> Result<Self, Problem> {
    var refused: Problem?

    for text in payloads {
      switch offer(fromPayload: text) {
      case .success(let offer):
        return .success(offer)
      case .failure(.notAnOffer):
        continue
      case .failure(let problem):
        refused = refused ?? problem
      }
    }

    return .failure(refused ?? .notAnOffer)
  }

  /// Whether plain http is acceptable for this host: this machine (`localhost`, `127.0.0.0/8`,
  /// `::1`) or a `.local` name.
  public static func isLocal(host: String) -> Bool {
    let lowered = host.lowercased()

    return HostClassification.of(lowered).privacy == .loopback || lowered.hasSuffix(".local")
  }

  // MARK: Making an offer

  /// An offer for a gateway this device has, to show as a code. The same rule applies as for reading
  /// one: a gateway on plain http over a public address cannot be offered, because the other side
  /// would refuse it.
  public static func sharing(address: String, name: String, authKind: String?) -> Result<Self, Problem> {
    validate(address: address, name: name, auth: authKind ?? "")
  }

  /// The link, which is also what the QR code holds. Never carries a credential: it has no field
  /// for one.
  public var link: DeepLink {
    .addGateway(url: address, name: name, auth: authHint?.rawValue ?? "")
  }

  /// The link as text, or nil when the address cannot be written into one.
  public var linkString: String? { link.string }
}
