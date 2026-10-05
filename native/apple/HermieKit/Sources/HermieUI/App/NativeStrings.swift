import Foundation

/**
 The strings only the native shell has, read from `Resources/Native.xcstrings` (written by hand, in
 English, Dutch and German). A sentence the Expo app also shows belongs in the TypeScript catalogues
 and is read through `Strings` instead.
 */
enum NativeStrings {
  enum About {
    /// Build
    static var build: String { String(localized: "native.about.build", table: "Native", bundle: .module) }
    /// Commit
    static var commit: String { String(localized: "native.about.commit", table: "Native", bundle: .module) }
  }

  enum ConnectionRequest {
    /// Connect an account to continue
    static var title: String { String(localized: "native.connectionRequest.title", table: "Native", bundle: .module) }
    /// Open
    static var open: String { String(localized: "native.connectionRequest.open", table: "Native", bundle: .module) }
    /// Skip
    static var skip: String { String(localized: "native.connectionRequest.skip", table: "Native", bundle: .module) }
  }

  enum Identity {
    /// You are anonymous on this gateway: your messages carry no name.
    static var anonymous: String {
      String(localized: "native.identity.anonymous", table: "Native", bundle: .module)
    }
  }

  enum Chat {
    /// Copy diagnostics (the chat title's hidden long press, and its accessibility action)
    static var copyDiagnostics: String {
      String(localized: "native.chat.copyDiagnostics", table: "Native", bundle: .module)
    }
    /// Copied (in the title's subtitle place for a moment after the diagnostics were copied)
    static var diagnosticsCopied: String {
      String(localized: "native.chat.diagnosticsCopied", table: "Native", bundle: .module)
    }
    /// {name}, open bot settings (what VoiceOver says for the chat title, which is a button)
    static func titleOpensSettings(name: String) -> String {
      String(
        localized: "native.chat.titleOpensSettings", defaultValue: "\(name), open bot settings", table: "Native",
        bundle: .module)
    }
    /// Opens this bot's settings. (the hint of the chat title)
    static var titleOpensSettingsHint: String {
      String(localized: "native.chat.titleOpensSettingsHint", table: "Native", bundle: .module)
    }

    /// The reasoning effort levels of the chat options menu, keyed by what the gateway calls them.
    enum Reasoning {
      static func label(_ effort: String) -> String? {
        switch effort.lowercased() {
        case "none": String(localized: "native.chat.reasoning.none", table: "Native", bundle: .module)
        case "minimal": String(localized: "native.chat.reasoning.minimal", table: "Native", bundle: .module)
        case "low": String(localized: "native.chat.reasoning.low", table: "Native", bundle: .module)
        case "medium": String(localized: "native.chat.reasoning.medium", table: "Native", bundle: .module)
        case "high": String(localized: "native.chat.reasoning.high", table: "Native", bundle: .module)
        case "xhigh": String(localized: "native.chat.reasoning.xhigh", table: "Native", bundle: .module)
        case "max": String(localized: "native.chat.reasoning.max", table: "Native", bundle: .module)
        case "ultra": String(localized: "native.chat.reasoning.ultra", table: "Native", bundle: .module)
        default: nil
        }
      }
    }

    enum Options {
      /// The setting could not be changed: {reason} (the line over the chat when the gateway refused)
      static func failed(_ reason: String) -> String {
        String(
          localized: "native.chat.options.failed", defaultValue: "The setting could not be changed: \(reason)",
          table: "Native", bundle: .module)
      }
      /// The models could not be loaded: {reason} (in the model list)
      static func modelsFailed(_ reason: String) -> String {
        String(
          localized: "native.chat.options.modelsFailed", defaultValue: "The models could not be loaded: \(reason)",
          table: "Native", bundle: .module)
      }
      /// The gateway offers no models to choose from. (in the model list)
      static var modelsEmpty: String {
        String(localized: "native.chat.options.modelsEmpty", table: "Native", bundle: .module)
      }
      /// No model matches. (in the model list, when the search finds nothing)
      static var modelsEmptySearch: String {
        String(localized: "native.chat.options.modelsEmptySearch", table: "Native", bundle: .module)
      }
      /// This model costs more to run. Use it anyway? (the alert's message when the gateway sent none)
      static var expensiveFallback: String {
        String(localized: "native.chat.options.expensiveFallback", table: "Native", bundle: .module)
      }
      /// Markdown (.md) (an item of the Export submenu)
      static var exportMarkdown: String {
        String(localized: "native.chat.options.exportMarkdown", table: "Native", bundle: .module)
      }
      /// Plain text (.txt) (an item of the Export submenu)
      static var exportText: String {
        String(localized: "native.chat.options.exportText", table: "Native", bundle: .module)
      }
      /// Context window is almost full (what VoiceOver says for the toolbar's ring)
      static var contextBadge: String {
        String(localized: "native.chat.options.contextBadge", table: "Native", bundle: .module)
      }
    }

