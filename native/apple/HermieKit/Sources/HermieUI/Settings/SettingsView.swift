import HermieCore
import SwiftUI

/// The Settings categories, as the Expo app lists them (`features/settings/navigation/routes.tsx`).
public enum SettingsCategory: String, CaseIterable, Hashable, Sendable, Identifiable {
  /// The Mac's own behaviour: the menu bar item and the global shortcut. Not listed on iPhone and iPad.
  case general
  case account
  case gateways
  case passkeys
  case mcp
  case chats
  case notifications
  case usage
  case memory
  case appearance
  case privacy
  case decisions
  case voice
  case skills
  case mcpServers
  case connectors
  case kanban
  case advanced
  case about

  public var id: Self { self }

  /// Grouped the way the list draws them.
  #if os(macOS)
    public static let groups: [[SettingsCategory]] = [
      [.general],
      [.account, .gateways, .passkeys, .mcp],
      [.chats, .notifications, .usage, .memory],
      [.appearance, .privacy, .decisions, .voice],
      [.skills, .mcpServers, .connectors, .kanban],
      [.advanced, .about]
    ]
  #else
    public static let groups: [[SettingsCategory]] = [
      [.account, .gateways, .passkeys, .mcp],
      [.chats, .notifications, .usage, .memory],
      [.appearance, .privacy, .decisions, .voice],
      [.skills, .mcpServers, .connectors, .kanban],
      [.advanced, .about]
    ]
  #endif

  var title: String {
    switch self {
    case .general: NativeStrings.General.title
    case .account: Strings.App.Settings.Categories.account
    case .gateways: Strings.App.Settings.Categories.gateways
    case .passkeys: NativeStrings.Passkeys.title
    case .mcp: NativeStrings.MCP.title
    case .chats: Strings.App.Settings.Categories.chats
    case .notifications: Strings.App.Settings.Categories.notifications
    case .usage: NativeStrings.Usage.title
    case .memory: Strings.App.Settings.Categories.memory
    case .appearance: Strings.App.Settings.Categories.appearance
    case .privacy: Strings.App.Settings.Categories.privacy
    case .decisions: NativeStrings.Decisions.title
    case .voice: Strings.App.Settings.Categories.voice
    case .skills: Strings.Skills.title
    case .mcpServers: Strings.Mcp.title
    case .connectors: Strings.Connectors.title
    case .kanban: Strings.Kanban.title
    case .advanced: Strings.App.Settings.Categories.advanced
    case .about: Strings.App.Settings.Categories.about
    }
  }

  var blurb: String {
    switch self {
    case .general: NativeStrings.General.blurb
    case .account: Strings.App.Settings.Categories.Blurb.account
    case .gateways: Strings.App.Settings.Categories.Blurb.gateways
    case .passkeys: NativeStrings.Passkeys.stateFooter
    case .mcp: NativeStrings.MCP.blurb
    case .chats: Strings.App.Settings.Categories.Blurb.chats
    case .notifications: Strings.App.Settings.Categories.Blurb.notifications
    case .usage: NativeStrings.Usage.blurb
    case .memory: Strings.App.Settings.Categories.Blurb.memory
    case .appearance: Strings.App.Settings.Categories.Blurb.appearance
    case .privacy: Strings.App.Settings.Categories.Blurb.privacy
    case .decisions: NativeStrings.Decisions.blurb
    case .voice: Strings.App.Settings.Categories.Blurb.voice
    case .skills: Strings.Skills.Settings.hint
    case .mcpServers: Strings.Mcp.Settings.hint
    case .connectors: Strings.Connectors.Settings.hint
    case .kanban: Strings.Kanban.Settings.hint
    case .advanced: Strings.App.Settings.Categories.Blurb.advanced
    case .about: Strings.App.Settings.Categories.Blurb.about
    }
  }

