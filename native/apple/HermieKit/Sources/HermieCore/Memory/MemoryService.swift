import Foundation
import HermieGateway
import HermieProtocol

/// What the Memory page asks of the gateway, as one seam: a test hands in a stub, production a
/// `MemoryService` over a session's REST side.
public protocol MemoryBackend: Sendable {
  func list(profile: String) async throws -> MemoryListing
  func search(profile: String, query: String) async throws -> MemorySearchAnswer
  func raw(profile: String) async throws -> MemoryRaw
  func write(profile: String, operation: MemoryOperation, target: MemoryTarget, content: String?, entry: MemoryEntry?)
    async throws -> MemoryWriteAnswer
}

/**
 The Hermie plugin's memory routes (`/api/plugins/hermie/memory/{list,search,raw,edit}`).

 **Every route names its profile, and that is not optional.** A plugin handler is handed no profile
 and otherwise runs under whichever home the dashboard process started with, which on a gateway
 serving several bots is somebody else's memory. The plugin refuses a name that carries a separator,
 a parent reference or surrounding space rather than cleaning it, and this side always sends it,
 percent-encoded.

 **A write is addressed by the entry's text**, not by its index: the plugin prefers the text it is
 given and only falls back to the position, and the text is what the store matches on, so an index
 that went stale between the read and the write cannot overwrite the entry that moved into its place.

 What a status means here: 404 is no route (the plugin is absent or too old), 403 is the route with
 the capability switched off for this profile, 400 a profile name that was refused or a search with no
 query.
 */
public struct MemoryService: MemoryBackend {
  public static let route = "/api/plugins/hermie/memory"

  let rest: any GatewayREST

  public init(rest: any GatewayREST) {
    self.rest = rest
  }

  public func list(profile: String) async throws -> MemoryListing {
    MemoryListing(try await rest.restJSON("GET", path("list", [("profile", profile)]), body: nil))
  }

  public func search(profile: String, query: String) async throws -> MemorySearchAnswer {
    MemorySearchAnswer(try await rest.restJSON("GET", path("search", [("profile", profile), ("q", query)]), body: nil))
  }

  public func raw(profile: String) async throws -> MemoryRaw {
    MemoryRaw(try await rest.restJSON("GET", path("raw", [("profile", profile)]), body: nil))
  }

  public func write(
    profile: String, operation: MemoryOperation, target: MemoryTarget, content: String?, entry: MemoryEntry?
  ) async throws -> MemoryWriteAnswer {
    var body: JSONObject = [
      "profile": .string(profile),
      "target": .string(target.rawValue),
      "op": .string(operation.rawValue)
    ]

    if let content {
      body["content"] = .string(content)
    }

    if let entry {
      body["old_text"] = .string(entry.text)
      body["index"] = .number(Double(entry.index))
    }

    return MemoryWriteAnswer(try await rest.restJSON("POST", path("edit", []), body: .object(body)))
  }

  func path(_ route: String, _ query: [(String, String)]) -> String {
    let base = "\(Self.route)/\(route)"

    return query.isEmpty ? base : base + "?" + CapabilityText.query(query)
  }
}
