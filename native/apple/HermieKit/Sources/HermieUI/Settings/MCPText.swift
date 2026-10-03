import Foundation
import HermieCore
import HermieProtocol

/// Where the MCP page stands, as one case chosen from what the model read: the page says exactly one
/// thing about the gateway and a test can pin each.
enum MCPPageState: Equatable {
  /// There is no live gateway to ask.
  case noGateway
  /// The first read has not answered.
  case loading
  /// The gateway has no MCP endpoint, or it is switched off. Nothing else is shown.
  case notOffered
  /// Signed in without a person: the page says to sign in with an account.
  case noIdentity
  /// This device is not signed in to the gateway.
  case signedOut
  /// The read failed and nothing was read before.
  case unreadable
  /// The gateway answered: the endpoint, the command and the clients are shown.
  case on
  /// The gateway answered once, and the last refresh failed: the old answer is shown with a line
  /// saying so.
  case stale

  /// Whether the endpoint, the command, the configuration and the clients are shown.
  var showsSettings: Bool { self == .on || self == .stale }

  /// The state from what the model holds.
  static func from(phase: MCPSettingsModel.Phase, hasSettings: Bool) -> MCPPageState {
    switch phase {
    case .loading, .ready: hasSettings ? .on : .loading
    case .notOffered: .notOffered
    case .noIdentity: .noIdentity
    case .signedOut: .signedOut
    case .unreadable: hasSettings ? .stale : .unreadable
    }
  }

  @MainActor
  static func of(_ model: MCPSettingsModel) -> MCPPageState {
    from(phase: model.phase, hasSettings: model.settings != nil)
  }
}

/// One connected client as a row says it: every line already a plain, bounded string.
struct MCPGrantLines: Equatable {
  /// The client's name, or "Unnamed client".
  var name: String
  /// When it was allowed, and from where when the gateway recorded an address.
  var allowed: String
  /// When it last used its token, and from where; "Never used" when it has not.
  var lastUsed: String
  /// When the grant ends, when the gateway said.
  var expires: String?

  /// What VoiceOver reads for the row, name first.
  var spoken: String {
    ([name, allowed, lastUsed] + [expires].compactMap { $0 }).joined(separator: ", ")
  }
}

/// The words of the MCP page: every state, and the lines of a client. Nothing the gateway wrote
/// reaches them except through the model's bounding (`displayName`, `displayAddress`).
enum MCPText {
  /// One sentence for where the page stands, and a symbol for it.
  static func state(_ state: MCPPageState) -> (text: String, symbol: String) {
    switch state {
    case .noGateway: (NativeStrings.MCP.State.noGateway, "nosign")
    case .loading: (NativeStrings.MCP.State.loading, "hourglass")
    case .notOffered: (NativeStrings.MCP.State.notOffered, "nosign")
    case .noIdentity: (NativeStrings.MCP.State.noIdentity, "person.crop.circle.badge.exclamationmark")
    case .signedOut: (NativeStrings.MCP.State.signedOut, "person.crop.circle.badge.exclamationmark")
    case .unreadable: (NativeStrings.MCP.State.unreadable, "wifi.exclamationmark")
    case .on: (NativeStrings.MCP.State.on, "checkmark.circle")
    case .stale: (NativeStrings.MCP.State.stale, "exclamationmark.triangle")
    }
  }

  /// The date and time of a Unix timestamp, in the reader's own format.
  static func format(_ unix: Double) -> String {
    Date(timeIntervalSince1970: unix).formatted(date: .abbreviated, time: .shortened)
  }

  /// A client's lines. `format` makes a timestamp readable (the reader's own by default).
  static func lines(for grant: MCPGrant, format: (Double) -> String = MCPText.format) -> MCPGrantLines {
    let name = MCPSettingsModel.displayName(grant.clientName)
    let from = MCPSettingsModel.displayAddress(grant.createdIP)
    let lastFrom = MCPSettingsModel.displayAddress(grant.lastUsedIP)

    let allowed: String

    if let at = grant.createdAt {
      allowed =
        from.isEmpty
        ? NativeStrings.MCP.Grant.allowed(format(at)) : NativeStrings.MCP.Grant.allowedFrom(format(at), from)
    } else {
      allowed = NativeStrings.MCP.Grant.allowedUnknown
    }

    let lastUsed: String

    if let at = grant.lastUsedAt {
      lastUsed =
        lastFrom.isEmpty
        ? NativeStrings.MCP.Grant.lastUsed(format(at)) : NativeStrings.MCP.Grant.lastUsedFrom(format(at), lastFrom)
    } else {
      lastUsed = NativeStrings.MCP.Grant.neverUsed
    }

    return MCPGrantLines(
      name: name.isEmpty ? NativeStrings.MCP.Grant.unnamed : name,
      allowed: allowed,
      lastUsed: lastUsed,
      expires: grant.expiresAt.map { NativeStrings.MCP.Grant.expires(format($0)) }
    )
  }

  /// The words for a change another session made, from `mcp.changed`.
  static func notice(_ notice: MCPSettingsModel.Notice) -> String {
    let name = notice.clientName

    return switch notice.change {
    case .granted: name.isEmpty ? NativeStrings.MCP.Notice.changed : NativeStrings.MCP.Notice.granted(name)
    case .revoked: name.isEmpty ? NativeStrings.MCP.Notice.changed : NativeStrings.MCP.Notice.revoked(name)
    case .unknown: NativeStrings.MCP.Notice.changed
    }
  }
}