  var systemImage: String {
    switch self {
    case .general: "gearshape"
    case .account: "person.crop.circle"
    case .gateways: "server.rack"
    case .passkeys: "person.badge.key"
    case .mcp: "puzzlepiece.extension"
    case .chats: "bubble.left.and.bubble.right"
    case .notifications: "bell.badge"
    case .usage: "chart.bar.xaxis"
    case .memory: "book"
    case .appearance: "circle.lefthalf.filled"
    case .privacy: "lock"
    case .decisions: "checklist"
    case .voice: "mic"
    case .skills: "wand.and.stars"
    case .mcpServers: "wrench.and.screwdriver"
    case .connectors: "link"
    case .kanban: "rectangle.split.3x1"
    case .advanced: "slider.horizontal.3"
    case .about: "info.circle"
    }
  }
}

/**
 Settings: the category list and one page per category. A sheet with a stack on iPhone and iPad,
 the `Settings` window with a sidebar on the Mac.

 Implemented: Account, Privacy (the app lock), Gateways, MCP, Chats (the defaults, the cache and the folders),
 Notifications, Usage, Decision log, Memory, Skills, MCP servers, Connectors, Boards, Appearance, Voice and About. Every category has its page.
 */
public struct SettingsView: View {
  private let onAddGateway: @MainActor () -> Void

  @Environment(AppLaunch.self) private var launch

  #if os(macOS)
    @State private var selection: SettingsCategory? = .gateways
    /// Whether the person collapsed the sidebar, remembered for this window.
    @SceneStorage("hermie.settings.sidebarHidden") private var sidebarHidden = false
  #else
    @Environment(\.dismiss) private var dismiss
    @State private var path: [SettingsCategory] = []
  #endif

  /// - Parameter onAddGateway: open setup for another gateway (the shell's onboarding seam).
  public init(onAddGateway: @escaping @MainActor () -> Void) {
    self.onAddGateway = onAddGateway
  }

  public var body: some View {
    #if os(macOS)
      NavigationSplitView(columnVisibility: sidebarVisibility) {
        // One row style and one gap between the groups: the system's sidebar list with a headerless
        // `Section` per group, the way System Settings draws it. No padding of our own.
        List(selection: $selection) {
          ForEach(Array(SettingsCategory.groups.enumerated()), id: \.offset) { _, group in
            Section {
              ForEach(group) { category in
                sidebarRow(category)
              }
            }
          }
        }
        .listStyle(.sidebar)
        .navigationSplitViewColumnWidth(min: 200, ideal: 220)
      } detail: {
        NavigationStack {
          SettingsPage(category: selection ?? .gateways, onAddGateway: onAddGateway)
        }
      }
      // The toggle button the system draws at the top of the sidebar is gone. The sidebar still
      // collapses: View > Hide Sidebar (Control-Command-S) and dragging the divider, and the state is kept.
      .toolbar(removing: .sidebarToggle)
      .appAppearance(launch.settings)
      .accessibilityIdentifier("hermie.settings")
      .onChange(of: ShellRequests.shared.settingsCategory, initial: true) { _, requested in
        if let requested {
          ShellRequests.shared.settingsCategory = nil
          selection = requested
        }
      }
    #else
      NavigationStack(path: $path) {
        List {
          categoryRows
        }
        .navigationTitle(Strings.App.Settings.title)
        .navigationDestination(for: SettingsCategory.self) { category in
          SettingsPage(category: category, onAddGateway: onAddGateway)
        }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            // The system's own close button: a symbol with the platform's label.
            Button(role: .close) { dismiss() }
              .accessibilityIdentifier("hermie.settings.done")
          }
        }
      }
      .appAppearance(launch.settings)
      .accessibilityIdentifier("hermie.settings")
      .onChange(of: ShellRequests.shared.settingsCategory, initial: true) { _, requested in
        if let requested {
          ShellRequests.shared.settingsCategory = nil
          path = [requested]
        }
      }
    #endif
  }

  #if os(macOS)
    /// The split view's columns, backed by the remembered collapsed state.
    private var sidebarVisibility: Binding<NavigationSplitViewVisibility> {
      Binding(
        get: { SettingsSidebarState.visibility(hidden: sidebarHidden) },
        set: { sidebarHidden = SettingsSidebarState.isHidden($0) }
      )
    }

    /// One sidebar row: the same label everywhere, selected by tag rather than a link.
    private func sidebarRow(_ category: SettingsCategory) -> some View {
      Label(category.title, systemImage: category.systemImage)
        .tag(category)
        .badge(category == .gateways ? launch.iCloudSync.attentionCount : 0)
        .accessibilityIdentifier("hermie.settings.category.\(category.rawValue)")
    }
  #else
    private var categoryRows: some View {
      ForEach(Array(SettingsCategory.groups.enumerated()), id: \.offset) { _, group in
        Section {
          ForEach(group) { category in
            NavigationLink(value: category) {
              Label(category.title, systemImage: category.systemImage)
            }
            // What iCloud Sync wants the person to see (its page is under Gateways).
            .badge(category == .gateways ? launch.iCloudSync.attentionCount : 0)
            .accessibilityIdentifier("hermie.settings.category.\(category.rawValue)")
          }
        }
      }
    }
  #endif
}

