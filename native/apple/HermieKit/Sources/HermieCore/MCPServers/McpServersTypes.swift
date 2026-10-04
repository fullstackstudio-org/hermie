import Foundation
import HermieProtocol

/**
 The MCP servers a bot's profile configures, as the page reads them (`mcp-controller.ts` in the Expo
 app, `tui_gateway/methods_tools.py` on the gateway).

 Four gateway calls with four different ideas of what "is this server working" means, and the page is
 only honest if it keeps them apart:

 - `mcp.servers.list` is the CONFIG: what is defined and whether it is switched on. It knows nothing
   about whether it works.
 - `mcp.servers.status` is CACHED runtime state. It never connects, probes or starts auth, so a server
   that needs authorising looks exactly like one that is fine.
 - `mcp.servers.test` is the only call that finds out, by connecting. It is also the only one that can
   say the server needs authorising, which is why "needs authorising" is a probe result here and
   never a badge on the list.
 - `reload.mcp` applies config changes to live chats, and may refuse by ANSWERING.

 A probe is never run on the person's behalf: it connects, and a cold `npx` server takes seconds.
 */

/// What the gateway's cached runtime state says about a server (`mcp.servers.status`).
public enum McpRuntime: String, Sendable, Equatable {
  case connected
  case disabled
  case connecting
  case failed
  case lazy
  case configured
  /// No runtime row at all: defined but never started. Not "failed": a lazily started server on a
  /// freshly booted gateway would otherwise carry a red dot.
  case unknown
}

/// One server of the profile: the config row joined with the cached runtime row.
public struct McpServerRow: Sendable, Equatable, Identifiable {
  public var name: String
  public var transport: String
  /// The url of an http server, the command line of a stdio one.
  public var address: String
  /// Env KEY NAMES the server needs. Never values: the gateway does not send them.
  public var env: [String]
  /// `oauth`, `bearer`, or nothing.
  public var auth: String?
  public var oauthTokensPresent: Bool?
  public var enabled: Bool
  public var runtime: McpRuntime
  public var toolCount: Int
  /// An http server: the only kind OAuth and a bearer key apply to.
  public var isHTTP: Bool

  public var id: String { name }

  public init(
    name: String, transport: String = "stdio", address: String = "", env: [String] = [], auth: String? = nil,
    oauthTokensPresent: Bool? = nil, enabled: Bool = true, runtime: McpRuntime = .unknown, toolCount: Int = 0,
    isHTTP: Bool? = nil
  ) {
    self.name = name
    self.transport = transport
    self.address = address
    self.env = env
    self.auth = auth
    self.oauthTokensPresent = oauthTokensPresent
    self.enabled = enabled
    self.runtime = runtime
    self.toolCount = toolCount
    self.isHTTP = isHTTP ?? (transport != "stdio")
  }

  /// A `mcp.servers.list` row.
  init?(config row: JSONValue) {
    guard let object = row.objectValue, let name = object["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    let url = object["url"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    let command = object["command"]?.stringValue ?? ""
    let args = (object["args"]?.arrayValue ?? []).compactMap(\.stringValue)
    let transport = object["transport"]?.stringValue ?? (url == nil ? "stdio" : "http")

    self.init(
      name: name,
      transport: transport,
      address: CapabilityText.line(url ?? ([command] + args).filter { !$0.isEmpty }.joined(separator: " "), limit: 400),
      env: (object["env"]?.arrayValue ?? []).compactMap(\.stringValue),
      auth: object["auth"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 },
      oauthTokensPresent: object["oauth_tokens_present"]?.boolValue,
      enabled: object["enabled"]?.boolValue != false,
      runtime: .unknown,
      toolCount: object["tools"]?.intValue ?? 0,
      isHTTP: url != nil || transport != "stdio"
    )
  }

  /// This row with the cached runtime row for its name, where there is one.
  func merged(runtime row: JSONObject?) -> McpServerRow {
    guard let row else {
      return self
    }

    var merged = self

    merged.runtime = row["status"]?.stringValue.flatMap(McpRuntime.init(rawValue:)) ?? .unknown
    merged.toolCount = row["tools"]?.intValue ?? toolCount

    return merged
  }
}

/// One tool a server offers, as a probe found it.
public struct McpTool: Sendable, Equatable, Identifiable {
  public var name: String
  public var description: String

  public var id: String { name }

  init?(_ row: JSONValue) {
    guard let object = row.objectValue, let name = object["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    self.name = name
    self.description = CapabilityText.text(object["description"]?.stringValue, limit: 300)
  }

  public init(name: String, description: String = "") {
    self.name = name
    self.description = description
  }
}

/// A probe's outcome, flattened into the three things the page says. A probe is a SUCCESSFUL call
/// whichever way it goes, so everything here reads `ok` and none of it relies on a throw: a client that
/// trusted the absence of an error frame would report every broken server as working.
public struct McpProbe: Sendable, Equatable {
  public var ok: Bool
  /// Wanted and not satisfied: `oauth_needed` is also true on a server that IS authorised.
  public var needsAuth: Bool
  public var error: String?
  public var tools: [McpTool]

