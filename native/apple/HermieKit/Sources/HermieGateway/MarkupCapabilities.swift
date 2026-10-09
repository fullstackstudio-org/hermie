import Foundation
import HermieProtocol

// The `markup` key of `client.capabilities`: which Hermie blocks this app draws.
//
// The app draws a `hermie-chart` and a `hermie-cards` fence and a `> [!NOTE]` callout
// (`contract/markup/`), and says so, so that the gateway tells a model it may write them: on the turns this
// connection submits, and on no others. A Telegram session, a build that never advertised this and an agent
// connection all hear nothing of them.
//
// Two rules from the gateway (`tui_gateway/client_markup.py`), both followed here:
//
// 1. The key goes in the SECOND call, and only when the first result carried the key `markup`: a gateway
//    older than the key refuses it with `4000` and the whole call, `confirm` levels included.
// 2. Every call REPLACES the advertisement at the gateway, and a call without `markup` clears it. So once the
//    gateway has shown it knows the key, every call this connection makes carries the list again: the
//    second call, the first call of a refresh (`GatewayConnection.advertisement` holds it with the other
//    keys), a withdrawal. Only a fresh socket's very first call cannot carry it, before the gateway has said
//    it knows the key; it is also the call that opens the advertisement, so there is nothing to clear.

/// What this connection announces for the Hermie blocks it draws.
public enum MarkupAdvertisement {
  /// The blocks this app draws, in the gateway's vocabulary. A name goes here only once a view draws it.
  public static let supported: [String] = ["chart", "cards", "alerts"]

  /// At most this many names (the contract's bound).
  public static let limit = 16
  /// At most this many characters in a name.
  public static let nameLength = 32

  /// Whether `name` is a name the gateway reads: `[a-z][a-z-]*`, at most 32 characters.
  static func isWellFormed(_ name: String) -> Bool {
    let bytes = Array(name.utf8)
    guard let first = bytes.first, bytes.count <= nameLength, (0x61...0x7A).contains(first) else { return false }
    return bytes.allSatisfy { (0x61...0x7A).contains($0) || $0 == 0x2D }
  }

  /// The `markup` list of the second call (and of every call after it): the blocks this device draws, but
  /// only when the first result carries the key. Empty for none, and nothing is announced for it. Distinct,
  /// in order, well formed and at most 16: a list the gateway would read as "none" is never sent.
  public static func names(after first: ClientCapabilitiesResult, device: [String]?) -> [String] {
    guard let device, !device.isEmpty, first.markup != nil else {
      return []
    }

    var seen = Set<String>()
    var list: [String] = []

    for name in device where isWellFormed(name) && seen.insert(name).inserted {
      list.append(name)

      if list.count == limit {
        break
      }
    }

    return list
  }
}