extension NativeStrings {
  enum MCP {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// MCP
    static var title: String { string("native.mcp.title") }
    /// Let MCP clients, such as coding agents, use your bots through this gateway.
    static var blurb: String { string("native.mcp.blurb") }
    /// MCP on {gateway}
    static func stateHeader(_ gateway: String) -> String {
      String(localized: "native.mcp.stateHeader", defaultValue: "MCP on \(gateway)", table: "Native", bundle: .module)
    }
    /// Try again
    static var retry: String { string("native.mcp.retry") }
    /// Copied
    static var copied: String { string("native.mcp.copied") }
    /// Dismiss
    static var dismiss: String { string("native.mcp.dismiss") }

    enum State {
      /// Connect to a gateway to see its MCP settings.
      static var noGateway: String { string("native.mcp.state.noGateway") }
      /// Checking this gateway…
      static var loading: String { string("native.mcp.state.loading") }
      /// This gateway does not offer MCP.
      static var notOffered: String { string("native.mcp.state.notOffered") }
      /// MCP needs you to be signed in as a person on this gateway…
      static var noIdentity: String { string("native.mcp.state.noIdentity") }
      /// Hermie is not signed in to this gateway…
      static var signedOut: String { string("native.mcp.state.signedOut") }
      /// Hermie could not read the MCP settings from this gateway.
      static var unreadable: String { string("native.mcp.state.unreadable") }
      /// MCP is on for this gateway.
      static var on: String { string("native.mcp.state.on") }
      /// These settings may be out of date…
      static var stale: String { string("native.mcp.state.stale") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Endpoint {
      /// Endpoint
      static var header: String { string("native.mcp.endpoint.header") }
      /// Copy endpoint
      static var copy: String { string("native.mcp.endpoint.copy") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Command {
      /// Command line
      static var header: String { string("native.mcp.command.header") }
      /// Copy command
      static var copy: String { string("native.mcp.command.copy") }
      /// Run it in a terminal on the computer where the client is installed…
      static var footer: String { string("native.mcp.command.footer") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Config {
      /// Configuration file
      static var header: String { string("native.mcp.config.header") }
      /// Copy configuration
      static var copy: String { string("native.mcp.config.copy") }
      /// Or put this in the client's MCP configuration file (.mcp.json).
      static var footer: String { string("native.mcp.config.footer") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Instructions {
      /// From the gateway
      static var header: String { string("native.mcp.instructions.header") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Clients {
      /// Connected clients
      static var header: String { string("native.mcp.clients.header") }
      /// No client is connected yet…
      static var empty: String { string("native.mcp.clients.empty") }
      /// A client you revoke stops working at once…
      static var footer: String { string("native.mcp.clients.footer") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Grant {
      /// Unnamed client
      static var unnamed: String { string("native.mcp.grant.unnamed") }
      /// Allowed {date}
      static func allowed(_ date: String) -> String {
        String(localized: "native.mcp.grant.allowed", defaultValue: "Allowed \(date)", table: "Native", bundle: .module)
      }
      /// Allowed {date} from {address}
      static func allowedFrom(_ date: String, _ address: String) -> String {
        String(
          localized: "native.mcp.grant.allowedFrom", defaultValue: "Allowed \(date) from \(address)", table: "Native",
          bundle: .module)
      }
      /// Allowed at an unknown time
      static var allowedUnknown: String { string("native.mcp.grant.allowedUnknown") }
      /// Last used {date}
      static func lastUsed(_ date: String) -> String {
        String(localized: "native.mcp.grant.lastUsed", defaultValue: "Last used \(date)", table: "Native", bundle: .module)
      }
      /// Last used {date} from {address}
      static func lastUsedFrom(_ date: String, _ address: String) -> String {
        String(
          localized: "native.mcp.grant.lastUsedFrom", defaultValue: "Last used \(date) from \(address)", table: "Native",
          bundle: .module)
      }
      /// Never used
      static var neverUsed: String { string("native.mcp.grant.neverUsed") }
      /// Expires {date}
      static func expires(_ date: String) -> String {
        String(localized: "native.mcp.grant.expires", defaultValue: "Expires \(date)", table: "Native", bundle: .module)
      }
      /// Revoke
      static var revoke: String { string("native.mcp.grant.revoke") }
      /// Revoke {name}
      static func revokeLabel(_ name: String) -> String {
        String(localized: "native.mcp.grant.revokeLabel", defaultValue: "Revoke \(name)", table: "Native", bundle: .module)
      }
      /// Revoke this client?
      static var revokeTitle: String { string("native.mcp.grant.revokeTitle") }
      /// {name} stops working at once and has to ask for your permission again.
      static func revokeMessage(_ name: String) -> String {
        String(
          localized: "native.mcp.grant.revokeMessage",
          defaultValue: "\(name) stops working at once and has to ask for your permission again.", table: "Native",
          bundle: .module)
      }
      /// Hermie could not revoke that client. Try again.
      static var revokeFailed: String { string("native.mcp.grant.revokeFailed") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }

    enum Notice {
      /// {name} was allowed to connect.
      static func granted(_ name: String) -> String {
        String(
          localized: "native.mcp.notice.granted", defaultValue: "\(name) was allowed to connect.", table: "Native",
          bundle: .module)
      }
      /// {name} was revoked.
      static func revoked(_ name: String) -> String {
        String(localized: "native.mcp.notice.revoked", defaultValue: "\(name) was revoked.", table: "Native", bundle: .module)
      }
      /// The list of clients changed.
      static var changed: String { string("native.mcp.notice.changed") }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }
  }
}
