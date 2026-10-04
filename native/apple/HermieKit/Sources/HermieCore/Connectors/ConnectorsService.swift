import Foundation
import HermieGateway
import HermieProtocol

/**
 Connectors: the accounts a bot's profile can sign in to (`connectors-controller.ts` in the Expo app).

 Four things about this corner of the gateway shape the whole feature, and three of them are invisible
 from the screen:

 - **A connector list is read for an owner.** Every connector call names `owner` (`{type: "account"}`
   or `{type: "session", session_id}`) and nothing else beside `profile`: the gateway's contracts are
   `extra="forbid"`, so a top-level `session_id` is refused with 4000. The Expo app read the list of a
   chat's session and so needed a chat open; the fork also answers for the profile's ACCOUNT, which is
   what this page reads: the connectors belong to the bot's account, not to a conversation.
 - **`available: false` is a successful answer.** When connectors are switched off the list answers
   `{available: false, connectors: []}` with no error frame. Reading that as an empty account would
   tell the person they have no connectors when what they have is a switch turned off.
 - **The authorisation link is per TARGET.** `connectors.connect` answers an operation, and the link
   lives at `targets[].connect_url`: `connector_ui_payload` redacts the whole payload but exempts that
   key by name, which is the only reason the link survives.
 - **There is no disconnect.** Not in the gateway's methods, not in the CLI: the connector tool says it
   outright, that disconnecting is deliberately the person's own act where the account is managed.
 */

/// One connector as the page draws it.
public struct ConnectorItem: Sendable, Equatable, Identifiable {
  /// The slug every other call addresses this connector by.
  public var slug: String
  /// The vendor's display name when it sent one, else the slug.
  public var label: String
  public var description: String
  public var connected: Bool
  /// `nil` when the row did not say, which is not the same as "off".
  public var enabled: Bool?
  /// The vendor's own status word, passed through unmodelled.
  public var connectionStatus: String?
  /// Why the vendor says it is in that state, when it says anything.
  public var statusReason: String?

  public var id: String { slug }

  public init(
    slug: String, label: String? = nil, description: String = "", connected: Bool = false, enabled: Bool? = nil,
    connectionStatus: String? = nil, statusReason: String? = nil
  ) {
    self.slug = slug
    self.label = label.flatMap { $0.isEmpty ? nil : $0 } ?? slug
    self.description = description
    self.connected = connected
    self.enabled = enabled
    self.connectionStatus = connectionStatus
    self.statusReason = statusReason
  }

  /// One wire row. `ConnectorRow` is an OPEN model on both sides, because the connector service owns
  /// the key set and unknown metadata passes straight through, so the status fields are read under
  /// both of their spellings. A row with neither a `connector` nor a `name` is dropped.
  init?(row: JSONValue) {
    guard let object = row.objectValue else {
      return nil
    }

    func text(_ keys: String...) -> String? {
      for key in keys {
        if let value = object[key]?.stringValue, !value.trimmingCharacters(in: .whitespaces).isEmpty {
          return value
        }
      }

      return nil
    }

    guard let slug = text("connector", "name") else {
      return nil
    }

    self.init(
      slug: slug,
      // `name` is the vendor's label when it sends one. A row with neither is still drawn, under its
      // slug, because a connector the person cannot see is a connector they cannot connect.
      label: text("name").map { CapabilityText.line($0, limit: SecurePrompt.nameLimit) },
      description: CapabilityText.text(text("description"), limit: 300),
      connected: object["connected"]?.boolValue == true,
      enabled: object["enabled"]?.boolValue,
      connectionStatus: text("connectionStatus", "connection_status").map { CapabilityText.line($0, limit: 60) },
      statusReason: text("statusReason", "status_reason").map { CapabilityText.line($0) }
    )
  }
}

public struct ConnectorList: Sendable, Equatable {
  /// `false` means connectors are switched off: not "none configured".
  public var available: Bool
  public var connectors: [ConnectorItem]

  public init(available: Bool = true, connectors: [ConnectorItem] = []) {
    self.available = available
    self.connectors = connectors
  }
}

