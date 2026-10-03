import HermieCore
import SwiftUI

/// The Settings categories, as the Expo app lists them (`features/settings/navigation/routes.tsx`).
public enum SettingsCategory: String, CaseIterable, Hashable, Sendable, Identifiable {
  case account
  case gateways
  case chats
  case notifications
  case memory
  case appearance
  case privacy
  case voice
  case capabilities
  case advanced
  case about

  public var id: Self { self }

  /// Grouped the way the list draws them.
  public static let groups: [[SettingsCategory]] = [
    [.account, .gateways],
    [.chats, .notifications, .memory],
    [.appearance, .privacy, .voice],
    [.capabilities],
    [.advanced, .about]
  ]

  var title: String {
    switch self {
    case .account: Strings.App.Settings.Categories.account
    case .gateways: Strings.App.Settings.Categories.gateways
    case .chats: Strings.App.Settings.Categories.chats
    case .notifications: Strings.App.Settings.Categories.notifications
    case .memory: Strings.App.Settings.Categories.memory
    case .appearance: Strings.App.Settings.Categories.appearance
    case .privacy: Strings.App.Settings.Categories.privacy
    case .voice: Strings.App.Settings.Categories.voice
    case .capabilities: Strings.App.Settings.Categories.capabilities
    case .advanced: Strings.App.Settings.Categories.advanced
    case .about: Strings.App.Settings.Categories.about
    }
  }

  var blurb: String {
    switch self {
    case .account: Strings.App.Settings.Categories.Blurb.account
    case .gateways: Strings.App.Settings.Categories.Blurb.gateways
    case .chats: Strings.App.Settings.Categories.Blurb.chats
    case .notifications: Strings.App.Settings.Categories.Blurb.notifications
    case .memory: Strings.App.Settings.Categories.Blurb.memory
    case .appearance: Strings.App.Settings.Categories.Blurb.appearance
    case .privacy: Strings.App.Settings.Categories.Blurb.privacy
    case .voice: Strings.App.Settings.Categories.Blurb.voice
    case .capabilities: Strings.App.Settings.Categories.Blurb.capabilities
    case .advanced: Strings.App.Settings.Categories.Blurb.advanced
    case .about: Strings.App.Settings.Categories.Blurb.about
    }
  }

  var systemImage: String {
    switch self {
    case .account: "person.crop.circle"
    case .gateways: "server.rack"
    case .chats: "bubble.left.and.bubble.right"
    case .notifications: "bell.badge"
    case .memory: "book"
    case .appearance: "circle.lefthalf.filled"
    case .privacy: "lock"
    case .voice: "mic"
    case .capabilities: "bolt"
    case .advanced: "slider.horizontal.3"
    case .about: "info.circle"
    }
  }
}

/**
 Settings: the category list and one page per category. A sheet with a stack on iPhone and iPad,
 the `Settings` window with a sidebar on the Mac.

 Implemented: Account, Privacy (the app lock), Gateways, Notifications and About. Every other category is
 a placeholder
 page until its task lands.
 */
public struct SettingsView: View {
  private let onAddGateway: @MainActor () -> Void

  @Environment(AppLaunch.self) private var launch

  #if os(macOS)
    @State private var selection: SettingsCategory? = .gateways
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
      NavigationSplitView {
        List(selection: $selection) {
          categoryRows
        }
        .navigationSplitViewColumnWidth(min: 200, ideal: 220)
      } detail: {
        NavigationStack {
          SettingsPage(category: selection ?? .gateways, onAddGateway: onAddGateway)
        }
      }
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
      .accessibilityIdentifier("hermie.settings")
      .onChange(of: ShellRequests.shared.settingsCategory, initial: true) { _, requested in
        if let requested {
          ShellRequests.shared.settingsCategory = nil
          path = [requested]
        }
      }
    #endif
  }

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
}

/// One category's page.
struct SettingsPage: View {
  let category: SettingsCategory
  let onAddGateway: @MainActor () -> Void

  var body: some View {
    Group {
      switch category {
      case .account:
        AccountSettingsPage()
      case .privacy:
        PrivacySettingsPage()
      case .gateways:
        GatewaysSettingsPage(onAddGateway: onAddGateway)
      case .notifications:
        NotificationsSettingsPage()
      case .about:
        AboutSettingsPage()
      case .advanced:
        AdvancedSettingsPage()
      default:
        PlaceholderSettingsPage(category: category)
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
