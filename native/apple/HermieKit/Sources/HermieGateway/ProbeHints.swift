/// What a failed probe means besides its kind, and what can be offered about
/// it (the port of `probe-hints.ts`). The app owns the sentences; this owns
/// which sentence and which buttons. Nothing here resolves a name.
public enum NetworkKind: String, Sendable, Equatable, CaseIterable {
  case wifi
  case cellular
  case other
  /// No information; never read as "not cellular".
  case unknown
}

/// The extra sentence, by code.
public enum ProbeHintCode: String, Sendable, Equatable {
  /// The address is one only a particular network can reach, and this device does not look like it is on it.
  case privateNetwork = "private_network"
  case none
}

/// Something the reader can press. Offered, never performed.
public enum ProbeAction: Sendable, Equatable {
  /// A redirect landed on this host. Point the wizard at it.
  case useHost(String)
  /// An access proxy answered before the gateway did. Open the front-door preset.
  case frontDoor
}

public struct ProbeVerdict: Sendable, Equatable {
  public var hint: ProbeHintCode
  /// The answer looked like a web page where JSON was expected. A different
  /// fact from the hint: WHAT came back, as against WHERE the address points.
  public var landingPage: Bool
  public var actions: [ProbeAction]

  public init(hint: ProbeHintCode = .none, landingPage: Bool = false, actions: [ProbeAction] = []) {
    self.hint = hint
    self.landingPage = landingPage
    self.actions = actions
  }

  /// Loopback is excluded: the device IS that network, so "check you are connected to it" helps nobody.
  private static let reachableOnOneNetwork: Set<HostPrivacy> = [.private, .cgnat, .tailnet, .localName, .linkLocal]

  private static func onlyOnOneNetwork(_ address: String) -> Bool {
    reachableOnOneNetwork.contains(HostClassification.of(address).privacy)
  }

  /// Read a failed probe. Anything that is not a `GatewayError` earns nothing.
  ///
  /// `private_network` has two triggers, both facts rather than guesses: a web
  /// page came back from a host only one network can reach, or nothing
  /// answered and the device says it is on cellular.
  public static func classify(_ error: (any Error)?, address: String, network: NetworkKind = .unknown) -> ProbeVerdict {
    let empty = ProbeVerdict()

    guard let error = error as? GatewayError else {
      return empty
    }

    switch error.kind {
    case .redirect:
      // Where the answer came from decides what all of it means.
      guard let host = error.redirectedTo, !host.isEmpty else {
        return empty
      }

      return ProbeVerdict(actions: [.useHost(host)])
    case .auth where error.status == 401 || error.status == 403:
      return ProbeVerdict(actions: [.frontDoor])
    case .notHermes:
      let landingPage = error.sawLandingPage == true
      return ProbeVerdict(
        hint: landingPage && onlyOnOneNetwork(address) ? .privateNetwork : .none,
        landingPage: landingPage
      )
    case .network where network == .cellular && onlyOnOneNetwork(address):
      return ProbeVerdict(hint: .privateNetwork)
    default:
      return empty
    }
  }
}