/// One snapshot of the connection operation a `connect` opened.
public struct ConnectorOperation: Sendable, Equatable {
  public var id: String
  /// The operation's own write counter: a snapshot whose `seq` is not newer than the one held is older.
  public var seq: Int?
  public var settled: Bool
  public var targets: [ConnectionOperationTarget]

  init(_ result: JSONValue) {
    id = result["op_id"]?.stringValue ?? ""
    seq = result["seq"]?.intValue
    settled = result["settled"]?.boolValue == true
    targets = (result["targets"]?.arrayValue ?? []).compactMap { $0.objectValue.map(ConnectionOperationTarget.init(json:)) }
  }

  public init(id: String, seq: Int? = nil, settled: Bool = false, targets: [ConnectionOperationTarget] = []) {
    self.id = id
    self.seq = seq
    self.settled = settled
    self.targets = targets
  }

  public func target(_ slug: String) -> ConnectionOperationTarget? {
    targets.first { $0.name == slug }
  }
}

/// How a connect attempt ended, in the three words the page has to say.
public enum ConnectOutcome: Sendable, Equatable {
  case connected
  case failed(String)
  case expired
  /// Not completed: the person skipped it, or the operation settled without it.
  case skipped

  /// A target state that will not change again without a new attempt, as the outcome it is.
  init?(settled target: ConnectionOperationTarget) {
    switch target.state {
    case .connected:
      self = .connected
    case .expired:
      self = .expired
    case .skipped:
      self = .skipped
    case .failed, .unknown("unavailable"):
      let said = CapabilityText.line(target.detail ?? target.hint)

      self = .failed(said.isEmpty ? "The authorisation did not finish." : said)
    default:
      return nil
    }
  }
}

/// The gateway's calls behind the Connectors page: always for the ACCOUNT of a profile.
public struct ConnectorsService: Sendable {
  let gateway: BotSettingsGateway

  public init(gateway: BotSettingsGateway) {
    self.gateway = gateway
  }

  private static let owner: JSONValue = .object(["type": "account"])

  private func params(_ profile: String?, _ extra: JSONObject = [:]) -> JSONObject {
    var params = extra

    params["owner"] = Self.owner

    if let profile, !profile.isEmpty {
      params["profile"] = .string(profile)
    }

    return params
  }

  public func list(profile: String?) async throws -> ConnectorList {
    let result = try await gateway.request(RPC.ConnectorsList.name, params(profile))

    return ConnectorList(
      available: result["available"]?.boolValue != false,
      connectors: (result["connectors"]?.arrayValue ?? []).compactMap { ConnectorItem(row: $0) }
    )
  }

  /// Start an authorisation. `reconnect` is the account-switch path: the gateway refuses it with
  /// `LINK_STILL_VALID` unless the target is `failed` or `expired`, which arrives as a thrown error.
  public func connect(_ slug: String, reconnect: Bool, profile: String?) async throws -> ConnectorOperation {
    var extra: JSONObject = ["connectors": .array([.string(slug)])]

    if reconnect {
      extra["reconnect"] = true
    }

    return ConnectorOperation(try await gateway.request(RPC.ConnectorsConnect.name, params(profile, extra)))
  }

  public func status(of operation: String, profile: String?) async throws -> ConnectorOperation {
    ConnectorOperation(
      try await gateway.request(RPC.ConnectorsOperationStatus.name, params(profile, ["op_id": .string(operation)])))
  }

  /// Tell the gateway the browser leg is back, so it reads the account now rather than on its next
  /// watcher tick. A latency shortcut and nothing else: the gateway's own docstring says the link "is
  /// not trusted for anything else". A failure is ignored on purpose: `UNKNOWN_OPERATION` is exactly
  /// what a flow that already finished answers, and the poll is what decides the outcome.
  public func wake(_ operation: String, profile: String?) async {
    _ = try? await gateway.request(RPC.ConnectorsOperationWake.name, params(profile, ["op_id": .string(operation)]))
  }
}