  public init(ok: Bool, needsAuth: Bool = false, error: String? = nil, tools: [McpTool] = []) {
    self.ok = ok
    self.needsAuth = needsAuth
    self.error = error
    self.tools = tools
  }

  init(_ result: JSONValue) {
    let ok = result["ok"]?.boolValue == true
    let said = CapabilityText.line(result["error"]?.stringValue)

    self.init(
      ok: ok,
      needsAuth: result["oauth_needed"]?.boolValue == true && result["oauth_tokens_present"]?.boolValue != true,
      error: ok ? nil : (said.isEmpty ? "The probe failed without saying why." : said),
      tools: (result["tools"]?.arrayValue ?? []).compactMap { McpTool($0) }
    )
  }
}

/// A curated preset the gateway offers (`mcp.catalog`).
public struct McpCatalogEntry: Sendable, Equatable, Identifiable {
  public var name: String
  public var description: String
  public var installed: Bool
  public var enabled: Bool
  /// The env keys it needs, which the person supplies as an API key after adding it.
  public var requires: [String]
  public var transport: String

  public var id: String { name }

  public init(
    name: String, description: String = "", installed: Bool = false, enabled: Bool = false, requires: [String] = [],
    transport: String = "stdio"
  ) {
    self.name = name
    self.description = description
    self.installed = installed
    self.enabled = enabled
    self.requires = requires
    self.transport = transport
  }

  init?(_ row: JSONValue) {
    guard let object = row.objectValue, let name = object["name"]?.stringValue, !name.isEmpty else {
      return nil
    }

    self.init(
      name: name,
      description: CapabilityText.text(object["description"]?.stringValue, limit: 300),
      installed: object["installed"]?.boolValue == true,
      enabled: object["enabled"]?.boolValue == true,
      requires: (object["requires"]?.arrayValue ?? []).compactMap(\.stringValue),
      transport: object["transport"]?.stringValue ?? "stdio"
    )
  }
}

/// The server a person is adding by hand.
public struct McpServerDraft: Sendable, Equatable {
  public enum Kind: Sendable, Hashable, CaseIterable {
    /// A server reached at a web address.
    case http
    /// A server started as a command on the gateway's machine.
    case stdio
  }

  /// What is wrong with the draft, so the sheet says it next to the field and sends nothing.
  public enum Problem: Sendable, Equatable {
    case nameMissing
    case nameHasSpaces
    case urlInvalid
    case commandMissing
  }

  public var name = ""
  public var kind = Kind.http
  public var url = ""
  public var command = ""
  /// The arguments as one line, split the way a shell would.
  public var arguments = ""
  /// An http server's bearer token, written to the profile's `.env` by the gateway. Optional.
  public var bearerToken = ""

  public init(
    name: String = "", kind: Kind = .http, url: String = "", command: String = "", arguments: String = "",
    bearerToken: String = ""
  ) {
    self.name = name
    self.kind = kind
    self.url = url
    self.command = command
    self.arguments = arguments
    self.bearerToken = bearerToken
  }

  public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

  public var problems: [Problem] {
    var found: [Problem] = []

    if trimmedName.isEmpty {
      found.append(.nameMissing)
    } else if trimmedName.contains(where: \.isWhitespace) {
      found.append(.nameHasSpaces)
    }

    switch kind {
    case .http:
      if !Self.isWebAddress(url) {
        found.append(.urlInvalid)
      }
    case .stdio:
      if command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        found.append(.commandMissing)
      }
    }

    return found
  }

  /// An `http` or `https` address with a host.
  static func isWebAddress(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard let parsed = URL(string: trimmed), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
      let host = parsed.host(percentEncoded: false)
    else {
      return false
    }

    return !host.isEmpty
  }

  /// The `config` the gateway takes, or `nil` while there is a problem.
  public var config: JSONObject? {
    guard problems.isEmpty else {
      return nil
    }

    switch kind {
    case .http:
      return ["url": .string(url.trimmingCharacters(in: .whitespacesAndNewlines))]
    case .stdio:
      return [
        "command": .string(command.trimmingCharacters(in: .whitespacesAndNewlines)),
        "args": .array(Self.split(arguments).map { JSONValue.string($0) })
      ]
    }
  }

  /// A line of arguments as a shell would split it: on whitespace, with single and double quotes
  /// holding it together and a backslash escaping the next character. Nothing is expanded or run.
  public static func split(_ line: String) -> [String] {
    var words: [String] = []
    var current = ""
    var started = false
    var quote: Character?
    var escaped = false

    for character in line {
      if escaped {
        current.append(character)
        escaped = false
      } else if character == "\\", quote != "'" {
        escaped = true
        started = true
      } else if let open = quote {
        if character == open {
          quote = nil
        } else {
          current.append(character)
        }
      } else if character == "\"" || character == "'" {
        quote = character
        started = true
      } else if character.isWhitespace {
        if started {
          words.append(current)
          current = ""
          started = false
        }
      } else {
        current.append(character)
        started = true
      }
    }

    if started {
      words.append(current)
    }

    return words
  }
}

/// One poll of an OAuth flow.
public enum McpOAuthPoll: Sendable, Equatable {
  case pending
  case approved([McpTool])
  case failed(String)
}