/// The Settings sidebar's collapsed state as the split view's column visibility, and back.
enum SettingsSidebarState {
  static func visibility(hidden: Bool) -> NavigationSplitViewVisibility {
    hidden ? .detailOnly : .all
  }

  /// Only `.detailOnly` is a collapsed sidebar; `.automatic`, `.all` and `.doubleColumn` show it.
  static func isHidden(_ visibility: NavigationSplitViewVisibility) -> Bool {
    visibility == .detailOnly
  }
}

/// One category's page.
struct SettingsPage: View {
  let category: SettingsCategory
  let onAddGateway: @MainActor () -> Void

  var body: some View {
    Group {
      switch category {
      case .general:
        #if os(macOS)
          GeneralSettingsPage()
        #else
          EmptyView()
        #endif
      case .account:
        AccountSettingsPage()
      case .privacy:
        PrivacySettingsPage()
      case .decisions:
        DecisionLogSettingsEntry()
      case .gateways:
        GatewaysSettingsPage(onAddGateway: onAddGateway)
      case .passkeys:
        PasskeysSettingsEntry()
      case .mcp:
        MCPSettingsEntry()
      case .chats:
        ChatListSettingsEntry()
      case .memory:
        MemorySettingsEntry()
      case .skills:
        SkillsSettingsEntry()
      case .mcpServers:
        McpServersSettingsEntry()
      case .connectors:
        ConnectorsSettingsEntry()
      case .kanban:
        KanbanSettingsEntry()
      case .notifications:
        NotificationsSettingsPage()
      case .usage:
        UsageSettingsEntry()
      case .appearance:
        AppearanceSettingsPage()
      case .voice:
        VoiceSettingsPage()
      case .about:
        AboutSettingsPage()
      case .advanced:
        AdvancedSettingsPage()
      }
    }
    .navigationTitle(category.title)
  }
}

/// A category whose task has not landed yet: what it will hold, and when.
struct PlaceholderSettingsPage: View {
  let category: SettingsCategory

  var body: some View {
    Form {
      Section {
        Text(NativeStrings.later)
      } footer: {
        SettingsNote(category.blurb)
      }
    }
    .formStyle(.grouped)
    .accessibilityIdentifier("hermie.settings.placeholder")
  }
}

/// Advanced: a placeholder, plus the debug screens in a debug build.
struct AdvancedSettingsPage: View {
  var body: some View {
    Form {
      Section {
        Text(NativeStrings.later)
      } footer: {
        SettingsNote(SettingsCategory.advanced.blurb)
      }

      #if DEBUG
        if !DebugScreens.entries.isEmpty {
          Section(NativeStrings.Debug.title) {
            ForEach(DebugScreens.entries) { entry in
              NavigationLink(entry.title) {
                entry.make()
                  .navigationTitle(entry.title)
              }
            }
          }
        }
      #endif
    }
    .formStyle(.grouped)
  }
}

/**
 A section's header or footer. Drawn in the primary colour rather than the system's grey, which
 fails the contrast audit at footnote size.
 */
struct SettingsNote: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    // `Color.primary`, the label colour: `.primary` alone is the footer's own (grey) level.
    Text(text)
      .foregroundStyle(Color.primary)
  }
}