    enum Yolo {
      /// YOLO (the small capsule in the chat's title while YOLO mode is on)
      static var badge: String { String(localized: "native.chat.yolo.badge", table: "Native", bundle: .module) }
      /// Opens a menu to turn it off. (the hint of that capsule)
      static var badgeHint: String {
        String(localized: "native.chat.yolo.badgeHint", table: "Native", bundle: .module)
      }
      /// YOLO mode is on (what VoiceOver says for the capsule)
      static var badgeLabel: String {
        String(localized: "native.chat.yolo.badgeLabel", table: "Native", bundle: .module)
      }
      /// Turn On (the confirming button of the alert that asks before YOLO mode goes on)
      static var confirmAction: String {
        String(localized: "native.chat.yolo.confirmAction", table: "Native", bundle: .module)
      }
      /// Approval requests are skipped in this chat until you turn it off. (the alert's message)
      static var confirmMessage: String {
        String(localized: "native.chat.yolo.confirmMessage", table: "Native", bundle: .module)
      }
      /// Turn on YOLO mode? (the alert's title)
      static var confirmTitle: String {
        String(localized: "native.chat.yolo.confirmTitle", table: "Native", bundle: .module)
      }
      /// YOLO mode could not be changed: {reason} (the line over the chat when the gateway refused)
      static func failed(_ reason: String) -> String {
        String(
          localized: "native.chat.yolo.failed", defaultValue: "YOLO mode could not be changed: \(reason)",
          table: "Native", bundle: .module)
      }
      /// Turn Off YOLO Mode (the capsule's menu item)
      static var turnOff: String { String(localized: "native.chat.yolo.turnOff", table: "Native", bundle: .module) }
    }
  }

  enum ChatList {
    /// Sign in to this gateway to see its chats.
    static var signedOut: String {
      String(localized: "native.chatList.signedOut", table: "Native", bundle: .module)
    }
    /// Now (a row's time, under a minute old)
    static var now: String {
      String(localized: "native.chatList.now", table: "Native", bundle: .module)
    }
    /// Archived
    static var archivedTitle: String {
      String(localized: "native.chatList.archivedTitle", table: "Native", bundle: .module)
    }
    /// Mute {name}
    static func muteTitle(name: String) -> String {
      String(localized: "native.chatList.muteTitle", defaultValue: "Mute \(name)", table: "Native", bundle: .module)
    }
    /// Put your chats in folders, give a folder a colour and choose where each chat goes. (Settings, Chats)
    static var settingsIntro: String {
      String(localized: "native.chatList.settings.intro", table: "Native", bundle: .module)
    }
    /// Folders (the header of the list of folders)
    static var settingsFolders: String {
      String(localized: "native.chatList.settings.folders", table: "Native", bundle: .module)
    }
    /// Chats (the header of the list of chats and the folder each is in)
    static var settingsChats: String {
      String(localized: "native.chatList.settings.chats", table: "Native", bundle: .module)
    }
    /// No folders yet.
    static var settingsNoFolders: String {
      String(localized: "native.chatList.settings.noFolders", table: "Native", bundle: .module)
    }
    /// There are no chats to arrange yet.
    static var settingsNoChats: String {
      String(localized: "native.chatList.settings.noChats", table: "Native", bundle: .module)
    }
    /// Connect to a gateway to arrange its chats.
    static var settingsNoGateway: String {
      String(localized: "native.chatList.settings.noGateway", table: "Native", bundle: .module)
    }
  }

