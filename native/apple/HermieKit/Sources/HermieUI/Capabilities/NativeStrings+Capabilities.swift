import Foundation

/// What the capability pages (Memory, Skills, MCP servers, Connectors, Boards) say that the Expo app
/// does not, from `Resources/Native.xcstrings`. What the Expo app says in the same words is read from
/// the shared catalogue through `Strings.Memory`, `Strings.Skills`, `Strings.Mcp`, `Strings.Connectors`
/// and `Strings.Kanban`.
extension NativeStrings {
  enum Capability {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Connect to a gateway to use this. (a capability page while there is no live gateway)
    static var noGateway: String { string("native.capability.noGateway") }
    /// Bot (the label of the picker that says whose settings a page is reading)
    static var bot: String { string("native.capability.bot") }
  }
}
