import Foundation
import HermieProtocol

// The `requests` key of the second `client.capabilities` call (`contract/requests/README.md` §1).
//
// The key rides on the call `confirm` already makes (`ConfirmCapabilities.swift`), so both live in
// the same two-step announcement: the first call's result decides whether the second one carries
// `requests` at all.

/// What this connection announces for the interactive server→client requests.
public enum RequestsAdvertisement {
  /// At most this many names in `requests` (the contract's bound).
  public static let limit = 32

  /// Whether `method` belongs to the interactive family a gateway lists in `server_requests`
  /// once it knows the key: `input.*`, `review.*` and `device.*`.
  public static func isInteractive(_ method: String) -> Bool {
    method.hasPrefix("input.") || method.hasPrefix("review.") || method.hasPrefix("device.")
  }

  /// The `requests` list of the second call: the methods this device can show, but only when the
  /// first result lists at least one interactive method under `server_requests`. A gateway that
  /// knows the methods knows the key; an older one refuses the unknown key with `4000` and the
  /// whole call, `confirm` levels included. Empty for none (nothing is announced for it).
  public static func methods(after first: ClientCapabilitiesResult, device: [String]?) -> [String] {
    guard let device, !device.isEmpty, first.serverRequests?.contains(where: isInteractive) == true else {
      return []
    }

    var seen = Set<String>()
    var list: [String] = []

    for method in device where seen.insert(method).inserted {
      list.append(method)

      if list.count == limit {
        break
      }
    }

    return list
  }
}