  enum Search {
    /// Found “{query}” in this chat. (announced when a chat opened from a search hit has scrolled to the row)
    static func found(query: String) -> String {
      String(
        localized: "native.search.found", defaultValue: "Found “\(query)” in this chat.", table: "Native",
        bundle: .module)
    }
    /// Messages could not be searched. Check the connection and try again. (under the chat list's messages
    /// section, when every bot's search failed)
    static var failed: String {
      String(localized: "native.search.failed", table: "Native", bundle: .module)
    }
    /// Search Everywhere (the title of the search over every conversation)
    static var title: String { String(localized: "native.search.title", table: "Native", bundle: .module) }
    /// Search every conversation (the placeholder of its field)
    static var prompt: String { String(localized: "native.search.prompt", table: "Native", bundle: .module) }
    /// What the search covers and what a tap does (under its empty field)
    static var hint: String { String(localized: "native.search.hint", table: "Native", bundle: .module) }
    /// No conversation mentions “{query}”.
    static func none(query: String) -> String {
      String(
        localized: "native.search.none", defaultValue: "No conversation mentions “\(query)”.", table: "Native",
        bundle: .module)
    }
    /// Searching… (under the results while the gateways are being asked)
    static var searching: String { String(localized: "native.search.searching", table: "Native", bundle: .module) }
    /// Could not search: {names}. Showing what this device kept.
    static func unreachable(names: String) -> String {
      String(
        localized: "native.search.unreachable", defaultValue: "Could not search: \(names). Showing what this device kept.",
        table: "Native", bundle: .module)
    }
    /// Only on this device (a result the gateway did not confirm)
    static var onDevice: String { String(localized: "native.search.onDevice", table: "Native", bundle: .module) }
    /// Bot Chat (what a result in the bot's own chat is called)
    static var botChat: String { String(localized: "native.search.botChat", table: "Native", bundle: .module) }
    /// My chat (a result in one of the reader's own chats)
    static var ownChat: String { String(localized: "native.search.ownChat", table: "Native", bundle: .module) }
    /// Branch (a result in a branch whose title says nothing more)
    static var branch: String { String(localized: "native.search.branch", table: "Native", bundle: .module) }
    /// Earlier conversation (a result in a past conversation with no title)
    static var past: String { String(localized: "native.search.past", table: "Native", bundle: .module) }
    /// Opens the conversation at this message. (the hint of a result)
    static var openAt: String { String(localized: "native.search.openAt", table: "Native", bundle: .module) }
    /// Search every conversation for “{query}” (the row under the chat list's results)
    static func everywhere(query: String) -> String {
      String(
        localized: "native.search.everywhere", defaultValue: "Search every conversation for “\(query)”",
        table: "Native", bundle: .module)
    }
    /// Conversations (the header over the results)
    static var resultsHeader: String {
      String(localized: "native.search.resultsHeader", table: "Native", bundle: .module)
    }
  }

  enum Commands {
    /// Add Gateway…
    static var addGateway: String { String(localized: "native.commands.addGateway", table: "Native", bundle: .module) }
    /// Gateway
    static var gatewayMenu: String { String(localized: "native.commands.gatewayMenu", table: "Native", bundle: .module) }
    /// Gateway Settings…
    static var gatewaySettings: String {
      String(localized: "native.commands.gatewaySettings", table: "Native", bundle: .module)
    }
    /// Chat
    static var chatMenu: String { String(localized: "native.commands.chatMenu", table: "Native", bundle: .module) }
    /// Find…
    static var find: String { String(localized: "native.commands.find", table: "Native", bundle: .module) }
    /// Search Everywhere… (opens the search over every conversation)
    static var searchEverywhere: String {
      String(localized: "native.commands.searchEverywhere", table: "Native", bundle: .module)
    }
    /// New Chat Window
    static var newChatWindow: String {
      String(localized: "native.commands.newChatWindow", table: "Native", bundle: .module)
    }
    /// Switch Gateway…
    static var switchGateway: String {
      String(localized: "native.commands.switchGateway", table: "Native", bundle: .module)
    }
  }

  enum Debug {
    /// Debug screens
    static var title: String { String(localized: "native.debug.title", table: "Native", bundle: .module) }
  }

  enum Detail {
    enum NoChat {
      /// Choose a bot from the list.
      static var body: String { String(localized: "native.detail.noChat.body", table: "Native", bundle: .module) }
      /// No chat selected
      static var title: String { String(localized: "native.detail.noChat.title", table: "Native", bundle: .module) }
    }
  }

  enum Gateways {
    /// Rename
    static var rename: String { String(localized: "native.gateways.rename", table: "Native", bundle: .module) }

    enum RemoveFailed {
      /// Not Removed
      static var title: String { String(localized: "native.gateways.removeFailed.title", table: "Native", bundle: .module) }
      /// This gateway is no longer synced with iCloud Keychain, so it can only be removed from this device. Nothing was removed.
      static var notSynced: String {
        String(localized: "native.gateways.removeFailed.notSynced", table: "Native", bundle: .module)
      }
      /// Nothing was removed. Try again.
      static var other: String { String(localized: "native.gateways.removeFailed.other", table: "Native", bundle: .module) }
    }
  }

  /// Coming in a later build.
  static var later: String { String(localized: "native.later", table: "Native", bundle: .module) }

  enum Lock {
    /// Hermie is hidden while it is not in front.
    static var coverLabel: String { String(localized: "native.lock.coverLabel", table: "Native", bundle: .module) }
    /// The lock setting could not be read, so Hermie locks every time you leave it. Choose a setting to keep.
    static var settingUnknown: String {
      String(localized: "native.lock.settingUnknown", table: "Native", bundle: .module)
    }
  }

