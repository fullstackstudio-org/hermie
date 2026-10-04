import Foundation

extension GatewaySession {
  /// The model behind the MCP servers page, over this session's link, about one bot's servers (the
  /// gateway's own where `profile` is nil). The caller keeps it: it holds what was read.
  ///
  /// Not `mcp`: that is the gateway's own MCP endpoint for other clients (Settings › MCP), which is a
  /// different thing from the servers a bot reaches.
  public func mcpServers(for profile: String?) -> McpServersModel {
    McpServersModel(service: McpServersService(gateway: .link(link)), profile: profile)
  }
}
