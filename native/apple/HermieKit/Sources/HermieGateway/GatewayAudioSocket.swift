import Foundation

/// Opening the gateway's audio socket (`WS /api/audio/speak-stream`): the same credentials as every
/// other call, and a socket that carries binary frames.
///
/// It is not the JSON-RPC socket and shares nothing with it. A gated gateway's single-use ticket is
/// minted by the credential provider, as for any dial, and goes on the URL (`?ticket=`), which this
/// route accepts beside the subprotocol: the route answers the upgrade without selecting a
/// subprotocol, so a ticket offered as one has nothing to be selected back.
public enum GatewayAudioSocket {
  public static let path = "/api/audio/speak-stream"

  /// Dial the route for `profile` (nil is the gateway's own default) and return the open socket.
  public static func open(
    baseURL: String,
    profile: String?,
    credentials: any CredentialProvider,
    extraHeaders: [String: String],
    transport: any WebSocketTransport
  ) async throws -> any WebSocketChannel {
    var url = try GatewayAddress.webSocketURL(for: baseURL, path: path)

    if let profile, !profile.isEmpty {
      url += "?profile=\(JSText.encodeURIComponent(profile))"
    }

    let plan = try await credentials.dialPlan(wsURL: url, extraHeaders: extraHeaders)
    let dial = movingTicketToQuery(plan)

    guard WebSocketDial.isWebSocketURL(dial.url), let request = WebSocketDial.request(for: dial) else {
      throw GatewayError(.network, "gateway connect() requires a ws:// or wss:// URL string")
    }

    return try await transport.connect(request, subprotocols: dial.protocols)
  }

  /// The plan with a ticket that was offered as a subprotocol put on the query instead.
  static func movingTicketToQuery(_ plan: DialPlan) -> DialPlan {
    let prefix = GatewayCredentials.webSocketTicketPrefix

    guard let offered = plan.protocols.first(where: { JSText.hasPrefix($0, prefix) }) else {
      return plan
    }

    let ticket = String(offered.dropFirst(prefix.count))
    let separator = plan.url.contains("?") ? "&" : "?"

    return DialPlan(
      url: "\(plan.url)\(separator)ticket=\(JSText.encodeURIComponent(ticket))",
      protocols: plan.protocols.filter { $0 != offered && $0 != GatewayCredentials.webSocketProtocol },
      headers: plan.headers
    )
  }
}