  enum Notice {
    /// That link is for a gateway this device does not know. Add the gateway first.
    static var gatewayNotConfigured: String {
      String(localized: "native.notice.gatewayNotConfigured", table: "Native", bundle: .module)
    }
    /// The app lock setting could not be restored. Check it under Privacy & security.
    static var lockSettingNotRestored: String {
      String(localized: "native.notice.lockSettingNotRestored", table: "Native", bundle: .module)
    }
    /// Set up a gateway first, then open the link again.
    static var noGateway: String { String(localized: "native.notice.noGateway", table: "Native", bundle: .module) }
    /// Hermie’s local data was damaged and has been rebuilt. Everything that could still be read was kept.
    static var recovered: String { String(localized: "native.notice.recovered", table: "Native", bundle: .module) }
    /// Hermie could not open its storage. Nothing you change now is kept after Hermie quits.
    static var runningInMemory: String {
      String(localized: "native.notice.runningInMemory", table: "Native", bundle: .module)
    }
  }

  enum Push {
    /// This gateway cannot deliver to this device yet: its Hermie plugin is too old. Update the plugin on the gateway.
    static var cannotDeliverPlugin: String {
      String(localized: "native.push.cannotDeliverPlugin", table: "Native", bundle: .module)
    }
    /// This gateway cannot deliver to this device yet: its Hermie plugin does not allow this device’s push relay.
    static var cannotDeliverRelay: String {
      String(localized: "native.push.cannotDeliverRelay", table: "Native", bundle: .module)
    }
    /// Developer details
    static var developer: String { String(localized: "native.push.developer", table: "Native", bundle: .module) }
    /// APNs environment
    static var environment: String {
      String(localized: "native.push.environment", table: "Native", bundle: .module)
    }
    /// Could not register. Hermie tries again later.
    static var failed: String { String(localized: "native.push.failed", table: "Native", bundle: .module) }
    /// Not registered: one device can register with at most eight gateways.
    static var limited: String { String(localized: "native.push.limited", table: "Native", bundle: .module) }
    /// Not registered
    static var notRegistered: String {
      String(localized: "native.push.notRegistered", table: "Native", bundle: .module)
    }
    /// Registered
    static var registered: String { String(localized: "native.push.registered", table: "Native", bundle: .module) }
    /// Reset notifications on this device
    static var reset: String { String(localized: "native.push.reset", table: "Native", bundle: .module) }
    /// Takes this device's registrations back from every gateway it can still reach, forgets them and turns notifications off here. Turn them on again afterwards.
    static var resetHint: String { String(localized: "native.push.resetHint", table: "Native", bundle: .module) }
    /// Some registrations could not be taken back yet. Reset again when the device is online.
    static var resetLeftovers: String {
      String(localized: "native.push.resetLeftovers", table: "Native", bundle: .module)
    }
    /// Signed out
    static var signedOut: String { String(localized: "native.push.signedOut", table: "Native", bundle: .module) }
    /// The notification switch could not be saved. Try again.
    static var switchWriteFailed: String {
      String(localized: "native.push.switchWriteFailed", table: "Native", bundle: .module)
    }
    /// That choice could not be saved. Try again. (a kind of notification, or the preview)
    static var preferencesWriteFailed: String {
      String(localized: "native.push.preferencesWriteFailed", table: "Native", bundle: .module)
    }
    /// Urgent requests break through Focus
    static var urgentBreakthrough: String {
      String(localized: "native.push.urgentBreakthrough", table: "Native", bundle: .module)
    }
    /// Approvals, questions and confirmations are sent as time-sensitive notifications, which a Focus lets through. Turn this off to let your Focus keep them quiet too. Which bots may notify you is chosen per Focus, in the system’s Focus settings.
    static var urgentBreakthroughHint: String {
      String(localized: "native.push.urgentBreakthroughHint", table: "Native", bundle: .module)
    }
    /// Every kind is off, so this device is not told about anything.
    static var noTypeWanted: String {
      String(localized: "native.push.noTypeWanted", table: "Native", bundle: .module)
    }
    /// Hermie cannot read this device’s notification settings, so notifications are paused here.
    static var troubleSettings: String {
      String(localized: "native.push.troubleSettings", table: "Native", bundle: .module)
    }
    /// Hermie cannot read this device’s notification registrations, so notifications are paused here.
    static var troubleRegistrations: String {
      String(localized: "native.push.troubleRegistrations", table: "Native", bundle: .module)
    }
    /// Relay
    static var relay: String { String(localized: "native.push.relay", table: "Native", bundle: .module) }
    /// Waiting for this device’s push address…
    static var waiting: String { String(localized: "native.push.waiting", table: "Native", bundle: .module) }
  }
}
