// Written by `npm run i18n` from contract/i18n/catalogue.json. Do not edit: change the
// TypeScript catalogues in expo/hermie/src/i18n and run it again. See docs/i18n.md.

import Foundation

/// Every string the Expo app has, as typed accessors over `Localizable.xcstrings`.
///
/// The hierarchy mirrors the TypeScript keys: `strings.onboarding.stepCounter(1, 3)` in the
/// `app` table is `Strings.App.Onboarding.stepCounter(current: 1, total: 3)` here. Each read
/// resolves when it is made, in the language the system picked for the app.
public enum Strings {
  public enum App {
    public enum Activity {
      public enum Counters {
        /// Deliveries out
        public static var deliveries: Swift.String { Swift.String(localized: "app.activity.counters.deliveries", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sub-agents
        public static var subagents: Swift.String { Swift.String(localized: "app.activity.counters.subagents", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Bots working
        public static var working: Swift.String { Swift.String(localized: "app.activity.counters.working", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Your bots have not talked to each other yet. When one messages another or delegates a task, it shows up here.
      public static var empty: Swift.String { Swift.String(localized: "app.activity.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing to show while the gateway is out of reach.
      public static var emptyOffline: Swift.String { Swift.String(localized: "app.activity.emptyOffline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The timeline could not be loaded: {message}
      public static func failed(message: Swift.String) -> Swift.String {
        Swift.String(localized: "app.activity.failed", defaultValue: "The timeline could not be loaded: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      public enum GroupStatus {
        /// dispatched
        public static var dispatched: Swift.String { Swift.String(localized: "app.activity.groupStatus.dispatched", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// done
        public static var done: Swift.String { Swift.String(localized: "app.activity.groupStatus.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// failed
        public static var failed: Swift.String { Swift.String(localized: "app.activity.groupStatus.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// running
        public static var running: Swift.String { Swift.String(localized: "app.activity.groupStatus.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The entry for a key that arrives at run time, or nil for one this table does not have.
        public static subscript(key: Swift.String) -> Swift.String? {
          switch key {
          case "dispatched": dispatched
          case "done": done
          case "failed": failed
          case "running": running
          default: nil
          }
        }
      }
      /// Reading every conversation…
      public static var loading: Swift.String { Swift.String(localized: "app.activity.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open the chat with {bot}
      public static func openChat(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "app.activity.openChat", defaultValue: "Open the chat with \(bot)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {from} ↩︎ {to}
      public static func reply(from: Swift.String, to: Swift.String) -> Swift.String {
        Swift.String(localized: "app.activity.reply", defaultValue: "\(from) ↩︎ \(to)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {bot} spawned {count} agents
      public static func spawned(bot: Swift.String, count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.activity.spawned", defaultValue: "\(bot) spawned \(count) agents", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Messages between your bots, and the agents they put to work.
      public static var subtitle: Swift.String { Swift.String(localized: "app.activity.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Activity
      public static var title: Swift.String { Swift.String(localized: "app.activity.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {from} → {to}
      public static func to(from: Swift.String, to: Swift.String) -> Swift.String {
        Swift.String(localized: "app.activity.to", defaultValue: "\(from) → \(to)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Today
      public static var today: Swift.String { Swift.String(localized: "app.activity.today", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Yesterday
      public static var yesterday: Swift.String { Swift.String(localized: "app.activity.yesterday", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum App {
      /// Starting…
      public static var loading: Swift.String { Swift.String(localized: "app.app.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hermie
      public static var name: Swift.String { Swift.String(localized: "app.app.name", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Auth {
      /// This sign-in cannot be refreshed — it ends when its access token expires. The gateway’s provider needs the offline_access scope.
      public static var noRefreshToken: Swift.String { Swift.String(localized: "app.auth.noRefreshToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// How to fix this
      public static var noRefreshTokenLink: Swift.String { Swift.String(localized: "app.auth.noRefreshTokenLink", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum BotProfile {
      /// ABOUT THIS BOT
      public static var about: Swift.String { Swift.String(localized: "app.botProfile.about", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// COLOUR
      public static var colour: Swift.String { Swift.String(localized: "app.botProfile.colour", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This chat only. It tints the bubbles, the avatar ring and the row in the list.
      public static var colourHint: Swift.String { Swift.String(localized: "app.botProfile.colourHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// DESCRIPTION
      public static var description: Swift.String { Swift.String(localized: "app.botProfile.description", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What this bot is for
      public static var descriptionPlaceholder: Swift.String { Swift.String(localized: "app.botProfile.descriptionPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Gateway
      public static var gatewayVersion: Swift.String { Swift.String(localized: "app.botProfile.gatewayVersion", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit profile
      public static var menuItem: Swift.String { Swift.String(localized: "app.botProfile.menuItem", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Model
      public static var model: Swift.String { Swift.String(localized: "app.botProfile.model", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit {name}'s profile
      public static func `open`(name: Swift.String) -> Swift.String {
        Swift.String(localized: "app.botProfile.open", defaultValue: "Edit \(name)'s profile", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// PHOTO
      public static var photo: Swift.String { Swift.String(localized: "app.botProfile.photo", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Choose a photo
      public static var photoChange: Swift.String { Swift.String(localized: "app.botProfile.photoChange", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// That photo could not be uploaded.
      public static var photoFailed: Swift.String { Swift.String(localized: "app.botProfile.photoFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Shown on the chat list, the header and every message this bot sends.
      public static var photoHint: Swift.String { Swift.String(localized: "app.botProfile.photoHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove photo
      public static var photoRemove: Swift.String { Swift.String(localized: "app.botProfile.photoRemove", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Change photo
      public static var photoReplace: Swift.String { Swift.String(localized: "app.botProfile.photoReplace", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Provider
      public static var provider: Swift.String { Swift.String(localized: "app.botProfile.provider", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Save
      public static var save: Swift.String { Swift.String(localized: "app.botProfile.save", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway would not save that.
      public static var saveFailed: Swift.String { Swift.String(localized: "app.botProfile.saveFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Saving…
      public static var saving: Swift.String { Swift.String(localized: "app.botProfile.saving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Session
      public static var session: Swift.String { Swift.String(localized: "app.botProfile.session", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Profile
      public static var title: Swift.String { Swift.String(localized: "app.botProfile.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// —
      public static var unknown: Swift.String { Swift.String(localized: "app.botProfile.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Bots {
      /// {count} conversations
      public static func conversations(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.bots.conversations", defaultValue: "\(count) conversations", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Default
      public static var defaultBot: Swift.String { Swift.String(localized: "app.bots.defaultBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This gateway has no bot profiles yet. Create one with `hermes profile create`.
      public static var empty: Swift.String { Swift.String(localized: "app.bots.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The bot list could not be loaded: {message}
      public static func failed(message: Swift.String) -> Swift.String {
        Swift.String(localized: "app.bots.failed", defaultValue: "The bot list could not be loaded: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Your conversations stay with your gateway.
      public static var footnote: Swift.String { Swift.String(localized: "app.bots.footnote", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reading the roster…
      public static var loading: Swift.String { Swift.String(localized: "app.bots.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open {bot}’s chat at this message
      public static func messageOpen(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "app.bots.messageOpen", defaultValue: "Open \(bot)’s chat at this message", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// IN MESSAGES
      public static var messagesHeader: Swift.String { Swift.String(localized: "app.bots.messagesHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Only the best match per chat is shown.
      public static var messagesHint: Swift.String { Swift.String(localized: "app.bots.messagesHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No messages match.
      public static var messagesNone: Swift.String { Swift.String(localized: "app.bots.messagesNone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Searching messages…
      public static var messagesSearching: Swift.String { Swift.String(localized: "app.bots.messagesSearching", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// More
      public static var moreActions: Swift.String { Swift.String(localized: "app.bots.moreActions", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Needs your input
      public static var needsInput: Swift.String { Swift.String(localized: "app.bots.needsInput", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No conversation matches “{query}”.
      public static func noMatches(query: Swift.String) -> Swift.String {
        Swift.String(localized: "app.bots.noMatches", defaultValue: "No conversation matches “\(query)”.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// No messages yet
      public static var noPreview: Swift.String { Swift.String(localized: "app.bots.noPreview", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Offline — showing the last saved list.
      public static var offline: Swift.String { Swift.String(localized: "app.bots.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// working
      public static var running: Swift.String { Swift.String(localized: "app.bots.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Search chats
      public static var search: Swift.String { Swift.String(localized: "app.bots.search", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// MESSAGES
      public static var section: Swift.String { Swift.String(localized: "app.bots.section", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} shares waiting to send
      public static func sharePending(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.bots.sharePending", defaultValue: "\(count) shares waiting to send", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// CHATS
      public static var sidebarHeader: Swift.String { Swift.String(localized: "app.bots.sidebarHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Gateway: {name}
      public static func switchGateway(name: Swift.String) -> Swift.String {
        Swift.String(localized: "app.bots.switchGateway", defaultValue: "Gateway: \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Choose which gateway this list belongs to
      public static var switchGatewayHint: Swift.String { Swift.String(localized: "app.bots.switchGatewayHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chats
      public static var title: Swift.String { Swift.String(localized: "app.bots.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New
      public static var unread: Swift.String { Swift.String(localized: "app.bots.unread", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} unread messages
      public static func unreadLabel(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.bots.unreadLabel", defaultValue: "\(count) unread messages", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Chat {
      /// Answered: {answer}
      public static func answered(answer: Swift.String) -> Swift.String {
        Swift.String(localized: "app.chat.answered", defaultValue: "Answered: \(answer)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Approval requested
      public static var approvalTitle: Swift.String { Swift.String(localized: "app.chat.approvalTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Attach {
        /// Cancel
        public static var cancel: Swift.String { Swift.String(localized: "app.chat.attach.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Upload failed
        public static var chipFailed: Swift.String { Swift.String(localized: "app.chat.attach.chipFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// No workspace to upload into
        public static var chipNoWorkspace: Swift.String { Swift.String(localized: "app.chat.attach.chipNoWorkspace", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The gateway refused it
        public static var chipRefused: Swift.String { Swift.String(localized: "app.chat.attach.chipRefused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Too large · {megabytes} MB max
        public static func chipTooLarge(megabytes: Swift.Int) -> Swift.String {
          Swift.String(localized: "app.chat.attach.chipTooLarge", defaultValue: "Too large · \(megabytes) MB max", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// The attachment could not be added: {message}
        public static func failed(message: Swift.String) -> Swift.String {
          Swift.String(localized: "app.chat.attach.failed", defaultValue: "The attachment could not be added: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// File
        public static var file: Swift.String { Swift.String(localized: "app.chat.attach.file", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Open Settings
        public static var openSettings: Swift.String { Swift.String(localized: "app.chat.attach.openSettings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie needs access to your photo library to attach an image. Allow it in Settings.
        public static var permission: Swift.String { Swift.String(localized: "app.chat.attach.permission", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Photo library
        public static var photo: Swift.String { Swift.String(localized: "app.chat.attach.photo", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Add an attachment
        public static var title: Swift.String { Swift.String(localized: "app.chat.attach.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The file was not sent. {message}
        public static func uploadFailed(message: Swift.String) -> Swift.String {
          Swift.String(localized: "app.chat.attach.uploadFailed", defaultValue: "The file was not sent. \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Withdrawn
      public static var cancelled: Swift.String { Swift.String(localized: "app.chat.cancelled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The bot has a question
      public static var clarifyTitle: Swift.String { Swift.String(localized: "app.chat.clarifyTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Connection {
        /// Connecting to your gateway…
        public static var connecting: Swift.String { Swift.String(localized: "app.chat.connection.connecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Offline
        public static var offline: Swift.String { Swift.String(localized: "app.chat.connection.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Reconnecting…
        public static var reconnecting: Swift.String { Swift.String(localized: "app.chat.connection.reconnecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Try now
        public static var retry: Swift.String { Swift.String(localized: "app.chat.connection.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Nothing has been said in this chat yet.
      public static var empty: Swift.String { Swift.String(localized: "app.chat.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {message}
      public static func expensiveModel(message: Swift.String) -> Swift.String {
        if message.isEmpty {
          Swift.String(localized: "app.chat.expensiveModel#message-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.chat.expensiveModel#message-nonempty", defaultValue: "\(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// This conversation could not be opened: {message}
      public static func failed(message: Swift.String) -> Swift.String {
        Swift.String(localized: "app.chat.failed", defaultValue: "This conversation could not be opened: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// “{query}” was matched by the gateway, but it is not in the visible text of this chat.
      public static func findExhausted(query: Swift.String) -> Swift.String {
        Swift.String(localized: "app.chat.findExhausted", defaultValue: "“\(query)” was matched by the gateway, but it is not in the visible text of this chat.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// “{query}” is in this chat, further back than it has loaded.
      public static func findMissed(query: Swift.String) -> Swift.String {
        Swift.String(localized: "app.chat.findMissed", defaultValue: "“\(query)” is in this chat, further back than it has loaded.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Loading the conversation…
      public static var hydrating: Swift.String { Swift.String(localized: "app.chat.hydrating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Showing the last saved copy of this conversation.
      public static var offlineCopy: Swift.String { Swift.String(localized: "app.chat.offlineCopy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pick a conversation to start reading.
      public static var pickBot: Swift.String { Swift.String(localized: "app.chat.pickBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Try again
      public static var retry: Swift.String { Swift.String(localized: "app.chat.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send
      public static var send: Swift.String { Swift.String(localized: "app.chat.send", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Setting not changed: {message}
      public static func settingRefused(message: Swift.String) -> Swift.String {
        Swift.String(localized: "app.chat.settingRefused", defaultValue: "Setting not changed: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// This conversation lost its connection to the gateway. It reattaches on the next open.
      public static var stale: Swift.String { Swift.String(localized: "app.chat.stale", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Stop
      public static var stop: Swift.String { Swift.String(localized: "app.chat.stop", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} subagents running
      public static func subagents(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.chat.subagents", defaultValue: "\(count) subagents running", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      public enum Subtitle {
        /// Connecting…
        public static var connecting: Swift.String { Swift.String(localized: "app.chat.subtitle.connecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Delegating…
        public static var delegating: Swift.String { Swift.String(localized: "app.chat.subtitle.delegating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Online
        public static var idle: Swift.String { Swift.String(localized: "app.chat.subtitle.idle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Offline
        public static var offline: Swift.String { Swift.String(localized: "app.chat.subtitle.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Queued
        public static var queued: Swift.String { Swift.String(localized: "app.chat.subtitle.queued", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Reconnecting…
        public static var reconnecting: Swift.String { Swift.String(localized: "app.chat.subtitle.reconnecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Running {tool}…
        public static func running(tool: Swift.String) -> Swift.String {
          Swift.String(localized: "app.chat.subtitle.running", defaultValue: "Running \(tool)…", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Signed out
        public static var signedOut: Swift.String { Swift.String(localized: "app.chat.subtitle.signedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Thinking…
        public static var thinking: Swift.String { Swift.String(localized: "app.chat.subtitle.thinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Typing…
        public static var typing: Swift.String { Swift.String(localized: "app.chat.subtitle.typing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Waiting for you
        public static var waiting: Swift.String { Swift.String(localized: "app.chat.subtitle.waiting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Working…
        public static var working: Swift.String { Swift.String(localized: "app.chat.subtitle.working", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Thinking
      public static var thinking: Swift.String { Swift.String(localized: "app.chat.thinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// running
      public static var toolRunning: Swift.String { Swift.String(localized: "app.chat.toolRunning", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Someone else started a turn…
      public static var unknownAuthor: Swift.String { Swift.String(localized: "app.chat.unknownAuthor", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Common {
      /// Add
      public static var add: Swift.String { Swift.String(localized: "app.common.add", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Back
      public static var back: Swift.String { Swift.String(localized: "app.common.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "app.common.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Continue
      public static var `continue`: Swift.String { Swift.String(localized: "app.common.continue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dismiss
      public static var dismiss: Swift.String { Swift.String(localized: "app.common.dismiss", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Done
      public static var done: Swift.String { Swift.String(localized: "app.common.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing matches that.
      public static var noMatches: Swift.String { Swift.String(localized: "app.common.noMatches", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing to choose from.
      public static var nothingToPick: Swift.String { Swift.String(localized: "app.common.nothingToPick", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open in browser instead
      public static var openInBrowser: Swift.String { Swift.String(localized: "app.common.openInBrowser", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove
      public static var remove: Swift.String { Swift.String(localized: "app.common.remove", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Try again
      public static var retry: Swift.String { Swift.String(localized: "app.common.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Search
      public static var search: Swift.String { Swift.String(localized: "app.common.search", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sign in
      public static var signIn: Swift.String { Swift.String(localized: "app.common.signIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Connection {
      public enum Reauth {
        /// Sign in
        public static var action: Swift.String { Swift.String(localized: "app.connection.reauth.action", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Your session on this gateway has expired.
        public static var message: Swift.String { Swift.String(localized: "app.connection.reauth.message", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Signing in…
        public static var saving: Swift.String { Swift.String(localized: "app.connection.reauth.saving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Update token
        public static var tokenAction: Swift.String { Swift.String(localized: "app.connection.reauth.tokenAction", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Status {
        /// Authenticating…
        public static var authenticating: Swift.String { Swift.String(localized: "app.connection.status.authenticating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Connecting…
        public static var connecting: Swift.String { Swift.String(localized: "app.connection.status.connecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Disconnected
        public static var disconnected: Swift.String { Swift.String(localized: "app.connection.status.disconnected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Not supported
        public static var incompatible: Swift.String { Swift.String(localized: "app.connection.status.incompatible", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Signed out
        public static var needs_signin: Swift.String { Swift.String(localized: "app.connection.status.needs_signin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Offline
        public static var offline: Swift.String { Swift.String(localized: "app.connection.status.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Paused
        public static var paused: Swift.String { Swift.String(localized: "app.connection.status.paused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking the gateway…
        public static var probing: Swift.String { Swift.String(localized: "app.connection.status.probing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Connected
        public static var ready: Swift.String { Swift.String(localized: "app.connection.status.ready", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Reconnecting…
        public static var reconnecting: Swift.String { Swift.String(localized: "app.connection.status.reconnecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
    }
    public enum Errors {
      /// An access proxy answered HTTP {status} before the gateway did. Add its headers under Advanced, or exempt /api/status, /auth/* and /login from it.
      public static func authProxy(status: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.errors.authProxy", defaultValue: "An access proxy answered HTTP \(status) before the gateway did. Add its headers under Advanced, or exempt /api/status, /auth/* and /login from it.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// The WebSocket closed without a reason. A proxy in front of the gateway usually has to be configured to pass WebSocket upgrades through.
      public static var closeAbnormal: Swift.String { Swift.String(localized: "app.errors.closeAbnormal", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway rejected the credentials when the WebSocket opened. Sign in again.
      public static var closeAuth: Swift.String { Swift.String(localized: "app.errors.closeAuth", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chat is switched off on this gateway.
      public static var closeChatOff: Swift.String { Swift.String(localized: "app.errors.closeChatOff", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway does not trust this address. Set its `dashboard.public_url` to the address you entered and restart it.
      public static var closeHost: Swift.String { Swift.String(localized: "app.errors.closeHost", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Another client took this connection over. Close the other client and test again.
      public static var closeTakenOver: Swift.String { Swift.String(localized: "app.errors.closeTakenOver", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This gateway is too old for Hermie. Update Hermes on the gateway.
      public static var incompatible: Swift.String { Swift.String(localized: "app.errors.incompatible", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This looks like a web page, not a gateway.
      public static var landingPage: Swift.String { Swift.String(localized: "app.errors.landingPage", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Could not reach {host}. Check the address, and that the gateway is running and reachable from this device.
      public static func network(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.network", defaultValue: "Could not reach \(host). Check the address, and that the gateway is running and reachable from this device.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Could not reach {host} over https://. It is either not answering there, or serving a certificate this device does not trust. Leave the https:// off and Hermie will try http:// as well.
      public static func networkOverHttps(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.networkOverHttps", defaultValue: "Could not reach \(host) over https://. It is either not answering there, or serving a certificate this device does not trust. Leave the https:// off and Hermie will try http:// as well.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {host} answered, but not like a Hermes gateway. Check the address and any path prefix.
      public static func notHermes(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.notHermes", defaultValue: "\(host) answered, but not like a Hermes gateway. Check the address and any path prefix.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Add the proxy’s credentials
      public static var openFrontDoor: Swift.String { Swift.String(localized: "app.errors.openFrontDoor", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This address only answers on a private network — is this device on the VPN/tailnet?
      public static var privateNetworkOnly: Swift.String { Swift.String(localized: "app.errors.privateNetworkOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway requires a sign-in but reports no identity providers. Configure one on the gateway and try again.
      public static var providersUnavailable: Swift.String { Swift.String(localized: "app.errors.providersUnavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {from} redirected to {to}, which is a different host. Nothing was read from it.
      public static func redirected(from: Swift.String, to: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.redirected", defaultValue: "\(from) redirected to \(to), which is a different host. Nothing was read from it.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// The gateway answered HTTP {status}. It is running but unhealthy; check its logs.
      public static func server(status: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.errors.server", defaultValue: "The gateway answered HTTP \(status). It is running but unhealthy; check its logs.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// The gateway rejected the credentials. Sign in again.
      public static var signedOut: Swift.String { Swift.String(localized: "app.errors.signedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {host} did not answer in time. It may be starting up or behind a slow link.
      public static func timeout(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.timeout", defaultValue: "\(host) did not answer in time. It may be starting up or behind a slow link.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// The secure connection to {host} failed. A self-signed certificate has to be trusted by this device first — or, if the gateway serves plain http there, leave the https:// off and let Hermie find it.
      public static func tls(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.tls", defaultValue: "The secure connection to \(host) failed. A self-signed certificate has to be trusted by this device first — or, if the gateway serves plain http there, leave the https:// off and let Hermie find it.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Something went wrong.
      public static var unknown: Swift.String { Swift.String(localized: "app.errors.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Use {host} instead
      public static func useRedirectTarget(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.errors.useRedirectTarget", defaultValue: "Use \(host) instead", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Gateway {
      /// Connection settings
      public static var connectionSettings: Swift.String { Swift.String(localized: "app.gateway.connectionSettings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {ms} ms
      public static func latency(ms: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.gateway.latency", defaultValue: "\(ms) ms", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// No gateway
      public static var noHost: Swift.String { Swift.String(localized: "app.gateway.noHost", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Layout {
      public enum Accents {
        /// Default
        public static var `default`: Swift.String { Swift.String(localized: "app.layout.accents.default", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Graphite
        public static var graphite: Swift.String { Swift.String(localized: "app.layout.accents.graphite", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Green
        public static var green: Swift.String { Swift.String(localized: "app.layout.accents.green", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Indigo
        public static var indigo: Swift.String { Swift.String(localized: "app.layout.accents.indigo", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Lime
        public static var lime: Swift.String { Swift.String(localized: "app.layout.accents.lime", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Magenta
        public static var magenta: Swift.String { Swift.String(localized: "app.layout.accents.magenta", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Orange
        public static var orange: Swift.String { Swift.String(localized: "app.layout.accents.orange", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Red
        public static var red: Swift.String { Swift.String(localized: "app.layout.accents.red", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Slate
        public static var slate: Swift.String { Swift.String(localized: "app.layout.accents.slate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Teal
        public static var teal: Swift.String { Swift.String(localized: "app.layout.accents.teal", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Violet
        public static var violet: Swift.String { Swift.String(localized: "app.layout.accents.violet", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Archive
      public static var archive: Swift.String { Swift.String(localized: "app.layout.archive", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Archived ({count})
      public static func archived(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.layout.archived", defaultValue: "Archived (\(count))", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Archived · excluded from filters and counts
      public static var archivedPreview: Swift.String { Swift.String(localized: "app.layout.archivedPreview", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Close
      public static var close: Swift.String { Swift.String(localized: "app.layout.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide the chats in {name}
      public static func collapseFolder(name: Swift.String) -> Swift.String {
        if name.isEmpty {
          Swift.String(localized: "app.layout.collapseFolder#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.layout.collapseFolder#name-nonempty", defaultValue: "Hide the chats in \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Colour
      public static var colour: Swift.String { Swift.String(localized: "app.layout.colour", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Colour for {name}
      public static func colourOf(name: Swift.String) -> Swift.String {
        Swift.String(localized: "app.layout.colourOf", defaultValue: "Colour for \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Delete folder
      public static var deleteFolder: Swift.String { Swift.String(localized: "app.layout.deleteFolder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Moving {name}
      public static func dragging(name: Swift.String) -> Swift.String {
        Swift.String(localized: "app.layout.dragging", defaultValue: "Moving \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Show the chats in {name}
      public static func expandFolder(name: Swift.String) -> Swift.String {
        if name.isEmpty {
          Swift.String(localized: "app.layout.expandFolder#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.layout.expandFolder#name-nonempty", defaultValue: "Show the chats in \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Actions for the {name} folder
      public static func folderActions(name: Swift.String) -> Swift.String {
        if name.isEmpty {
          Swift.String(localized: "app.layout.folderActions#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.layout.folderActions#name-nonempty", defaultValue: "Actions for the \(name) folder", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Folder colour
      public static var folderColour: Swift.String { Swift.String(localized: "app.layout.folderColour", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No chats in this folder
      public static var folderEmpty: Swift.String { Swift.String(localized: "app.layout.folderEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Folder name
      public static var folderName: Swift.String { Swift.String(localized: "app.layout.folderName", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Waiting for you
      public static var folderNeedsInput: Swift.String { Swift.String(localized: "app.layout.folderNeedsInput", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} unread
      public static func folderUnread(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.layout.folderUnread", defaultValue: "\(count) unread", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Mark as read
      public static var markRead: Swift.String { Swift.String(localized: "app.layout.markRead", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Move down
      public static var moveDown: Swift.String { Swift.String(localized: "app.layout.moveDown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Move to {folder}
      public static func moveToFolder(folder: Swift.String) -> Swift.String {
        Swift.String(localized: "app.layout.moveToFolder", defaultValue: "Move to \(folder)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Move to folder
      public static var moveToFolderMenu: Swift.String { Swift.String(localized: "app.layout.moveToFolderMenu", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Move up
      public static var moveUp: Swift.String { Swift.String(localized: "app.layout.moveUp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Mute
      public static var mute: Swift.String { Swift.String(localized: "app.layout.mute", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Mute folder
      public static var muteFolder: Swift.String { Swift.String(localized: "app.layout.muteFolder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum MuteFor {
        /// For 1 hour
        public static var _1h: Swift.String { Swift.String(localized: "app.layout.muteFor.1h", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// For 1 week
        public static var _1w: Swift.String { Swift.String(localized: "app.layout.muteFor.1w", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// For 8 hours
        public static var _8h: Swift.String { Swift.String(localized: "app.layout.muteFor.8h", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Until I turn it back on
        public static var forever: Swift.String { Swift.String(localized: "app.layout.muteFor.forever", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public static var muteWeekdays: [Swift.String] {
        [
          Swift.String(localized: "app.layout.muteWeekdays[0]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[1]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[2]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[3]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[4]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[5]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "app.layout.muteWeekdays[6]", table: "Localizable", bundle: HermieStringsLookup.bundle),
        ]
      }
      /// Muted
      public static var muted: Swift.String { Swift.String(localized: "app.layout.muted", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Muted
      public static var mutedRow: Swift.String { Swift.String(localized: "app.layout.mutedRow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Muted until {when}
      public static func mutedUntil(when: Swift.String) -> Swift.String {
        Swift.String(localized: "app.layout.mutedUntil", defaultValue: "Muted until \(when)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Type to rename this folder.
      public static var nameFolderHint: Swift.String { Swift.String(localized: "app.layout.nameFolderHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New folder
      public static var newFolder: Swift.String { Swift.String(localized: "app.layout.newFolder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open
      public static var openChat: Swift.String { Swift.String(localized: "app.layout.openChat", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pin
      public static var pin: Swift.String { Swift.String(localized: "app.layout.pin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pinned
      public static var pinnedRow: Swift.String { Swift.String(localized: "app.layout.pinnedRow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove
      public static var remove: Swift.String { Swift.String(localized: "app.layout.remove", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete the {name} folder
      public static func removeFolder(name: Swift.String) -> Swift.String {
        if name.isEmpty {
          Swift.String(localized: "app.layout.removeFolder#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.layout.removeFolder#name-nonempty", defaultValue: "Delete the \(name) folder", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Rename
      public static var rename: Swift.String { Swift.String(localized: "app.layout.rename", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Actions for {name}
      public static func rowActions(name: Swift.String) -> Swift.String {
        Swift.String(localized: "app.layout.rowActions", defaultValue: "Actions for \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Show sidebar
      public static var showSidebar: Swift.String { Swift.String(localized: "app.layout.showSidebar", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sidebar, hidden
      public static var sidebarRail: Swift.String { Swift.String(localized: "app.layout.sidebarRail", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No folder
      public static var topGroup: Swift.String { Swift.String(localized: "app.layout.topGroup", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unarchive
      public static var unarchive: Swift.String { Swift.String(localized: "app.layout.unarchive", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unmute
      public static var unmute: Swift.String { Swift.String(localized: "app.layout.unmute", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unmute folder
      public static var unmuteFolder: Swift.String { Swift.String(localized: "app.layout.unmuteFolder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Untitled folder
      public static var unnamedFolder: Swift.String { Swift.String(localized: "app.layout.unnamedFolder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unpin
      public static var unpin: Swift.String { Swift.String(localized: "app.layout.unpin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Lock {
      /// Hermie is locked.
      public static var plateBody: Swift.String { Swift.String(localized: "app.lock.plateBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unlock Hermie
      public static var prompt: Swift.String { Swift.String(localized: "app.lock.prompt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hermie is locked, and this device has no passcode or biometric set up to unlock it. Add one in your device settings.
      public static var stranded: Swift.String { Swift.String(localized: "app.lock.stranded", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unlock
      public static var unlock: Swift.String { Swift.String(localized: "app.lock.unlock", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum MenuBar {
      /// Chats
      public static var chats: Swift.String { Swift.String(localized: "app.menuBar.chats", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Close
      public static var close: Swift.String { Swift.String(localized: "app.menuBar.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide Sidebar
      public static var hideSidebar: Swift.String { Swift.String(localized: "app.menuBar.hideSidebar", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New Conversation
      public static var newConversation: Swift.String { Swift.String(localized: "app.menuBar.newConversation", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Search…
      public static var search: Swift.String { Swift.String(localized: "app.menuBar.search", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Settings…
      public static var settings: Swift.String { Swift.String(localized: "app.menuBar.settings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show Sidebar
      public static var showSidebar: Swift.String { Swift.String(localized: "app.menuBar.showSidebar", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Onboarding {
      public enum Address {
        /// Add a header
        public static var addHeader: Swift.String { Swift.String(localized: "app.onboarding.address.addHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Advanced
        public static var advanced: Swift.String { Swift.String(localized: "app.onboarding.address.advanced", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Extra request headers are sent with every call and with the sign-in page. A reverse proxy that wants a shared secret needs it here.
        public static var advancedHint: Swift.String { Swift.String(localized: "app.onboarding.address.advancedHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum FrontDoor {
          /// Client ID
          public static var clientId: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.clientId", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// abc123.access
          public static var clientIdPlaceholder: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.clientIdPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Client Secret
          public static var clientSecret: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.clientSecret", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Cloudflare Access
          public static var cloudflare: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.cloudflare", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// A service token from your Access application. Hermie sends it with every request, the WebSocket and the sign-in page. Exempt /auth/* and /login from the Access policy: a service token cannot carry a redirect-based sign-in through the edge.
          public static var cloudflareHint: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.cloudflareHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Custom headers
          public static var custom: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.custom", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Pick how the proxy in front of your gateway lets Hermie through. Nothing here is sent anywhere but the gateway’s own address.
          public static var hint: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway is reached over http://, so the service token is not being sent — it is a long-lived credential for your whole Access tenant. Use https:// for the address the Access application covers.
          public static var insecure: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.insecure", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// IN FRONT OF THE GATEWAY
          public static var label: Swift.String { Swift.String(localized: "app.onboarding.address.frontDoor.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
        /// Header
        public static var headerName: Swift.String { Swift.String(localized: "app.onboarding.address.headerName", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Value
        public static var headerValue: Swift.String { Swift.String(localized: "app.onboarding.address.headerValue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hide value
        public static var hideValue: Swift.String { Swift.String(localized: "app.onboarding.address.hideValue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Leave the scheme out and Hermie tries https:// first, then http://. Type a scheme yourself to pin it.
        public static var hint: Swift.String { Swift.String(localized: "app.onboarding.address.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// ADDRESS
        public static var label: Swift.String { Swift.String(localized: "app.onboarding.address.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// hermes.example.com
        public static var placeholder: Swift.String { Swift.String(localized: "app.onboarding.address.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking…
        public static var probing: Swift.String { Swift.String(localized: "app.onboarding.address.probing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking https://, then http://…
        public static var probingBoth: Swift.String { Swift.String(localized: "app.onboarding.address.probingBoth", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking {scheme}…
        public static func probingScheme(scheme: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.address.probingScheme", defaultValue: "Checking \(scheme)…", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Remove the {name} header
        public static func removeHeader(name: Swift.String) -> Swift.String {
          if name.isEmpty {
            Swift.String(localized: "app.onboarding.address.removeHeader#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
          } else {
            Swift.String(localized: "app.onboarding.address.removeHeader#name-nonempty", defaultValue: "Remove the \(name) header", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// Hermes {version} · session token required
        public static func sessionTokenRequired(version: Swift.String) -> Swift.String {
          if version.isEmpty {
            Swift.String(localized: "app.onboarding.address.sessionTokenRequired#version-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
          } else {
            Swift.String(localized: "app.onboarding.address.sessionTokenRequired#version-nonempty", defaultValue: "Hermes \(version) · session token required", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// Show value
        public static var showValue: Swift.String { Swift.String(localized: "app.onboarding.address.showValue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermes {version} · sign-in required via {providers|list(", ", " or ")}
        public static func signInRequired(version: Swift.String, providers: [Swift.String]) -> Swift.String {
          if version.isEmpty {
            Swift.String(localized: "app.onboarding.address.signInRequired#version-empty", defaultValue: "Hermes gateway · sign-in required via \(hermieJoinList(providers, Swift.String(localized: "app.onboarding.address.signInRequired#providers.separator", table: "Localizable", bundle: HermieStringsLookup.bundle), Swift.String(localized: "app.onboarding.address.signInRequired#providers.last", table: "Localizable", bundle: HermieStringsLookup.bundle)))", table: "Localizable", bundle: HermieStringsLookup.bundle)
          } else {
            Swift.String(localized: "app.onboarding.address.signInRequired#version-nonempty", defaultValue: "Hermes \(version) · sign-in required via \(hermieJoinList(providers, Swift.String(localized: "app.onboarding.address.signInRequired#providers.separator", table: "Localizable", bundle: HermieStringsLookup.bundle), Swift.String(localized: "app.onboarding.address.signInRequired#providers.last", table: "Localizable", bundle: HermieStringsLookup.bundle)))", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// Hermes {version} · sign-in required, but this gateway lists no identity providers. Configure one on the gateway.
        public static func signInRequiredNoProviders(version: Swift.String) -> Swift.String {
          if version.isEmpty {
            Swift.String(localized: "app.onboarding.address.signInRequiredNoProviders#version-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
          } else {
            Swift.String(localized: "app.onboarding.address.signInRequiredNoProviders#version-nonempty", defaultValue: "Hermes \(version) · sign-in required, but this gateway lists no identity providers. Configure one on the gateway.", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// The address you would open in a browser to reach the gateway dashboard.
        public static var subtitle: Swift.String { Swift.String(localized: "app.onboarding.address.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateway address
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.address.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Done {
        /// Hermie could not store the credentials securely on this device: {reason}
        public static func credentialsNotStored(reason: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.done.credentialsNotStored", defaultValue: "Hermie could not store the credentials securely on this device: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Start chatting
        public static var finish: Swift.String { Swift.String(localized: "app.onboarding.done.finish", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateway
        public static var gateway: Swift.String { Swift.String(localized: "app.onboarding.done.gateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Try again
        public static var retry: Swift.String { Swift.String(localized: "app.onboarding.done.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The settings could not be saved: {message}
        public static func saveFailed(message: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.done.saveFailed", defaultValue: "The settings could not be saved: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Saving…
        public static var saving: Swift.String { Swift.String(localized: "app.onboarding.done.saving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie will store the gateway address on this device and the credentials in the system secret store.
        public static var subtitle: Swift.String { Swift.String(localized: "app.onboarding.done.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie will remember this gateway in this browser. The session itself stays where the gateway put it — in a cookie Hermie cannot read.
        public static var subtitleCookie: Swift.String { Swift.String(localized: "app.onboarding.done.subtitleCookie", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Ready
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.done.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Notifications {
        /// Copied
        public static var copied: Swift.String { Swift.String(localized: "app.onboarding.notifications.copied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Copy
        public static var copy: Swift.String { Swift.String(localized: "app.onboarding.notifications.copy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Permission was refused. You can turn it on later in your device settings.
        public static var denied: Swift.String { Swift.String(localized: "app.onboarding.notifications.denied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Turn on notifications
        public static var enable: Swift.String { Swift.String(localized: "app.onboarding.notifications.enable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Notifications are on for this device.
        public static var enabled: Swift.String { Swift.String(localized: "app.onboarding.notifications.enabled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Asking…
        public static var enabling: Swift.String { Swift.String(localized: "app.onboarding.notifications.enabling", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Already running Hermie Web with --push? That keeps working, and you can turn notifications on now. Do not run both — they would notify this device twice.
        public static var fallback: Swift.String { Swift.String(localized: "app.onboarding.notifications.fallback", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Open guide
        public static var guide: Swift.String { Swift.String(localized: "app.onboarding.notifications.guide", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// ON THE GATEWAY
        public static var install: Swift.String { Swift.String(localized: "app.onboarding.notifications.install", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie never talks to the plugin. It reads what your gateway already knows, so there is no second address and nothing new to expose.
        public static var missingHint: Swift.String { Swift.String(localized: "app.onboarding.notifications.missingHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This gateway has no Hermie plugin, so nothing there can send a notification. It installs with two commands on the machine running `hermes serve`.
        public static var missingSubtitle: Swift.String { Swift.String(localized: "app.onboarding.notifications.missingSubtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Get push notifications
        public static var missingTitle: Swift.String { Swift.String(localized: "app.onboarding.notifications.missingTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// You can turn this on later in Settings.
        public static var skip: Swift.String { Swift.String(localized: "app.onboarding.notifications.skip", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Your gateway can tell this device when a bot answers, asks for something, or finishes a long task.
        public static var subtitle: Swift.String { Swift.String(localized: "app.onboarding.notifications.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Notifications
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.notifications.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum SignIn {
        /// It requires a sign-in but does not advertise the native_pkce flow, which is the only one a mobile app can complete. Update Hermes on the gateway.
        public static var blockedBody: Swift.String { Swift.String(localized: "app.onboarding.signIn.blockedBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This gateway is too old for native sign-in
        public static var blockedTitle: Swift.String { Swift.String(localized: "app.onboarding.signIn.blockedTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking whether you are already signed in…
        public static var checkingSession: Swift.String { Swift.String(localized: "app.onboarding.signIn.checkingSession", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Provider
        public static var chooseProvider: Swift.String { Swift.String(localized: "app.onboarding.signIn.chooseProvider", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// It requires a sign-in but does not advertise the cookie flow, which is the only one a browser tab can complete. Update Hermes on the gateway.
        public static var cookieBlockedBody: Swift.String { Swift.String(localized: "app.onboarding.signIn.cookieBlockedBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This gateway is too old for browser sign-in
        public static var cookieBlockedTitle: Swift.String { Swift.String(localized: "app.onboarding.signIn.cookieBlockedTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hide password
        public static var hidePassword: Swift.String { Swift.String(localized: "app.onboarding.signIn.hidePassword", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hide token
        public static var hideToken: Swift.String { Swift.String(localized: "app.onboarding.signIn.hideToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Taking you to the sign-in page…
        public static var leavingForProvider: Swift.String { Swift.String(localized: "app.onboarding.signIn.leavingForProvider", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// PASSWORD
        public static var passwordSecret: Swift.String { Swift.String(localized: "app.onboarding.signIn.passwordSecret", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Password
        public static var passwordSecretLabel: Swift.String { Swift.String(localized: "app.onboarding.signIn.passwordSecretLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign in
        public static var passwordSubmit: Swift.String { Swift.String(localized: "app.onboarding.signIn.passwordSubmit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// USER NAME
        public static var passwordUser: Swift.String { Swift.String(localized: "app.onboarding.signIn.passwordUser", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// User name
        public static var passwordUserLabel: Swift.String { Swift.String(localized: "app.onboarding.signIn.passwordUserLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Reading the gateway…
        public static var probingGateway: Swift.String { Swift.String(localized: "app.onboarding.signIn.probingGateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Served by Hermie Web, talking to {host}.
        public static func servedFrom(host: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.signIn.servedFrom", defaultValue: "Served by Hermie Web, talking to \(host).", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Served by Hermie Web.
        public static var servedFromUnknown: Swift.String { Swift.String(localized: "app.onboarding.signIn.servedFromUnknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Show password
        public static var showPassword: Swift.String { Swift.String(localized: "app.onboarding.signIn.showPassword", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Show token
        public static var showToken: Swift.String { Swift.String(localized: "app.onboarding.signIn.showToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign in with {provider}
        public static func signInWith(provider: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.signIn.signInWith", defaultValue: "Sign in with \(provider)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Sign in again
        public static var signOutAndRetry: Swift.String { Swift.String(localized: "app.onboarding.signIn.signOutAndRetry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign out
        public static var signOutOfSession: Swift.String { Swift.String(localized: "app.onboarding.signIn.signOutOfSession", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Signed in
        public static var signedIn: Swift.String { Swift.String(localized: "app.onboarding.signIn.signedIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Signed in as {user}
        public static func signedInAs(user: Swift.String) -> Swift.String {
          Swift.String(localized: "app.onboarding.signIn.signedInAs", defaultValue: "Signed in as \(user)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Sign-in with SSO is turned off on this Hermie Web. Ask whoever runs it to sign you in another way.
        public static var ssoOff: Swift.String { Swift.String(localized: "app.onboarding.signIn.ssoOff", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The gateway hosts the sign-in page. Your browser keeps the session it hands back; Hermie never sees it.
        public static var subtitleCookie: Swift.String { Swift.String(localized: "app.onboarding.signIn.subtitleCookie", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The gateway hosts the sign-in page. Hermie opens it, reads the result and keeps the tokens on this device.
        public static var subtitleNative: Swift.String { Swift.String(localized: "app.onboarding.signIn.subtitleNative", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This gateway is not gated by an identity provider; it authenticates with the session token it prints at startup.
        public static var subtitleToken: Swift.String { Swift.String(localized: "app.onboarding.signIn.subtitleToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign in
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.signIn.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// It authenticates with a session token, and a browser tab has nowhere safe to keep one — anything running in the page could read it. Use the Hermie app, or put the gateway behind an identity provider so it can issue a browser session.
        public static var tokenBlockedBody: Swift.String { Swift.String(localized: "app.onboarding.signIn.tokenBlockedBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This gateway cannot be used from a browser
        public static var tokenBlockedTitle: Swift.String { Swift.String(localized: "app.onboarding.signIn.tokenBlockedTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Paste the session token printed by `hermes serve`.
        public static var tokenHelp: Swift.String { Swift.String(localized: "app.onboarding.signIn.tokenHelp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// SESSION TOKEN
        public static var tokenLabel: Swift.String { Swift.String(localized: "app.onboarding.signIn.tokenLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Session token
        public static var tokenPlaceholder: Swift.String { Swift.String(localized: "app.onboarding.signIn.tokenPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum Webview {
          /// Sign-in was cancelled.
          public static var cancelled: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.cancelled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Open the sign-in page in your browser, then paste the address it fails to open back here. You can go back and use the in-app page instead.
          public static var chosen: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.chosen", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Completing sign-in…
          public static var exchanging: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.exchanging", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The browser will fail to load a 127.0.0.1 address — that is expected. Copy it out of the address bar and paste it here.
          public static var fallbackHelp: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.fallbackHelp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Failed address
          public static var fallbackLabel: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.fallbackLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// http://127.0.0.1:38007/callback?code=…
          public static var fallbackPlaceholder: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.fallbackPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Use this address
          public static var fallbackSubmit: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.fallbackSubmit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway needs extra headers, and Android’s in-app browser would forward them to your identity provider. Sign in in your browser instead, then paste the address it fails to open back here.
          public static var headersWithheld: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.headersWithheld", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The sign-in page answered HTTP {status}. Check the gateway's public address.
          public static func httpError(status: Swift.Int) -> Swift.String {
            Swift.String(localized: "app.onboarding.signIn.webview.httpError", defaultValue: "The sign-in page answered HTTP \(status). Check the gateway's public address.", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// The sign-in page could not be loaded: {message}
          public static func loadError(message: Swift.String) -> Swift.String {
            Swift.String(localized: "app.onboarding.signIn.webview.loadError", defaultValue: "The sign-in page could not be loaded: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// Opening the sign-in page…
          public static var loading: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The sign-in finished without an authorization code. Start the sign-in again.
          public static var noCode: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.noCode", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The gateway refused the sign-in: {description} ({error})
          public static func providerError(error: Swift.String, description: Swift.String) -> Swift.String {
            if description.isEmpty {
              Swift.String(localized: "app.onboarding.signIn.webview.providerError#description-empty", defaultValue: "The gateway refused the sign-in: \(error)", table: "Localizable", bundle: HermieStringsLookup.bundle)
            } else {
              Swift.String(localized: "app.onboarding.signIn.webview.providerError#description-nonempty", defaultValue: "\(error) \(description)", table: "Localizable", bundle: HermieStringsLookup.bundle)
            }
          }
          /// The sign-in response did not belong to this attempt and was discarded. Start the sign-in again.
          public static var stateMismatch: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.stateMismatch", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The sign-in page was open for ten minutes without finishing. Start again when you are ready.
          public static var timeout: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.timeout", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Sign in
          public static var title: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The in-app browser is not available on this platform. Open the sign-in page in your browser, then paste the address it fails to open back here.
          public static var unavailable: Swift.String { Swift.String(localized: "app.onboarding.signIn.webview.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
      }
      /// Step {current} of {total}
      public static func stepCounter(current: Swift.Int, total: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.onboarding.stepCounter", defaultValue: "Step \(current) of \(total)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      public enum Test {
        public enum Checklist {
          /// Profiles
          public static var profiles: Swift.String { Swift.String(localized: "app.onboarding.test.checklist.profiles", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// REST
          public static var rest: Swift.String { Swift.String(localized: "app.onboarding.test.checklist.rest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// WebSocket
          public static var socket: Swift.String { Swift.String(localized: "app.onboarding.test.checklist.socket", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
        /// Connected · {bots} bots
        public static func connected(bots: Swift.Int) -> Swift.String {
          Swift.String(localized: "app.onboarding.test.connected", defaultValue: "Connected · \(bots) bots", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Connected as {user} · {bots} bots
        public static func connectedAs(user: Swift.String, bots: Swift.Int) -> Swift.String {
          Swift.String(localized: "app.onboarding.test.connectedAs", defaultValue: "Connected as \(user) · \(bots) bots", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Something changed since the last test, so it is running again.
        public static var invalidated: Swift.String { Swift.String(localized: "app.onboarding.test.invalidated", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The connection works, but this gateway has no bot profiles yet.
        public static var noBots: Swift.String { Swift.String(localized: "app.onboarding.test.noBots", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The connection has not been tested yet.
        public static var required: Swift.String { Swift.String(localized: "app.onboarding.test.required", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Try again
        public static var retry: Swift.String { Swift.String(localized: "app.onboarding.test.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Testing…
        public static var running: Swift.String { Swift.String(localized: "app.onboarding.test.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie checks the REST surface and then opens the WebSocket, exactly as it will during use.
        public static var subtitle: Swift.String { Swift.String(localized: "app.onboarding.test.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Test connection
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.test.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Welcome {
        /// Set up a gateway
        public static var action: Swift.String { Swift.String(localized: "app.onboarding.welcome.action", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie is a client for Hermes Agent. It talks to one gateway at a time — the machine running `hermes serve` — and chats with the bots that live there.
        public static var body: Swift.String { Swift.String(localized: "app.onboarding.welcome.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Nothing is stored until the connection has been tested.
        public static var note: Swift.String { Swift.String(localized: "app.onboarding.welcome.note", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Welcome to Hermie
        public static var title: Swift.String { Swift.String(localized: "app.onboarding.welcome.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
    }
    public enum Presence {
      /// Needs input
      public static var needsInput: Swift.String { Swift.String(localized: "app.presence.needsInput", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Offline
      public static var offline: Swift.String { Swift.String(localized: "app.presence.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Offline · last seen {time}
      public static func offlineSince(time: Swift.String) -> Swift.String {
        Swift.String(localized: "app.presence.offlineSince", defaultValue: "Offline · last seen \(time)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Online
      public static var online: Swift.String { Swift.String(localized: "app.presence.online", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Working…
      public static var working: Swift.String { Swift.String(localized: "app.presence.working", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Settings {
      /// About
      public static var about: Swift.String { Swift.String(localized: "app.settings.about", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Account
      public static var account: Swift.String { Swift.String(localized: "app.settings.account", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Address
      public static var address: Swift.String { Swift.String(localized: "app.settings.address", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Appearance
      public static var appearance: Swift.String { Swift.String(localized: "app.settings.appearance", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Session token
      public static var authModeToken: Swift.String { Swift.String(localized: "app.settings.authModeToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum BotNameOptions {
        /// Display name
        public static var display: Swift.String { Swift.String(localized: "app.settings.botNameOptions.display", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Profile name
        public static var profile: Swift.String { Swift.String(localized: "app.settings.botNameOptions.profile", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Bot names
      public static var botNames: Swift.String { Swift.String(localized: "app.settings.botNames", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Which name is the large one. The profile name is what the rest of the app addresses a bot by; the display name is the label set on the gateway. A bot with only one of them shows one line. Only used while Hide profile name, below, is off.
      public static var botNamesHint: Swift.String { Swift.String(localized: "app.settings.botNamesHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What your bots can reach
      public static var capabilityReach: Swift.String { Swift.String(localized: "app.settings.capabilityReach", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Categories {
        /// About
        public static var about: Swift.String { Swift.String(localized: "app.settings.categories.about", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Account
        public static var account: Swift.String { Swift.String(localized: "app.settings.categories.account", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Advanced
        public static var advanced: Swift.String { Swift.String(localized: "app.settings.categories.advanced", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Appearance
        public static var appearance: Swift.String { Swift.String(localized: "app.settings.categories.appearance", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum Blurb {
          /// Which Hermie this is, and the licences it ships under.
          public static var about: Swift.String { Swift.String(localized: "app.settings.categories.blurb.about", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Who this device is signed in as, and the ways of leaving.
          public static var account: Swift.String { Swift.String(localized: "app.settings.categories.blurb.account", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Hermie Web’s own updates, and the tools for building the app.
          public static var advanced: Swift.String { Swift.String(localized: "app.settings.categories.blurb.advanced", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Light or dark, the language, the text size and the theme.
          public static var appearance: Swift.String { Swift.String(localized: "app.settings.categories.blurb.appearance", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The skills, servers and boards your bots can reach.
          public static var capabilities: Swift.String { Swift.String(localized: "app.settings.categories.blurb.capabilities", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// What a new conversation shows, and how a bot is addressed.
          public static var chats: Swift.String { Swift.String(localized: "app.settings.categories.blurb.chats", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Which gateway this is, and how it is doing.
          public static var gateway: Swift.String { Swift.String(localized: "app.settings.categories.blurb.gateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The gateway this device talks to, and the others it knows about.
          public static var gateways: Swift.String { Swift.String(localized: "app.settings.categories.blurb.gateways", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// What each bot remembers between conversations.
          public static var memory: Swift.String { Swift.String(localized: "app.settings.categories.blurb.memory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// When a bot may reach you, and how much a notification says.
          public static var notifications: Swift.String { Swift.String(localized: "app.settings.categories.blurb.notifications", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// The lock on this device, and what it takes to open it.
          public static var privacy: Swift.String { Swift.String(localized: "app.settings.categories.blurb.privacy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// How Hermie reads a reply out, and how it hears you.
          public static var voice: Swift.String { Swift.String(localized: "app.settings.categories.blurb.voice", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
        /// Bots & capabilities
        public static var capabilities: Swift.String { Swift.String(localized: "app.settings.categories.capabilities", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Chats & messages
        public static var chats: Swift.String { Swift.String(localized: "app.settings.categories.chats", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateway
        public static var gateway: Swift.String { Swift.String(localized: "app.settings.categories.gateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateways
        public static var gateways: Swift.String { Swift.String(localized: "app.settings.categories.gateways", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Memory
        public static var memory: Swift.String { Swift.String(localized: "app.settings.categories.memory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Notifications
        public static var notifications: Swift.String { Swift.String(localized: "app.settings.categories.notifications", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Privacy & security
        public static var privacy: Swift.String { Swift.String(localized: "app.settings.categories.privacy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum Summary {
          /// {count} bots
          public static func bots(count: Swift.Int) -> Swift.String {
            Swift.String(localized: "app.settings.categories.summary.bots", defaultValue: "\(count) bots", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// Skills · MCP · Connectors
          public static var capabilities: Swift.String { Swift.String(localized: "app.settings.categories.summary.capabilities", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Developer
          public static var developer: Swift.String { Swift.String(localized: "app.settings.categories.summary.developer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// {host}
          public static func gateway(host: Swift.String) -> Swift.String {
            Swift.String(localized: "app.settings.categories.summary.gateway", defaultValue: "\(host)", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// {host} · {count} gateways
          public static func gateways(host: Swift.String, count: Swift.Int) -> Swift.String {
            Swift.String(localized: "app.settings.categories.summary.gateways", defaultValue: "\(host) · \(count) gateways", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// Not in a browser
          public static var lockBrowser: Swift.String { Swift.String(localized: "app.settings.categories.summary.lockBrowser", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// On · {count} kinds
          public static func notificationKinds(count: Swift.Int) -> Swift.String {
            Swift.String(localized: "app.settings.categories.summary.notificationKinds", defaultValue: "On · \(count) kinds", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
          /// Off
          public static var off: Swift.String { Swift.String(localized: "app.settings.categories.summary.off", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// On
          public static var on: Swift.String { Swift.String(localized: "app.settings.categories.summary.on", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Not signed in
          public static var signedOut: Swift.String { Swift.String(localized: "app.settings.categories.summary.signedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Version {version}
          public static func version(version: Swift.String) -> Swift.String {
            Swift.String(localized: "app.settings.categories.summary.version", defaultValue: "Version \(version)", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// Voice
        public static var voice: Swift.String { Swift.String(localized: "app.settings.categories.voice", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Change gateway
      public static var changeGateway: Swift.String { Swift.String(localized: "app.settings.changeGateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Forget this gateway and everything stored for it?
      public static var changeGatewayConfirm: Swift.String { Swift.String(localized: "app.settings.changeGatewayConfirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reopens setup with this address filled in. Nothing stored is dropped until a different gateway is applied.
      public static var changeGatewayHint: Swift.String { Swift.String(localized: "app.settings.changeGatewayHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chat
      public static var chat: Swift.String { Swift.String(localized: "app.settings.chat", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chat text size
      public static var chatTextSize: Swift.String { Swift.String(localized: "app.settings.chatTextSize", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Applies to the words in a conversation, on top of the device’s own text size. The rest of the app follows the device.
      public static var chatTextSizeHint: Swift.String { Swift.String(localized: "app.settings.chatTextSizeHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Forget it
      public static var confirm: Swift.String { Swift.String(localized: "app.settings.confirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connection test
      public static var connectionTest: Swift.String { Swift.String(localized: "app.settings.connectionTest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Default verbosity
      public static var defaultVerbosity: Swift.String { Swift.String(localized: "app.settings.defaultVerbosity", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// How much of a bot’s working-out a new conversation shows. A conversation with its own setting keeps it.
      public static var defaultVerbosityHint: Swift.String { Swift.String(localized: "app.settings.defaultVerbosityHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Developer
      public static var developer: Swift.String { Swift.String(localized: "app.settings.developer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Email
      public static var email: Swift.String { Swift.String(localized: "app.settings.email", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Forget this gateway
      public static var forgetGateway: Swift.String { Swift.String(localized: "app.settings.forgetGateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Deletes the address and the credentials from this device and starts setup empty.
      public static var forgetGatewayHint: Swift.String { Swift.String(localized: "app.settings.forgetGatewayHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Gateway
      public static var gateway: Swift.String { Swift.String(localized: "app.settings.gateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Gateways {
        /// Connected
        public static var active: Swift.String { Swift.String(localized: "app.settings.gateways.active", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Add gateway
        public static var add: Swift.String { Swift.String(localized: "app.settings.gateways.add", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Runs setup for another machine. The gateway you are on now stays connected until you switch.
        public static var addHint: Swift.String { Swift.String(localized: "app.settings.gateways.addHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Session token
        public static var authModeToken: Swift.String { Swift.String(localized: "app.settings.gateways.authModeToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateways
        public static var back: Swift.String { Swift.String(localized: "app.settings.gateways.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Connect to this gateway
        public static var connect: Swift.String { Swift.String(localized: "app.settings.gateways.connect", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie disconnects from the gateway it is on and dials this one.
        public static var connectHint: Swift.String { Swift.String(localized: "app.settings.gateways.connectHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateway
        public static var detailTitle: Swift.String { Swift.String(localized: "app.settings.gateways.detailTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateways
        public static var header: Swift.String { Swift.String(localized: "app.settings.gateways.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Tap a gateway to connect to it. Hermie talks to one at a time; the others keep their conversations and their notifications.
        public static var hint: Swift.String { Swift.String(localized: "app.settings.gateways.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Keep it
        public static var keepIt: Swift.String { Swift.String(localized: "app.settings.gateways.keepIt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Manage
        public static var manage: Swift.String { Swift.String(localized: "app.settings.gateways.manage", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Name
        public static var name: Swift.String { Swift.String(localized: "app.settings.gateways.name", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// What this gateway is called on this device. It is not sent anywhere.
        public static var nameHint: Swift.String { Swift.String(localized: "app.settings.gateways.nameHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Remove this gateway
        public static var remove: Swift.String { Swift.String(localized: "app.settings.gateways.remove", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Remove this gateway and everything stored for it on this device?
        public static var removeConfirm: Swift.String { Swift.String(localized: "app.settings.gateways.removeConfirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Remove it
        public static var removeConfirmAction: Swift.String { Swift.String(localized: "app.settings.gateways.removeConfirmAction", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Forgets its address, its credentials, its conversations and its settings on this device.
        public static var removeHint: Swift.String { Swift.String(localized: "app.settings.gateways.removeHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// If this gateway is not the one Hermie is connected to, its notifications stop when it next tries to reach this device rather than straight away.
        public static var removeNotifyNote: Swift.String { Swift.String(localized: "app.settings.gateways.removeNotifyNote", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateways
        public static var row: Swift.String { Swift.String(localized: "app.settings.gateways.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// {count} gateways
        public static func rowHint(count: Swift.Int) -> Swift.String {
          Swift.String(localized: "app.settings.gateways.rowHint", defaultValue: "\(count) gateways", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Save
        public static var save: Swift.String { Swift.String(localized: "app.settings.gateways.save", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign out of this gateway
        public static var signOut: Swift.String { Swift.String(localized: "app.settings.gateways.signOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Clears its stored credentials and keeps its address.
        public static var signOutHint: Swift.String { Swift.String(localized: "app.settings.gateways.signOutHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Signed in as {user}
        public static func signedInAs(user: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.gateways.signedInAs", defaultValue: "Signed in as \(user)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Signed out
        public static var signedOut: Swift.String { Swift.String(localized: "app.settings.gateways.signedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateways
        public static var title: Swift.String { Swift.String(localized: "app.settings.gateways.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Use this gateway
        public static var use: Swift.String { Swift.String(localized: "app.settings.gateways.use", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Hide profile name
      public static var hideHandle: Swift.String { Swift.String(localized: "app.settings.hideHandle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// When a bot has a display name, show only that — the profile name it is otherwise shown with drops off the second line. A bot with no display name keeps its one name either way.
      public static var hideHandleHint: Swift.String { Swift.String(localized: "app.settings.hideHandleHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Host
      public static var host: Swift.String { Swift.String(localized: "app.settings.host", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Keep it
      public static var keepIt: Swift.String { Swift.String(localized: "app.settings.keepIt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Language
      public static var language: Swift.String { Swift.String(localized: "app.settings.language", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Follow device
      public static var languageFollowDevice: Swift.String { Swift.String(localized: "app.settings.languageFollowDevice", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hermie is written in English. Dutch and German are translations of it, and anything not yet translated stays in English.
      public static var languageHint: Swift.String { Swift.String(localized: "app.settings.languageHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Licences
      public static var licences: Swift.String { Swift.String(localized: "app.settings.licences", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Back to settings
      public static var licencesBack: Swift.String { Swift.String(localized: "app.settings.licencesBack", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The licence list could not be loaded: {message}
      public static func licencesFailed(message: Swift.String) -> Swift.String {
        Swift.String(localized: "app.settings.licencesFailed", defaultValue: "The licence list could not be loaded: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Generated by {script}, alongside THIRD_PARTY_LICENSES.md.
      public static func licencesGeneratedBy(script: Swift.String) -> Swift.String {
        Swift.String(localized: "app.settings.licencesGeneratedBy", defaultValue: "Generated by \(script), alongside THIRD_PARTY_LICENSES.md.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// The open-source packages Hermie is built from, and what each one asks for.
      public static var licencesHint: Swift.String { Swift.String(localized: "app.settings.licencesHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Loading the licences…
      public static var licencesLoading: Swift.String { Swift.String(localized: "app.settings.licencesLoading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This package ships no licence file. The identifier above is everything it declares.
      public static var licencesNoText: Swift.String { Swift.String(localized: "app.settings.licencesNoText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Try again
      public static var licencesRetry: Swift.String { Swift.String(localized: "app.settings.licencesRetry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Production dependencies only; development tooling and Hermie's own {excluded} workspace packages are not in the list.
      public static func licencesScope(excluded: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.settings.licencesScope", defaultValue: "Production dependencies only; development tooling and Hermie's own \(excluded) workspace packages are not in the list.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {count} packages ship inside Hermie. Tap one to read its licence.
      public static func licencesSummary(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "app.settings.licencesSummary", defaultValue: "\(count) packages ship inside Hermie. Tap one to read its licence.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// no licence declared
      public static var licencesUndeclared: Swift.String { Swift.String(localized: "app.settings.licencesUndeclared", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Lock {
        /// Ask for Face ID, Touch ID or this device’s passcode before Hermie can be read. This setting stays on this device.
        public static var hint: Swift.String { Swift.String(localized: "app.settings.lock.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie asks again after it has been away for this long, and always after it has been started fresh. This setting stays on this device.
        public static var hintOn: Swift.String { Swift.String(localized: "app.settings.lock.hintOn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Require unlock
        public static var label: Swift.String { Swift.String(localized: "app.settings.lock.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Set up a passcode, Face ID or a fingerprint in your device settings first — otherwise Hermie would lock with no way to open it.
        public static var noEnrolment: Swift.String { Swift.String(localized: "app.settings.lock.noEnrolment", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum Options {
          /// 15 min
          public static var _15m: Swift.String { Swift.String(localized: "app.settings.lock.options.15m", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// 1 min
          public static var _1m: Swift.String { Swift.String(localized: "app.settings.lock.options.1m", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// 5 min
          public static var _5m: Swift.String { Swift.String(localized: "app.settings.lock.options.5m", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Now
          public static var immediately: Swift.String { Swift.String(localized: "app.settings.lock.options.immediately", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Off
          public static var off: Swift.String { Swift.String(localized: "app.settings.lock.options.off", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
        /// No biometrics are enrolled, so Hermie will ask for this device’s passcode.
        public static var passcodeOnly: Swift.String { Swift.String(localized: "app.settings.lock.passcodeOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie could not confirm it was you, so nothing changed. Choose the option again to try once more.
        public static var refused: Swift.String { Swift.String(localized: "app.settings.lock.refused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This device has no unlock method Hermie can ask for.
        public static var unavailable: Swift.String { Swift.String(localized: "app.settings.lock.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie cannot lock itself in a browser: the page and anything enforcing a lock are the same code. Lock the screen or close the tab.
        public static var web: Swift.String { Swift.String(localized: "app.settings.lock.web", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Notifications {
        /// Notifications are turned off for Hermie in your device settings. Turn them on there first.
        public static var denied: Swift.String { Swift.String(localized: "app.settings.notifications.denied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Notifications
        public static var enabled: Swift.String { Swift.String(localized: "app.settings.notifications.enabled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The Hermie plugin runs inside your gateway and sends a notification when a bot has news. Hermie Web with --push does the same job from outside, if a plugin cannot be installed.
        public static var enabledHint: Swift.String { Swift.String(localized: "app.settings.notifications.enabledHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Notifications
        public static var header: Swift.String { Swift.String(localized: "app.settings.notifications.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Open Notifications settings
        public static var openSystemSettings: Swift.String { Swift.String(localized: "app.settings.notifications.openSystemSettings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie stays switched on here and registers as soon as macOS allows it.
        public static var openSystemSettingsHint: Swift.String { Swift.String(localized: "app.settings.notifications.openSystemSettingsHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Show a preview
        public static var preview: Swift.String { Swift.String(localized: "app.settings.notifications.preview", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Off, a notification says which bot and what happened. On, it carries the message as well — and a lock screen is where it will be read.
        public static var previewHint: Swift.String { Swift.String(localized: "app.settings.notifications.previewHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Retry
        public static var retry: Swift.String { Swift.String(localized: "app.settings.notifications.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Asks for permission again and re-requests a push token.
        public static var retryHint: Swift.String { Swift.String(localized: "app.settings.notifications.retryHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Registration
        public static var status: Swift.String { Swift.String(localized: "app.settings.notifications.status", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Permission denied. Turn notifications on for Hermie in your device settings.
        public static var statusDenied: Swift.String { Swift.String(localized: "app.settings.notifications.statusDenied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Token request failed: {message}
        public static func statusFailed(message: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.notifications.statusFailed", defaultValue: "Token request failed: \(message)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// This build has no EAS project id, so it cannot be given a push token. It needs rebuilding.
        public static var statusNoProject: Swift.String { Swift.String(localized: "app.settings.notifications.statusNoProject", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Off. This device is not registered.
        public static var statusOff: Swift.String { Swift.String(localized: "app.settings.notifications.statusOff", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Asking the platform for an address…
        public static var statusPending: Swift.String { Swift.String(localized: "app.settings.notifications.statusPending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Registered · …{tail}
        public static func statusRegistered(tail: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.notifications.statusRegistered", defaultValue: "Registered · …\(tail)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Turn on notifications for Hermie in System Settings → Notifications
        public static var statusSystemSettings: Swift.String { Swift.String(localized: "app.settings.notifications.statusSystemSettings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This device cannot register: {detail}
        public static func statusUnsupported(detail: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.notifications.statusUnsupported", defaultValue: "This device cannot register: \(detail)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Routines
        public static var typeCron: Swift.String { Swift.String(localized: "app.settings.notifications.typeCron", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A routine finished
        public static var typeCronDone: Swift.String { Swift.String(localized: "app.settings.notifications.typeCronDone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A routine failed
        public static var typeCronFailed: Swift.String { Swift.String(localized: "app.settings.notifications.typeCronFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// New message
        public static var typeMessage: Swift.String { Swift.String(localized: "app.settings.notifications.typeMessage", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Needs input
        public static var typeRequest: Swift.String { Swift.String(localized: "app.settings.notifications.typeRequest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Finished working
        public static var typeTurnDone: Swift.String { Swift.String(localized: "app.settings.notifications.typeTurnDone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Something went wrong
        public static var typeTurnFailed: Swift.String { Swift.String(localized: "app.settings.notifications.typeTurnFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Tell me about
        public static var types: Swift.String { Swift.String(localized: "app.settings.notifications.types", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A bot answering, a bot asking permission, a routine’s delivery, how a scheduled run ended, and a long task reaching its end either way. A turn you stopped yourself is never one of these.
        public static var typesHint: Swift.String { Swift.String(localized: "app.settings.notifications.typesHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This device cannot register for notifications. Nothing has been sent.
        public static var unavailable: Swift.String { Swift.String(localized: "app.settings.notifications.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The browser only offers notifications when Hermie Web is served over https.
        public static var webInsecure: Swift.String { Swift.String(localized: "app.settings.notifications.webInsecure", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Plugin
      public static var plugin: Swift.String { Swift.String(localized: "app.settings.plugin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Not installed
      public static var pluginAbsent: Swift.String { Swift.String(localized: "app.settings.pluginAbsent", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hermie plugin {version}
      public static func pluginInstalled(version: Swift.String) -> Swift.String {
        if version.isEmpty {
          Swift.String(localized: "app.settings.pluginInstalled#version-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.settings.pluginInstalled#version-nonempty", defaultValue: "Hermie plugin \(version)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Checking…
      public static var pluginUnknown: Swift.String { Swift.String(localized: "app.settings.pluginUnknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Port
      public static var port: Swift.String { Swift.String(localized: "app.settings.port", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// THEME
      public static var preset: Swift.String { Swift.String(localized: "app.settings.preset", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Each theme has a light and a dark face; the setting above picks which one is showing.
      public static var presetHint: Swift.String { Swift.String(localized: "app.settings.presetHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum PresetOptions {
        /// Blue
        public static var blue: Swift.String { Swift.String(localized: "app.settings.presetOptions.blue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Graphite
        public static var graphite: Swift.String { Swift.String(localized: "app.settings.presetOptions.graphite", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Lime
        public static var lime: Swift.String { Swift.String(localized: "app.settings.presetOptions.lime", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// PRIVACY & SECURITY
      public static var privacy: Swift.String { Swift.String(localized: "app.settings.privacy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Provider
      public static var provider: Swift.String { Swift.String(localized: "app.settings.provider", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Scheme
      public static var scheme: Swift.String { Swift.String(localized: "app.settings.scheme", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Search {
        /// Search settings
        public static var label: Swift.String { Swift.String(localized: "app.settings.search.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// No setting matches that.
        public static var noMatches: Swift.String { Swift.String(localized: "app.settings.search.noMatches", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Show bot-to-bot
      public static var showBotToBot: Swift.String { Swift.String(localized: "app.settings.showBotToBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show thinking
      public static var showThinking: Swift.String { Swift.String(localized: "app.settings.showThinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sign out
      public static var signOut: Swift.String { Swift.String(localized: "app.settings.signOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Clears the stored credentials and keeps the gateway address.
      public static var signOutHint: Swift.String { Swift.String(localized: "app.settings.signOutHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Status
      public static var status: Swift.String { Swift.String(localized: "app.settings.status", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Theme
      public static var theme: Swift.String { Swift.String(localized: "app.settings.theme", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// System follows the device; Light and Dark pin the app either way.
      public static var themeHint: Swift.String { Swift.String(localized: "app.settings.themeHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum ThemeOptions {
        /// Dark
        public static var dark: Swift.String { Swift.String(localized: "app.settings.themeOptions.dark", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Light
        public static var light: Swift.String { Swift.String(localized: "app.settings.themeOptions.light", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// System
        public static var system: Swift.String { Swift.String(localized: "app.settings.themeOptions.system", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public enum Themes {
        /// Your bubbles
        public static var accentBubble: Swift.String { Swift.String(localized: "app.settings.themes.accentBubble", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Accent
        public static var accentFill: Swift.String { Swift.String(localized: "app.settings.themes.accentFill", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Back to settings
        public static var back: Swift.String { Swift.String(localized: "app.settings.themes.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Background
        public static var background: Swift.String { Swift.String(localized: "app.settings.themes.background", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// #RRGGBB
        public static var colourPlaceholder: Swift.String { Swift.String(localized: "app.settings.themes.colourPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// New theme
        public static var create: Swift.String { Swift.String(localized: "app.settings.themes.create", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// From {preset}
        public static func createFrom(preset: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.createFrom", defaultValue: "From \(preset)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Delete
        public static var delete: Swift.String { Swift.String(localized: "app.settings.themes.delete", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Delete “{name}”?
        public static func deleteConfirm(name: Swift.String) -> Swift.String {
          if name.isEmpty {
            Swift.String(localized: "app.settings.themes.deleteConfirm#name-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
          } else {
            Swift.String(localized: "app.settings.themes.deleteConfirm#name-nonempty", defaultValue: "Delete “\(name)”?", table: "Localizable", bundle: HermieStringsLookup.bundle)
          }
        }
        /// The theme is removed everywhere this gateway is signed in.
        public static var deleteHint: Swift.String { Swift.String(localized: "app.settings.themes.deleteHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Edit theme
        public static var editPageTitle: Swift.String { Swift.String(localized: "app.settings.themes.editPageTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Editing the {scheme} face
        public static func editing(scheme: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.editing", defaultValue: "Editing the \(scheme) face", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Switch the setting above to edit the other face.
        public static var editingHint: Swift.String { Swift.String(localized: "app.settings.themes.editingHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// No themes of your own yet. Start one from a preset and edit its colours.
        public static var empty: Swift.String { Swift.String(localized: "app.settings.themes.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Follow the preset
        public static var followPreset: Swift.String { Swift.String(localized: "app.settings.themes.followPreset", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// YOUR THEMES
        public static var header: Swift.String { Swift.String(localized: "app.settings.themes.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Keep it
        public static var keepIt: Swift.String { Swift.String(localized: "app.settings.themes.keepIt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Name
        public static var name: Swift.String { Swift.String(localized: "app.settings.themes.name", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Theme name
        public static var namePlaceholder: Swift.String { Swift.String(localized: "app.settings.themes.namePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// it measures {ratio} : 1 against the surface behind it, and a mark needs 3 : 1.
        public static func reasonAccentFill(ratio: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.reasonAccentFill", defaultValue: "it measures \(ratio) : 1 against the surface behind it, and a mark needs 3 : 1.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// the app’s text on it measures {ratio} : 1, and needs 4.5 : 1.
        public static func reasonBackground(ratio: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.reasonBackground", defaultValue: "the app’s text on it measures \(ratio) : 1, and needs 4.5 : 1.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// white text on it measures {ratio} : 1, and needs 4.5 : 1.
        public static func reasonBubble(ratio: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.reasonBubble", defaultValue: "white text on it measures \(ratio) : 1, and needs 4.5 : 1.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// a colour is six hex digits after a #.
        public static var reasonMalformed: Swift.String { Swift.String(localized: "app.settings.themes.reasonMalformed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// That colour is not used: {reason}
        public static func rejected(reason: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.themes.rejected", defaultValue: "That colour is not used: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Rename
        public static var rename: Swift.String { Swift.String(localized: "app.settings.themes.rename", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Themes
        public static var title: Swift.String { Swift.String(localized: "app.settings.themes.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Untitled theme
        public static var untitled: Swift.String { Swift.String(localized: "app.settings.themes.untitled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Settings
      public static var title: Swift.String { Swift.String(localized: "app.settings.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unknown
      public static var unknown: Swift.String { Swift.String(localized: "app.settings.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Signed in as
      public static var user: Swift.String { Swift.String(localized: "app.settings.user", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Version
      public static var version: Swift.String { Swift.String(localized: "app.settings.version", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// via Hermie Web
      public static var viaHermieWeb: Swift.String { Swift.String(localized: "app.settings.viaHermieWeb", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum WebUpdate {
        /// Update
        public static var apply: Swift.String { Swift.String(localized: "app.settings.webUpdate.apply", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// {version} available
        public static func available(version: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.webUpdate.available", defaultValue: "\(version) available", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Checking…
        public static var checking: Swift.String { Swift.String(localized: "app.settings.webUpdate.checking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The update failed: {reason}
        public static func failed(reason: Swift.String) -> Swift.String {
          Swift.String(localized: "app.settings.webUpdate.failed", defaultValue: "The update failed: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Hermie Web
        public static var header: Swift.String { Swift.String(localized: "app.settings.webUpdate.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign in to the gateway before updating Hermie Web.
        public static var needsSignIn: Swift.String { Swift.String(localized: "app.settings.webUpdate.needsSignIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie Web did not come back within a minute. Check its logs.
        public static var restartTimedOut: Swift.String { Swift.String(localized: "app.settings.webUpdate.restartTimedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Restarting…
        public static var restarting: Swift.String { Swift.String(localized: "app.settings.webUpdate.restarting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Running
        public static var running: Swift.String { Swift.String(localized: "app.settings.webUpdate.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Update
        public static var state: Swift.String { Swift.String(localized: "app.settings.webUpdate.state", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Up to date
        public static var upToDate: Swift.String { Swift.String(localized: "app.settings.webUpdate.upToDate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Downloading and installing…
        public static var updating: Swift.String { Swift.String(localized: "app.settings.webUpdate.updating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
    }
    public enum Share {
      /// This may already have been sent to {bot}. Send it again, or discard it.
      public static func maybeSent(bot: Swift.String) -> Swift.String {
        if bot.isEmpty {
          Swift.String(localized: "app.share.maybeSent#bot-empty", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "app.share.maybeSent#bot-nonempty", defaultValue: "This may already have been sent to \(bot). Send it again, or discard it.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// This gateway has no bots to send to yet.
      public static var noBots: Swift.String { Swift.String(localized: "app.share.noBots", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Note
      public static var noteLabel: Swift.String { Swift.String(localized: "app.share.noteLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Add a note (optional)
      public static var notePlaceholder: Swift.String { Swift.String(localized: "app.share.notePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send
      public static var send: Swift.String { Swift.String(localized: "app.share.send", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send again
      public static var sendAgain: Swift.String { Swift.String(localized: "app.share.sendAgain", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sending…
      public static var sending: Swift.String { Swift.String(localized: "app.share.sending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sent to {bot}
      public static func sentTo(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "app.share.sentTo", defaultValue: "Sent to \(bot)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Send to a chat
      public static var sheetTitle: Swift.String { Swift.String(localized: "app.share.sheetTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Will send when Hermie opens
      public static var willSendLater: Swift.String { Swift.String(localized: "app.share.willSendLater", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Sidebar {
      /// Hermie Web {version}
      public static func hermieWeb(version: Swift.String) -> Swift.String {
        Swift.String(localized: "app.sidebar.hermieWeb", defaultValue: "Hermie Web \(version)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum SignedOut {
      /// Your session on {host} has expired, so Hermie cannot reach your bots until you sign in.
      public static func body(host: Swift.String) -> Swift.String {
        Swift.String(localized: "app.signedOut.body", defaultValue: "Your session on \(host) has expired, so Hermie cannot reach your bots until you sign in.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Your session has expired, so Hermie cannot reach your bots until you sign in.
      public static var bodyNoHost: Swift.String { Swift.String(localized: "app.signedOut.bodyNoHost", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Change gateway
      public static var changeGateway: Swift.String { Swift.String(localized: "app.signedOut.changeGateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Showing the last saved list.
      public static var listNote: Swift.String { Swift.String(localized: "app.signedOut.listNote", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Reason {
        /// There was nothing saved to renew the session with.
        public static var noRefreshToken: Swift.String { Swift.String(localized: "app.signedOut.reason.noRefreshToken", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Renewing the session did not complete, so Hermie could not stay signed in.
        public static var refreshFailed: Swift.String { Swift.String(localized: "app.signedOut.reason.refreshFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The gateway rejected the saved sign-in, so the session could not be renewed.
        public static var refreshRejected: Swift.String { Swift.String(localized: "app.signedOut.reason.refreshRejected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The gateway rejected the sign-in Hermie had just renewed.
        public static var rejectedAfterRefresh: Swift.String { Swift.String(localized: "app.signedOut.reason.rejectedAfterRefresh", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie could not read the saved sign-in from the keychain.
        public static var tokenUnreadable: Swift.String { Swift.String(localized: "app.signedOut.reason.tokenUnreadable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Sign in
      public static var signIn: Swift.String { Swift.String(localized: "app.signedOut.signIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Stopped {
        /// Opens setup with this address filled in. Your sign-in is kept until a different gateway is applied.
        public static var changeGatewayHint: Swift.String { Swift.String(localized: "app.signedOut.stopped.changeGatewayHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This page is served by Hermie Web, which decides the gateway. Change it where that server is configured.
        public static var fixedByServer: Swift.String { Swift.String(localized: "app.signedOut.stopped.fixedByServer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Gateway
        public static var gateway: Swift.String { Swift.String(localized: "app.signedOut.stopped.gateway", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        public enum Hints {
          /// If the gateway moved, change the address stored here to the one it publishes as its public URL.
          public static var config: Swift.String { Swift.String(localized: "app.signedOut.stopped.hints.config", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Re-check reclaims the connection once the other client has let go.
          public static var takenOver: Swift.String { Swift.String(localized: "app.signedOut.stopped.hints.takenOver", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
        /// Not signed in
        public static var notSignedIn: Swift.String { Swift.String(localized: "app.signedOut.stopped.notSignedIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// {name}
        public static func onGateway(name: Swift.String) -> Swift.String {
          Swift.String(localized: "app.signedOut.stopped.onGateway", defaultValue: "\(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// OTHER GATEWAYS
        public static var others: Swift.String { Swift.String(localized: "app.signedOut.stopped.others", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Hermie talks to one gateway at a time. This one keeps its conversations.
        public static var othersHint: Swift.String { Swift.String(localized: "app.signedOut.stopped.othersHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Re-check
        public static var recheck: Swift.String { Swift.String(localized: "app.signedOut.stopped.recheck", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Checking…
        public static var rechecking: Swift.String { Swift.String(localized: "app.signedOut.stopped.rechecking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Sign out
        public static var signOut: Swift.String { Swift.String(localized: "app.signedOut.stopped.signOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Connect to {name}
        public static func switchTo(name: Swift.String) -> Swift.String {
          Swift.String(localized: "app.signedOut.stopped.switchTo", defaultValue: "Connect to \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        public enum Titles {
          /// Signed out
          public static var auth: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.auth", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Chat is switched off on this gateway
          public static var chatOff: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.chatOff", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway refused the connection
          public static var config: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.config", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway is too old
          public static var incompatible: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.incompatible", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This address is not a Hermes gateway
          public static var not_hermes: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.not_hermes", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway answered in a way Hermie cannot read
          public static var `protocol`: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.protocol", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This address leads somewhere else
          public static var redirect: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.redirect", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// Another client took this connection over
          public static var takenOver: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.takenOver", table: "Localizable", bundle: HermieStringsLookup.bundle) }
          /// This gateway’s certificate was rejected
          public static var tls: Swift.String { Swift.String(localized: "app.signedOut.stopped.titles.tls", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        }
      }
      /// Signed out
      public static var title: Swift.String { Swift.String(localized: "app.signedOut.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Tabs {
      /// Activity
      public static var activity: Swift.String { Swift.String(localized: "app.tabs.activity", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chats
      public static var chats: Swift.String { Swift.String(localized: "app.tabs.chats", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Crons
      public static var routines: Swift.String { Swift.String(localized: "app.tabs.routines", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Settings
      public static var settings: Swift.String { Swift.String(localized: "app.tabs.settings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Transport {
      /// Found over http://
      public static var foundOverHttp: Swift.String { Swift.String(localized: "app.transport.foundOverHttp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Found over https://
      public static var foundOverHttps: Swift.String { Swift.String(localized: "app.transport.foundOverHttps", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Plain http:// to a public address. Anyone on the path can read your messages and your sign-in. Use https://, or reach the gateway over a private network such as Tailscale.
      public static var httpExposed: Swift.String { Swift.String(localized: "app.transport.httpExposed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Plain http://, to an address on a local network. It is not reachable from outside that network.
      public static var httpLocalNetwork: Swift.String { Swift.String(localized: "app.transport.httpLocalNetwork", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Plain http://, and this connection never leaves this machine.
      public static var httpLoopback: Swift.String { Swift.String(localized: "app.transport.httpLoopback", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Plain http://, over a tailnet address. WireGuard has already encrypted the path between this device and the gateway.
      public static var httpTailnet: Swift.String { Swift.String(localized: "app.transport.httpTailnet", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Use https instead
      public static var useHttps: Swift.String { Swift.String(localized: "app.transport.useHttps", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
  }
  public enum BotRename {
    /// Leave it empty to fall back to the name the gateway reports.
    public static var clearHint: Swift.String { Swift.String(localized: "botRename.clearHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The default profile needs a name.
    public static var clearRefused: Swift.String { Swift.String(localized: "botRename.clearRefused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Stored in Hermie only; the gateway plugin is too old to save it on the gateway.
    public static var displayAppOnly: Swift.String { Swift.String(localized: "botRename.displayAppOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// This gateway account may not change profile names.
    public static var displayForbidden: Swift.String { Swift.String(localized: "botRename.displayForbidden", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// What Hermie calls this bot in your list. The gateway keeps the profile’s own name.
    public static var displayHint: Swift.String { Swift.String(localized: "botRename.displayHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Display name
    public static var displayLabel: Swift.String { Swift.String(localized: "botRename.displayLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// That name could not be saved.
    public static var failed: Swift.String { Swift.String(localized: "botRename.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The gateway has no profile called {name}.
    public static func missing(name: Swift.String) -> Swift.String {
      Swift.String(localized: "botRename.missing", defaultValue: "The gateway has no profile called \(name).", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// The gateway renamed this bot, but {parts|list(" and ", " and ")} could not be moved across. Reconnect to pick it up.
    public static func partial(parts: [Swift.String]) -> Swift.String {
      Swift.String(localized: "botRename.partial", defaultValue: "The gateway renamed this bot, but \(hermieJoinList(parts, Swift.String(localized: "botRename.partial#parts.separator", table: "Localizable", bundle: HermieStringsLookup.bundle), Swift.String(localized: "botRename.partial#parts.last", table: "Localizable", bundle: HermieStringsLookup.bundle))) could not be moved across. Reconnect to pick it up.", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// the cached transcript
    public static var partialCache: Swift.String { Swift.String(localized: "botRename.partialCache", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// the open chats
    public static var partialStores: Swift.String { Swift.String(localized: "botRename.partialStores", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Not set
    public static var placeholder: Swift.String { Swift.String(localized: "botRename.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The name the rest of the app addresses this bot by.
    public static var profileHint: Swift.String { Swift.String(localized: "botRename.profileHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Profile name
    public static var profileLabel: Swift.String { Swift.String(localized: "botRename.profileLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Renaming changes the profile name other tools use
    public static var profileWarning: Swift.String { Swift.String(localized: "botRename.profileWarning", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The gateway would not take that name.
    public static var refused: Swift.String { Swift.String(localized: "botRename.refused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Rename profile
    public static var renameAction: Swift.String { Swift.String(localized: "botRename.renameAction", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Renaming…
    public static var renameBusy: Swift.String { Swift.String(localized: "botRename.renameBusy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Keep it as it is
    public static var renameCancel: Swift.String { Swift.String(localized: "botRename.renameCancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The default profile keeps its name. Its home is the gateway’s own directory.
    public static var renameDefault: Swift.String { Swift.String(localized: "botRename.renameDefault", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// New profile name
    public static var renameField: Swift.String { Swift.String(localized: "botRename.renameField", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Changes the profile on the gateway itself, not what Hermie shows.
    public static var renameHint: Swift.String { Swift.String(localized: "botRename.renameHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Rename profile…
    public static var renameRow: Swift.String { Swift.String(localized: "botRename.renameRow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
  }
  public enum Chat {
    public enum Approval {
      /// Answered: {choice}
      public static func answered(choice: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.approval.answered", defaultValue: "Answered: \(choice)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Answered elsewhere
      public static var answeredElsewhere: Swift.String { Swift.String(localized: "chat.approval.answeredElsewhere", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Choices {
        /// Always allow
        public static var always: Swift.String { Swift.String(localized: "chat.approval.choices.always", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Deny
        public static var deny: Swift.String { Swift.String(localized: "chat.approval.choices.deny", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Allow once
        public static var once: Swift.String { Swift.String(localized: "chat.approval.choices.once", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Allow for this session
        public static var session: Swift.String { Swift.String(localized: "chat.approval.choices.session", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The entry for a key that arrives at run time, or nil for one this table does not have.
        public static subscript(key: Swift.String) -> Swift.String? {
          switch key {
          case "always": always
          case "deny": deny
          case "once": once
          case "session": session
          default: nil
          }
        }
      }
      /// PERMISSION REQUEST · @{handle|upper}
      public static func eyebrow(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.approval.eyebrow", defaultValue: "PERMISSION REQUEST · @\(handle.uppercased())", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Always allow applies to this exact command on this gateway. Change it later in Settings.
      public static var fine: Swift.String { Swift.String(localized: "chat.approval.fine", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// @{handle} wants to run one command on your gateway host, in {directory}.
      public static func lead(handle: Swift.String, directory: Swift.String? = nil) -> Swift.String {
        if (directory ?? "").isEmpty {
          Swift.String(localized: "chat.approval.lead#directory-empty", defaultValue: "@\(handle) wants to run one command on your gateway host.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "chat.approval.lead#directory-nonempty", defaultValue: "@\(handle) wants to run one command on your gateway host, in \(directory ?? "").", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      public enum Outcomes {
        /// Always allowed
        public static var always: Swift.String { Swift.String(localized: "chat.approval.outcomes.always", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Denied
        public static var deny: Swift.String { Swift.String(localized: "chat.approval.outcomes.deny", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Allowed once
        public static var once: Swift.String { Swift.String(localized: "chat.approval.outcomes.once", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Allowed for the session
        public static var session: Swift.String { Swift.String(localized: "chat.approval.outcomes.session", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The entry for a key that arrives at run time, or nil for one this table does not have.
        public static subscript(key: Swift.String) -> Swift.String? {
          switch key {
          case "always": always
          case "deny": deny
          case "once": once
          case "session": session
          default: nil
          }
        }
      }
      /// Runs on your gateway
      public static var runsOn: Swift.String { Swift.String(localized: "chat.approval.runsOn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Timed out
      public static var timedOut: Swift.String { Swift.String(localized: "chat.approval.timedOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Allow this command?
      public static var title: Swift.String { Swift.String(localized: "chat.approval.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Assistant {
      /// Something went wrong
      public static var errorTitle: Swift.String { Swift.String(localized: "chat.assistant.errorTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {parts|list(" · ", " · ")}
      public static func footer(parts: [Swift.String]) -> Swift.String {
        Swift.String(localized: "chat.assistant.footer", defaultValue: "\(hermieJoinList(parts, Swift.String(localized: "chat.assistant.footer#parts.separator", table: "Localizable", bundle: HermieStringsLookup.bundle), Swift.String(localized: "chat.assistant.footer#parts.last", table: "Localizable", bundle: HermieStringsLookup.bundle)))", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Interim note
      public static var interim: Swift.String { Swift.String(localized: "chat.assistant.interim", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reconnecting…
      public static var reconnecting: Swift.String { Swift.String(localized: "chat.assistant.reconnecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reply to @{handle}
      public static func replyTo(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.assistant.replyTo", defaultValue: "Reply to @\(handle)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Retry
      public static var retry: Swift.String { Swift.String(localized: "chat.assistant.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Thinking
      public static var thinking: Swift.String { Swift.String(localized: "chat.assistant.thinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Thought for {seconds}s
      public static func thoughtFor(seconds: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.assistant.thoughtFor", defaultValue: "Thought for \(seconds)s", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {input} in · {output} out
      public static func tokens(input: Swift.String, output: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.assistant.tokens", defaultValue: "\(input) in · \(output) out", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum BotDm {
      /// Ambiguous target
      public static var ambiguous: Swift.String { Swift.String(localized: "chat.botDm.ambiguous", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// ↩︎ answered
      public static var answered: Swift.String { Swift.String(localized: "chat.botDm.answered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// From @{handle}
      public static func asideFrom(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.asideFrom", defaultValue: "From @\(handle)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// To @{handle}
      public static func asideTo(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.asideTo", defaultValue: "To @\(handle)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Message to {target}
      public static func chip(target: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.chip", defaultValue: "Message to \(target)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Delivered ✓
      public static var delivered: Swift.String { Swift.String(localized: "chat.botDm.delivered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Failed
      public static var failed: Swift.String { Swift.String(localized: "chat.botDm.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Message from {name}
      public static func inChip(name: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.inChip", defaultValue: "Message from \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      public enum Marker {
        /// Failed
        public static var failed: Swift.String { Swift.String(localized: "chat.botDm.marker.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// ↩︎ replied
        public static var replied: Swift.String { Swift.String(localized: "chat.botDm.marker.replied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Delivered · waiting for reply
        public static var waiting: Swift.String { Swift.String(localized: "chat.botDm.marker.waiting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Open @{handle}’s chat
      public static func openChat(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.openChat", defaultValue: "Open @\(handle)’s chat", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Opens the chat with {name}
      public static func openSender(name: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.openSender", defaultValue: "Opens the chat with \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Opens the chat with {target}
      public static func openTarget(target: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.openTarget", defaultValue: "Opens the chat with \(target)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Queued · waiting for the current task
      public static var queued: Swift.String { Swift.String(localized: "chat.botDm.queued", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {name} replied
      public static func replied(name: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.replied", defaultValue: "\(name) replied", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Reply
      public static var reply: Swift.String { Swift.String(localized: "chat.botDm.reply", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} messages with @{handle} · {replies} replies
      public static func rollup(count: Swift.Int, handle: Swift.String, replies: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.botDm.rollup", defaultValue: "\(count) messages with @\(handle) · \(replies) replies", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {count} messages · {replies} replies
      public static func rollupMixed(count: Swift.Int, replies: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.botDm.rollupMixed", defaultValue: "\(count) messages · \(replies) replies", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Sending…
      public static var sending: Swift.String { Swift.String(localized: "chat.botDm.sending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show less
      public static var showLess: Swift.String { Swift.String(localized: "chat.botDm.showLess", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show more
      public static var showMore: Swift.String { Swift.String(localized: "chat.botDm.showMore", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// @{handle} is writing…
      public static func targetTyping(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.targetTyping", defaultValue: "@\(handle) is writing…", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// → {target}
      public static func to(target: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.botDm.to", defaultValue: "→ \(target)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Sent
      public static var unknown: Swift.String { Swift.String(localized: "chat.botDm.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Clarify {
      /// A QUESTION FOR YOU
      public static var eyebrow: Swift.String { Swift.String(localized: "chat.clarify.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Or answer in your own words
      public static var freeText: Swift.String { Swift.String(localized: "chat.clarify.freeText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Type an answer…
      public static var freeTextPlaceholder: Swift.String { Swift.String(localized: "chat.clarify.freeTextPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Later
      public static var later: Swift.String { Swift.String(localized: "chat.clarify.later", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Lock answer
      public static var lock: Swift.String { Swift.String(localized: "chat.clarify.lock", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Locked
      public static var locked: Swift.String { Swift.String(localized: "chat.clarify.locked", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Choose as many as apply
      public static var multiSelectHint: Swift.String { Swift.String(localized: "chat.clarify.multiSelectHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Next
      public static var next: Swift.String { Swift.String(localized: "chat.clarify.next", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Answered {answered} of {total}
      public static func outcome(answered: Swift.Int, total: Swift.Int) -> Swift.String {
        if answered >= total {
          Swift.String(localized: "chat.clarify.outcome#answered-gte-total", defaultValue: "Answered all \(total)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        } else {
          Swift.String(localized: "chat.clarify.outcome#answered-lt-total", defaultValue: "Answered \(answered) of \(total)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
      }
      /// Back
      public static var previous: Swift.String { Swift.String(localized: "chat.clarify.previous", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Question {current} of {total}
      public static func step(current: Swift.Int, total: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.clarify.step", defaultValue: "Question \(current) of \(total)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Submit
      public static var submit: Swift.String { Swift.String(localized: "chat.clarify.submit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Before I continue
      public static var title: Swift.String { Swift.String(localized: "chat.clarify.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Composer {
      /// Add attachment
      public static var attach: Swift.String { Swift.String(localized: "chat.composer.attach", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Choose file
      public static var chooseFile: Swift.String { Swift.String(localized: "chat.composer.chooseFile", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dismiss attachment menu
      public static var dismissAttach: Swift.String { Swift.String(localized: "chat.composer.dismissAttach", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Enter to send · Shift+Enter for a new line
      public static var keyHint: Swift.String { Swift.String(localized: "chat.composer.keyHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Message {bot}
      public static func messageTo(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.composer.messageTo", defaultValue: "Message \(bot)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Not sent yet
      public static var notSentYet: Swift.String { Swift.String(localized: "chat.composer.notSentYet", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} files
      public static func pendingCount(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.composer.pendingCount", defaultValue: "\(count) files", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Photo library
      public static var photoLibrary: Swift.String { Swift.String(localized: "chat.composer.photoLibrary", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Message
      public static var placeholder: Swift.String { Swift.String(localized: "chat.composer.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// ↳ 1 message queued · “{text}”
      public static func queued(text: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.composer.queued", defaultValue: "↳ 1 message queued · “\(text)”", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Remove attachment
      public static var removeAttachment: Swift.String { Swift.String(localized: "chat.composer.removeAttachment", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send message
      public static var send: Swift.String { Swift.String(localized: "chat.composer.send", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send message with {count} attachments
      public static func sendWithAttachments(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.composer.sendWithAttachments", defaultValue: "Send message with \(count) attachments", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Commands
      public static var slashHint: Swift.String { Swift.String(localized: "chat.composer.slashHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Loading…
      public static var slashLoading: Swift.String { Swift.String(localized: "chat.composer.slashLoading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Commands unavailable — {method}
      public static func slashUnavailable(method: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.composer.slashUnavailable", defaultValue: "Commands unavailable — \(method)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Stop response
      public static var stop: Swift.String { Swift.String(localized: "chat.composer.stop", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Context {
      /// {used} / {limit}
      public static func counts(used: Swift.String, limit: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.context.counts", defaultValue: "\(used) / \(limit)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// (estimated)
      public static var estimated: Swift.String { Swift.String(localized: "chat.context.estimated", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// How much of this session’s context window the conversation fills.
      public static var hint: Swift.String { Swift.String(localized: "chat.context.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Context used
      public static var label: Swift.String { Swift.String(localized: "chat.context.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {percent}%
      public static func percent(percent: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.context.percent", defaultValue: "\(percent)%", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Conversations {
      /// All conversations
      public static var allConversations: Swift.String { Swift.String(localized: "chat.conversations.allConversations", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Conversations
      public static var columnTitle: Swift.String { Swift.String(localized: "chat.conversations.columnTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// My chat
      public static var firstChat: Swift.String { Swift.String(localized: "chat.conversations.firstChat", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Group chat
      public static var groupChat: Swift.String { Swift.String(localized: "chat.conversations.groupChat", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide conversations
      public static var hideColumn: Swift.String { Swift.String(localized: "chat.conversations.hideColumn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New chat
      public static var newChat: Swift.String { Swift.String(localized: "chat.conversations.newChat", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway would not start a new chat.
      public static var newChatFailed: Swift.String { Swift.String(localized: "chat.conversations.newChatFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation could not be opened.
      public static var openFailed: Swift.String { Swift.String(localized: "chat.conversations.openFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chat name
      public static var renameLabel: Swift.String { Swift.String(localized: "chat.conversations.renameLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show conversations
      public static var showColumn: Swift.String { Swift.String(localized: "chat.conversations.showColumn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Your chats
      public static var yourChats: Swift.String { Swift.String(localized: "chat.conversations.yourChats", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Start a chat of your own to see it here.
      public static var yoursEmpty: Swift.String { Swift.String(localized: "chat.conversations.yoursEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Cron {
      /// delivered to this chat
      public static var delivered: Swift.String { Swift.String(localized: "chat.cron.delivered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The job delivered nothing to show.
      public static var emptyBody: Swift.String { Swift.String(localized: "chat.cron.emptyBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// CRON
      public static var eyebrow: Swift.String { Swift.String(localized: "chat.cron.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open cron
      public static var `open`: Swift.String { Swift.String(localized: "chat.cron.open", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// ran {time} · delivered to this chat
      public static func ranAt(time: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.cron.ranAt", defaultValue: "ran \(time) · delivered to this chat", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Run now
      public static var runNow: Swift.String { Swift.String(localized: "chat.cron.runNow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Scheduled job
      public static var unnamed: Swift.String { Swift.String(localized: "chat.cron.unnamed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Drop {
      /// Drop file to attach
      public static var invitation: Swift.String { Swift.String(localized: "chat.drop.invitation", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Drop files here to attach them
      public static var region: Swift.String { Swift.String(localized: "chat.drop.region", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Export {
      /// Download as Markdown
      public static var downloadMarkdown: Swift.String { Swift.String(localized: "chat.export.downloadMarkdown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Download as plain text
      public static var downloadText: Swift.String { Swift.String(localized: "chat.export.downloadText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The conversation could not be exported.
      public static var failed: Swift.String { Swift.String(localized: "chat.export.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Export
      public static var header: Swift.String { Swift.String(localized: "chat.export.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The conversation as it is on screen, with whatever this chat’s view settings hide left out.
      public static var hint: Swift.String { Swift.String(localized: "chat.export.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// You
      public static var `self`: Swift.String { Swift.String(localized: "chat.export.self", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Share as Markdown
      public static var shareMarkdown: Swift.String { Swift.String(localized: "chat.export.shareMarkdown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Share as plain text
      public static var shareText: Swift.String { Swift.String(localized: "chat.export.shareText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Fold {
      /// Show less
      public static var less: Swift.String { Swift.String(localized: "chat.fold.less", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show more
      public static var more: Swift.String { Swift.String(localized: "chat.fold.more", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Header {
      /// Back to chats
      public static var back: Swift.String { Swift.String(localized: "chat.header.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide sidebar
      public static var hideSidebar: Swift.String { Swift.String(localized: "chat.header.hideSidebar", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Online
      public static var idle: Swift.String { Swift.String(localized: "chat.header.idle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Waiting for you
      public static var needsInput: Swift.String { Swift.String(localized: "chat.header.needsInput", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Offline
      public static var offline: Swift.String { Swift.String(localized: "chat.header.offline", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Offline · last seen {time}
      public static func offlineAt(time: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.header.offlineAt", defaultValue: "Offline · last seen \(time)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Chat options
      public static var options: Swift.String { Swift.String(localized: "chat.header.options", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {name} — profile
      public static func profile(name: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.header.profile", defaultValue: "\(name) — profile", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Running
      public static var running: Swift.String { Swift.String(localized: "chat.header.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Menu {
      /// Copy link
      public static var copyLink: Swift.String { Swift.String(localized: "chat.menu.copyLink", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Copy as Markdown
      public static var copyMarkdown: Swift.String { Swift.String(localized: "chat.menu.copyMarkdown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Copy text
      public static var copyText: Swift.String { Swift.String(localized: "chat.menu.copyText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit and resend
      public static var editResend: Swift.String { Swift.String(localized: "chat.menu.editResend", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide details
      public static var hideDetails: Swift.String { Swift.String(localized: "chat.menu.hideDetails", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Message actions
      public static var message: Swift.String { Swift.String(localized: "chat.menu.message", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// There is no message here to send again.
      public static var nothingToRegenerate: Swift.String { Swift.String(localized: "chat.menu.nothingToRegenerate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open @{handle}’s chat
      public static func openBotChat(handle: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.menu.openBotChat", defaultValue: "Open @\(handle)’s chat", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Read aloud
      public static var readAloud: Swift.String { Swift.String(localized: "chat.menu.readAloud", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Regenerate
      public static var regenerate: Swift.String { Swift.String(localized: "chat.menu.regenerate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Select text
      public static var selectText: Swift.String { Swift.String(localized: "chat.menu.selectText", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show details
      public static var showDetails: Swift.String { Swift.String(localized: "chat.menu.showDetails", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Stop reading
      public static var stopReading: Swift.String { Swift.String(localized: "chat.menu.stopReading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Wait for the current turn to finish.
      public static var turnRunning: Swift.String { Swift.String(localized: "chat.menu.turnRunning", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Notifications {
      /// Following the types set in Settings.
      public static var following: Swift.String { Swift.String(localized: "chat.notifications.following", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// These override the global types in Settings for this chat only.
      public static var hint: Swift.String { Swift.String(localized: "chat.notifications.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Notifications
      public static var label: Swift.String { Swift.String(localized: "chat.notifications.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This chat has its own types.
      public static var overridden: Swift.String { Swift.String(localized: "chat.notifications.overridden", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What {bot} may notify you about
      public static func subtitle(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.notifications.subtitle", defaultValue: "What \(bot) may notify you about", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Notifications
      public static var title: Swift.String { Swift.String(localized: "chat.notifications.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Types {
        /// Scheduled runs
        public static var cron: Swift.String { Swift.String(localized: "chat.notifications.types.cron", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A scheduled run finished
        public static var cronDone: Swift.String { Swift.String(localized: "chat.notifications.types.cronDone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A scheduled run failed
        public static var cronFailed: Swift.String { Swift.String(localized: "chat.notifications.types.cronFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Needs your answer
        public static var needsInput: Swift.String { Swift.String(localized: "chat.notifications.types.needsInput", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Finished a turn
        public static var turnDone: Swift.String { Swift.String(localized: "chat.notifications.types.turnDone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// A turn failed
        public static var turnFailed: Swift.String { Swift.String(localized: "chat.notifications.types.turnFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The entry for a key that arrives at run time, or nil for one this table does not have.
        public static subscript(key: Swift.String) -> Swift.String? {
          switch key {
          case "cron": cron
          case "cronDone": cronDone
          case "cronFailed": cronFailed
          case "needsInput": needsInput
          case "turnDone": turnDone
          case "turnFailed": turnFailed
          default: nil
          }
        }
      }
      /// Use the global types
      public static var useDefault: Swift.String { Swift.String(localized: "chat.notifications.useDefault", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Options {
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "chat.options.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Tints this chat’s avatar ring, its row in the list and the messages you send.
      public static var colourHint: Swift.String { Swift.String(localized: "chat.options.colourHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Done
      public static var done: Swift.String { Swift.String(localized: "chat.options.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Use it anyway
      public static var expensiveConfirm: Swift.String { Swift.String(localized: "chat.options.expensiveConfirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This model costs more
      public static var expensiveTitle: Swift.String { Swift.String(localized: "chat.options.expensiveTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This chat
      public static var eyebrow: Swift.String { Swift.String(localized: "chat.options.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Fast mode
      public static var fast: Swift.String { Swift.String(localized: "chat.options.fast", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Prioritize response speed
      public static var fastHint: Swift.String { Swift.String(localized: "chat.options.fastHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// How it answers
      public static var howHeader: Swift.String { Swift.String(localized: "chat.options.howHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Model
      public static var model: Swift.String { Swift.String(localized: "chat.options.model", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Search models
      public static var modelSearch: Swift.String { Swift.String(localized: "chat.options.modelSearch", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Off
      public static var notMuted: Swift.String { Swift.String(localized: "chat.options.notMuted", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reasoning effort
      public static var reasoning: Swift.String { Swift.String(localized: "chat.options.reasoning", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show bot-to-bot
      public static var showBotToBot: Swift.String { Swift.String(localized: "chat.options.showBotToBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show thinking
      public static var showThinking: Swift.String { Swift.String(localized: "chat.options.showThinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// For this conversation with {bot}
      public static func subtitle(bot: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.options.subtitle", defaultValue: "For this conversation with \(bot)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Chat text size
      public static var textSize: Swift.String { Swift.String(localized: "chat.options.textSize", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum TextSizes {
        /// Default
        public static var `default`: Swift.String { Swift.String(localized: "chat.options.textSizes.default", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Large
        public static var large: Swift.String { Swift.String(localized: "chat.options.textSizes.large", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Small
        public static var small: Swift.String { Swift.String(localized: "chat.options.textSizes.small", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Extra large
        public static var xlarge: Swift.String { Swift.String(localized: "chat.options.textSizes.xlarge", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// The entry for a key that arrives at run time, or nil for one this table does not have.
        public static subscript(key: Swift.String) -> Swift.String? {
          switch key {
          case "default": `default`
          case "large": large
          case "small": small
          case "xlarge": xlarge
          default: nil
          }
        }
      }
      /// This conversation
      public static var thisChatHeader: Swift.String { Swift.String(localized: "chat.options.thisChatHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Chat options
      public static var title: Swift.String { Swift.String(localized: "chat.options.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reset this conversation's view
      public static var useDefault: Swift.String { Swift.String(localized: "chat.options.useDefault", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Clears this conversation's own verbosity and visibility settings and follows the default from Settings again.
      public static var useDefaultHint: Swift.String { Swift.String(localized: "chat.options.useDefaultHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Following the default set in Settings.
      public static var usingDefault: Swift.String { Swift.String(localized: "chat.options.usingDefault", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation has its own view.
      public static var usingOverride: Swift.String { Swift.String(localized: "chat.options.usingOverride", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Verbosity
      public static var verbosity: Swift.String { Swift.String(localized: "chat.options.verbosity", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum VerbosityOptions {
        /// Normal
        public static var normal: Swift.String { Swift.String(localized: "chat.options.verbosityOptions.normal", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Quiet
        public static var quiet: Swift.String { Swift.String(localized: "chat.options.verbosityOptions.quiet", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Verbose
        public static var verbose: Swift.String { Swift.String(localized: "chat.options.verbosityOptions.verbose", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// What this conversation shows
      public static var viewHeader: Swift.String { Swift.String(localized: "chat.options.viewHeader", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// YOLO mode
      public static var yolo: Swift.String { Swift.String(localized: "chat.options.yolo", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Skip approval requests
      public static var yoloHint: Swift.String { Swift.String(localized: "chat.options.yoloHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Queue {
      /// Delete
      public static var delete: Swift.String { Swift.String(localized: "chat.queue.delete", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit
      public static var edit: Swift.String { Swift.String(localized: "chat.queue.edit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Queued
      public static var label: Swift.String { Swift.String(localized: "chat.queue.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// +{count} more
      public static func more(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.queue.more", defaultValue: "+\(count) more", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Steer
      public static var steer: Swift.String { Swift.String(localized: "chat.queue.steer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Too late to steer — the turn was already finishing. It is back in the queue.
      public static var steerRejected: Swift.String { Swift.String(localized: "chat.queue.steerRejected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Handed to the running turn
      public static var steered: Swift.String { Swift.String(localized: "chat.queue.steered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Steered
      public static var steeredMarker: Swift.String { Swift.String(localized: "chat.queue.steeredMarker", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Receipt {
      /// Delivered
      public static var delivered: Swift.String { Swift.String(localized: "chat.receipt.delivered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Read
      public static var read: Swift.String { Swift.String(localized: "chat.receipt.read", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sending…
      public static var sending: Swift.String { Swift.String(localized: "chat.receipt.sending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sent
      public static var sent: Swift.String { Swift.String(localized: "chat.receipt.sent", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Replying
    public static var replying: Swift.String { Swift.String(localized: "chat.replying", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum SelectText {
      /// Copy all
      public static var copyAll: Swift.String { Swift.String(localized: "chat.selectText.copyAll", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Done
      public static var done: Swift.String { Swift.String(localized: "chat.selectText.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Drag to select · ⌘A all · ⌘C copy · Esc to close
      public static var hint: Swift.String { Swift.String(localized: "chat.selectText.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Message as selectable text
      public static var panel: Swift.String { Swift.String(localized: "chat.selectText.panel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Select text
      public static var title: Swift.String { Swift.String(localized: "chat.selectText.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Sessions {
      /// Make this the Bot Chat
      public static var adopt: Swift.String { Swift.String(localized: "chat.sessions.adopt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway would not make this the Bot Chat.
      public static var adoptFailed: Swift.String { Swift.String(localized: "chat.sessions.adoptFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// back to main chat
      public static var backToMain: Swift.String { Swift.String(localized: "chat.sessions.backToMain", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Branch from here…
      public static var branch: Swift.String { Swift.String(localized: "chat.sessions.branch", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation could not be branched.
      public static var branchFailed: Swift.String { Swift.String(localized: "chat.sessions.branchFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Branched into {title}.
      public static func branchMade(title: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.sessions.branchMade", defaultValue: "Branched into \(title).", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Branch of {title}
      public static func branchOf(title: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.sessions.branchOf", defaultValue: "Branch of \(title)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Branch
      public static var branchTitle: Swift.String { Swift.String(localized: "chat.sessions.branchTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Branches
      public static var branches: Swift.String { Swift.String(localized: "chat.sessions.branches", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Wait until the reply is finished or clear the queue first.
      public static var busy: Swift.String { Swift.String(localized: "chat.sessions.busy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "chat.sessions.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Current conversation
      public static var canonical: Swift.String { Swift.String(localized: "chat.sessions.canonical", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Conversations
      public static var conversations: Swift.String { Swift.String(localized: "chat.sessions.conversations", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete
      public static var delete: Swift.String { Swift.String(localized: "chat.sessions.delete", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {title} will be removed from the gateway. This cannot be undone.
      public static func deleteBody(title: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.sessions.deleteBody", defaultValue: "\(title) will be removed from the gateway. This cannot be undone.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Delete
      public static var deleteConfirm: Swift.String { Swift.String(localized: "chat.sessions.deleteConfirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation could not be deleted.
      public static var deleteFailed: Swift.String { Swift.String(localized: "chat.sessions.deleteFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete this conversation?
      public static var deleteTitle: Swift.String { Swift.String(localized: "chat.sessions.deleteTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This bot’s conversations could not be read.
      public static var loadFailed: Swift.String { Swift.String(localized: "chat.sessions.loadFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reading this bot’s conversations…
      public static var loading: Swift.String { Swift.String(localized: "chat.sessions.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} messages
      public static func messages(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.sessions.messages", defaultValue: "\(count) messages", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// My chat
      public static var mine: Swift.String { Swift.String(localized: "chat.sessions.mine", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// My chat
      public static var mineGroup: Swift.String { Swift.String(localized: "chat.sessions.mineGroup", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Only you see this conversation. The bot keeps its own memory.
      public static var mineNote: Swift.String { Swift.String(localized: "chat.sessions.mineNote", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open
      public static var `open`: Swift.String { Swift.String(localized: "chat.sessions.open", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open now
      public static var openNow: Swift.String { Swift.String(localized: "chat.sessions.openNow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Past conversations
      public static var past: Swift.String { Swift.String(localized: "chat.sessions.past", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing but the current conversation.
      public static var pastEmpty: Swift.String { Swift.String(localized: "chat.sessions.pastEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pin
      public static var pin: Swift.String { Swift.String(localized: "chat.sessions.pin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Refresh
      public static var refresh: Swift.String { Swift.String(localized: "chat.sessions.refresh", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This chat could not be refreshed.
      public static var refreshFailed: Swift.String { Swift.String(localized: "chat.sessions.refreshFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Rename
      public static var rename: Swift.String { Swift.String(localized: "chat.sessions.rename", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation could not be renamed.
      public static var renameFailed: Swift.String { Swift.String(localized: "chat.sessions.renameFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Rename conversation
      public static var renameTitle: Swift.String { Swift.String(localized: "chat.sessions.renameTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Retired
      public static var retired: Swift.String { Swift.String(localized: "chat.sessions.retired", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Shared Bot Chat
      public static var shared: Swift.String { Swift.String(localized: "chat.sessions.shared", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Everyone on this gateway shares this conversation.
      public static var sharedNote: Swift.String { Swift.String(localized: "chat.sessions.sharedNote", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This chat could not be switched.
      public static var switchFailed: Swift.String { Swift.String(localized: "chat.sessions.switchFailed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unpin
      public static var unpin: Swift.String { Swift.String(localized: "chat.sessions.unpin", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This conversation
      public static var whose: Swift.String { Swift.String(localized: "chat.sessions.whose", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Sheet {
      /// Close
      public static var close: Swift.String { Swift.String(localized: "chat.sheet.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Subagents {
      /// {count} agents working
      public static func barCount(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.subagents.barCount", defaultValue: "\(count) agents working", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Show
      public static var barOpen: Swift.String { Swift.String(localized: "chat.subagents.barOpen", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} goals
      public static func goals(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.subagents.goals", defaultValue: "\(count) goals", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      public enum GroupStatus {
        /// Dispatched
        public static var dispatched: Swift.String { Swift.String(localized: "chat.subagents.groupStatus.dispatched", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Done
        public static var done: Swift.String { Swift.String(localized: "chat.subagents.groupStatus.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Failed
        public static var failed: Swift.String { Swift.String(localized: "chat.subagents.groupStatus.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Running
        public static var running: Swift.String { Swift.String(localized: "chat.subagents.groupStatus.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// No agents running
      public static var idle: Swift.String { Swift.String(localized: "chat.subagents.idle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open transcript
      public static var openTranscript: Swift.String { Swift.String(localized: "chat.subagents.openTranscript", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Status {
        /// Done
        public static var completed: Swift.String { Swift.String(localized: "chat.subagents.status.completed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Failed
        public static var failed: Swift.String { Swift.String(localized: "chat.subagents.status.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Stopped
        public static var interrupted: Swift.String { Swift.String(localized: "chat.subagents.status.interrupted", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Queued
        public static var queued: Swift.String { Swift.String(localized: "chat.subagents.status.queued", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Running
        public static var running: Swift.String { Swift.String(localized: "chat.subagents.status.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Steer
      public static var steer: Swift.String { Swift.String(localized: "chat.subagents.steer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Send a correction…
      public static var steerPlaceholder: Swift.String { Swift.String(localized: "chat.subagents.steerPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Steer queued
      public static var steerQueued: Swift.String { Swift.String(localized: "chat.subagents.steerQueued", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Too late to steer — the agent had already finished its last batch.
      public static var steerRejected: Swift.String { Swift.String(localized: "chat.subagents.steerRejected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Stop
      public static var stop: Swift.String { Swift.String(localized: "chat.subagents.stop", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Stopping…
      public static var stopped: Swift.String { Swift.String(localized: "chat.subagents.stopped", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Agents
      public static var title: Swift.String { Swift.String(localized: "chat.subagents.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Back to the agents
      public static var transcriptBack: Swift.String { Swift.String(localized: "chat.subagents.transcriptBack", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This agent has not written anything readable yet.
      public static var transcriptEmpty: Swift.String { Swift.String(localized: "chat.subagents.transcriptEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Live tail · refreshing every few seconds
      public static var transcriptLive: Swift.String { Swift.String(localized: "chat.subagents.transcriptLive", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The child’s own transcript, read-only.
      public static var transcriptStored: Swift.String { Swift.String(localized: "chat.subagents.transcriptStored", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Transcript · {goal}
      public static func transcriptTitle(goal: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.subagents.transcriptTitle", defaultValue: "Transcript · \(goal)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {count} agents working · {elapsed}
      public static func working(count: Swift.Int, elapsed: Swift.String) -> Swift.String {
        Swift.String(localized: "chat.subagents.working", defaultValue: "\(count) agents working · \(elapsed)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Tool {
      /// Arguments
      public static var arguments: Swift.String { Swift.String(localized: "chat.tool.arguments", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Collapse tool call
      public static var collapse: Swift.String { Swift.String(localized: "chat.tool.collapse", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Expand tool call
      public static var expand: Swift.String { Swift.String(localized: "chat.tool.expand", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Failed
      public static var failed: Swift.String { Swift.String(localized: "chat.tool.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Preparing…
      public static var generating: Swift.String { Swift.String(localized: "chat.tool.generating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No result recorded
      public static var noResult: Swift.String { Swift.String(localized: "chat.tool.noResult", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Arguments (raw)
      public static var rawArguments: Swift.String { Swift.String(localized: "chat.tool.rawArguments", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Result (raw)
      public static var rawResult: Swift.String { Swift.String(localized: "chat.tool.rawResult", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Redacted before it reached the model
      public static var redacted: Swift.String { Swift.String(localized: "chat.tool.redacted", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Result
      public static var result: Swift.String { Swift.String(localized: "chat.tool.result", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Untrusted output
      public static var riskTitle: Swift.String { Swift.String(localized: "chat.tool.riskTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Running…
      public static var running: Swift.String { Swift.String(localized: "chat.tool.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show less
      public static var showLess: Swift.String { Swift.String(localized: "chat.tool.showLess", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show more
      public static var showMore: Swift.String { Swift.String(localized: "chat.tool.showMore", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Transcript {
      /// Answer
      public static var answer: Swift.String { Swift.String(localized: "chat.transcript.answer", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// answered
      public static var answered: Swift.String { Swift.String(localized: "chat.transcript.answered", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No messages yet
      public static var empty: Swift.String { Swift.String(localized: "chat.transcript.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Jump to latest
      public static var jumpToLatest: Swift.String { Swift.String(localized: "chat.transcript.jumpToLatest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Loading earlier…
      public static var loadingEarlier: Swift.String { Swift.String(localized: "chat.transcript.loadingEarlier", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} new
      public static func newMessages(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.transcript.newMessages", defaultValue: "\(count) new", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Viewer {
      /// Close image
      public static var close: Swift.String { Swift.String(localized: "chat.viewer.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Download image
      public static var download: Swift.String { Swift.String(localized: "chat.viewer.download", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Opens the full-screen view
      public static var openHint: Swift.String { Swift.String(localized: "chat.viewer.openHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Share image
      public static var share: Swift.String { Swift.String(localized: "chat.viewer.share", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Voice {
      /// Read replies aloud
      public static var autoRead: Swift.String { Swift.String(localized: "chat.voice.autoRead", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Each finished reply in this chat, without being asked.
      public static var autoReadHint: Swift.String { Swift.String(localized: "chat.voice.autoReadHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Code block, {lines} lines
      public static func codeBlock(lines: Swift.Int) -> Swift.String {
        Swift.String(localized: "chat.voice.codeBlock", defaultValue: "Code block, \(lines) lines", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Confirm before sending
      public static var confirmBeforeSending: Swift.String { Swift.String(localized: "chat.voice.confirmBeforeSending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Voice mode shows what it heard for a moment first.
      public static var confirmBeforeSendingHint: Swift.String { Swift.String(localized: "chat.voice.confirmBeforeSendingHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dictate
      public static var dictate: Swift.String { Swift.String(localized: "chat.voice.dictate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Stop dictating
      public static var dictateStop: Swift.String { Swift.String(localized: "chat.voice.dictateStop", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Device language
      public static var dictationAuto: Swift.String { Swift.String(localized: "chat.voice.dictationAuto", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dictation language
      public static var dictationLanguage: Swift.String { Swift.String(localized: "chat.voice.dictationLanguage", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dictation stopped unexpectedly.
      public static var failed: Swift.String { Swift.String(localized: "chat.voice.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// VOICE
      public static var header: Swift.String { Swift.String(localized: "chat.voice.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Listening…
      public static var listening: Swift.String { Swift.String(localized: "chat.voice.listening", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Voice mode
      public static var mode: Swift.String { Swift.String(localized: "chat.voice.mode", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Cancel
      public static var modeCancel: Swift.String { Swift.String(localized: "chat.voice.modeCancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Swipe down to leave
      public static var modeDismiss: Swift.String { Swift.String(localized: "chat.voice.modeDismiss", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Tap to interrupt
      public static var modeInterrupt: Swift.String { Swift.String(localized: "chat.voice.modeInterrupt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Leave voice mode
      public static var modeLeave: Swift.String { Swift.String(localized: "chat.voice.modeLeave", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Listening
      public static var modeListening: Swift.String { Swift.String(localized: "chat.voice.modeListening", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sending
      public static var modeSending: Swift.String { Swift.String(localized: "chat.voice.modeSending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Speaking
      public static var modeSpeaking: Swift.String { Swift.String(localized: "chat.voice.modeSpeaking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Start voice mode
      public static var modeStart: Swift.String { Swift.String(localized: "chat.voice.modeStart", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Waiting for a reply
      public static var modeThinking: Swift.String { Swift.String(localized: "chat.voice.modeThinking", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing was heard.
      public static var noSpeech: Swift.String { Swift.String(localized: "chat.voice.noSpeech", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open Settings
      public static var openSettings: Swift.String { Swift.String(localized: "chat.voice.openSettings", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hermie needs the microphone to take dictation.
      public static var permissionDenied: Swift.String { Swift.String(localized: "chat.voice.permissionDenied", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Speaking rate
      public static var rate: Swift.String { Swift.String(localized: "chat.voice.rate", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum RateOptions {
        /// Fast
        public static var fast: Swift.String { Swift.String(localized: "chat.voice.rateOptions.fast", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Fastest
        public static var fastest: Swift.String { Swift.String(localized: "chat.voice.rateOptions.fastest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Normal
        public static var normal: Swift.String { Swift.String(localized: "chat.voice.rateOptions.normal", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Slow
        public static var slow: Swift.String { Swift.String(localized: "chat.voice.rateOptions.slow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Slowest
        public static var slowest: Swift.String { Swift.String(localized: "chat.voice.rateOptions.slowest", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Stop when the app closes
      public static var stopOnBackground: Swift.String { Swift.String(localized: "chat.voice.stopOnBackground", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Dictation is not available on this device.
      public static var unavailable: Swift.String { Swift.String(localized: "chat.voice.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
  }
  public enum Connectors {
    /// Settings
    public static var back: Swift.String { Swift.String(localized: "connectors.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Connect…
    public static var connect: Swift.String { Swift.String(localized: "connectors.connect", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The authorisation expired before it finished.
    public static var connectExpired: Swift.String { Swift.String(localized: "connectors.connectExpired", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not connect: {reason}
    public static func connectFailed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "connectors.connectFailed", defaultValue: "Could not connect: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Opens your browser. Come back here when you have finished signing in.
    public static var connectHint: Swift.String { Swift.String(localized: "connectors.connectHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// The gateway opened an authorisation but did not say where to send you.
    public static var connectNoUrl: Swift.String { Swift.String(localized: "connectors.connectNoUrl", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// {name} is connected.
    public static func connectOk(name: Swift.String) -> Swift.String {
      Swift.String(localized: "connectors.connectOk", defaultValue: "\(name) is connected.", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// The authorisation was not completed.
    public static var connectSkipped: Swift.String { Swift.String(localized: "connectors.connectSkipped", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Waiting for the browser…
    public static var connecting: Swift.String { Swift.String(localized: "connectors.connecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Detail {
      /// Connectors
      public static var back: Swift.String { Swift.String(localized: "connectors.detail.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Enabled
      public static var enabled: Swift.String { Swift.String(localized: "connectors.detail.enabled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No
      public static var no: Swift.String { Swift.String(localized: "connectors.detail.no", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Identifier
      public static var slug: Swift.String { Swift.String(localized: "connectors.detail.slug", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Status
      public static var status: Swift.String { Swift.String(localized: "connectors.detail.status", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connector
      public static var title: Swift.String { Swift.String(localized: "connectors.detail.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Yes
      public static var yes: Swift.String { Swift.String(localized: "connectors.detail.yes", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Signing out of a connector is done where you manage the account, not from Hermes.
    public static var disconnect: Swift.String { Swift.String(localized: "connectors.disconnect", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// This gateway offers no connectors.
    public static var empty: Swift.String { Swift.String(localized: "connectors.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not read the connectors: {reason}
    public static func failed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "connectors.failed", defaultValue: "Could not read the connectors: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Reading the connectors…
    public static var loading: Swift.String { Swift.String(localized: "connectors.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Reason: {text}
    public static func reason(text: Swift.String) -> Swift.String {
      Swift.String(localized: "connectors.reason", defaultValue: "Reason: \(text)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Reconnect…
    public static var reconnect: Swift.String { Swift.String(localized: "connectors.reconnect", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Refresh
    public static var refresh: Swift.String { Swift.String(localized: "connectors.refresh", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Scope {
      /// CHAT
      public static var header: Swift.String { Swift.String(localized: "connectors.scope.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connectors belong to a chat. This page reads the one you pick.
      public static var hint: Swift.String { Swift.String(localized: "connectors.scope.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No chat is open.
      public static var none: Swift.String { Swift.String(localized: "connectors.scope.none", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Open a chat first — a connector list only exists for a running conversation.
      public static var noneHint: Swift.String { Swift.String(localized: "connectors.scope.noneHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Settings {
      /// Apps a bot can reach on your behalf
      public static var hint: Swift.String { Swift.String(localized: "connectors.settings.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connectors
      public static var row: Swift.String { Swift.String(localized: "connectors.settings.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum State {
      /// Connected
      public static var connected: Swift.String { Swift.String(localized: "connectors.state.connected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Switched off
      public static var disabled: Swift.String { Swift.String(localized: "connectors.state.disabled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Not connected
      public static var notConnected: Swift.String { Swift.String(localized: "connectors.state.notConnected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Unknown
      public static var unknown: Swift.String { Swift.String(localized: "connectors.state.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Apps your bots sign in to.
    public static var subtitle: Swift.String { Swift.String(localized: "connectors.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Connectors
    public static var title: Swift.String { Swift.String(localized: "connectors.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Connectors are switched off for this bot.
    public static var unavailable: Swift.String { Swift.String(localized: "connectors.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Turn on the Connections toolset in the bot’s Capabilities, then come back.
    public static var unavailableHint: Swift.String { Swift.String(localized: "connectors.unavailableHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
  }
  public enum Cron {
    public enum ConfirmDelete {
      /// The schedule is removed from the gateway. Run transcripts already recorded stay where they are.
      public static var body: Swift.String { Swift.String(localized: "cron.confirmDelete.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Keep it
      public static var cancel: Swift.String { Swift.String(localized: "cron.confirmDelete.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete
      public static var confirm: Swift.String { Swift.String(localized: "cron.confirmDelete.confirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// DELETE CRON
      public static var eyebrow: Swift.String { Swift.String(localized: "cron.confirmDelete.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete “{name}”?
      public static func title(name: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.confirmDelete.title", defaultValue: "Delete “\(name)”?", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum ConfirmRun {
      /// The cron runs once, immediately, and delivers wherever it normally delivers. Its schedule is unchanged.
      public static var body: Swift.String { Swift.String(localized: "cron.confirmRun.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "cron.confirmRun.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Run now
      public static var confirm: Swift.String { Swift.String(localized: "cron.confirmRun.confirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// RUN CRON
      public static var eyebrow: Swift.String { Swift.String(localized: "cron.confirmRun.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Run “{name}” now?
      public static func title(name: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.confirmRun.title", defaultValue: "Run “\(name)” now?", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Detail {
      /// ACTIONS
      public static var actions: Swift.String { Swift.String(localized: "cron.detail.actions", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Crons
      public static var back: Swift.String { Swift.String(localized: "cron.detail.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delete cron
      public static var delete: Swift.String { Swift.String(localized: "cron.detail.delete", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delivers to
      public static var deliverLabel: Swift.String { Swift.String(localized: "cron.detail.deliverLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// DETAILS
      public static var details: Swift.String { Swift.String(localized: "cron.detail.details", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit
      public static var edit: Swift.String { Swift.String(localized: "cron.detail.edit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Last error
      public static var errorLabel: Swift.String { Swift.String(localized: "cron.detail.errorLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Instructions
      public static var instructions: Swift.String { Swift.String(localized: "cron.detail.instructions", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Last run
      public static var lastRunLabel: Swift.String { Swift.String(localized: "cron.detail.lastRunLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Last status
      public static var lastStatusLabel: Swift.String { Swift.String(localized: "cron.detail.lastStatusLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Loading…
      public static var loading: Swift.String { Swift.String(localized: "cron.detail.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Loading runs…
      public static var loadingRuns: Swift.String { Swift.String(localized: "cron.detail.loadingRuns", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Model
      public static var modelLabel: Swift.String { Swift.String(localized: "cron.detail.modelLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// NEXT RUN
      public static var nextRun: Swift.String { Swift.String(localized: "cron.detail.nextRun", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This cron runs a script and has no prompt.
      public static var noPrompt: Swift.String { Swift.String(localized: "cron.detail.noPrompt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This cron has not run yet.
      public static var noRuns: Swift.String { Swift.String(localized: "cron.detail.noRuns", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pause
      public static var pause: Swift.String { Swift.String(localized: "cron.detail.pause", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Paused because
      public static var pausedReasonLabel: Swift.String { Swift.String(localized: "cron.detail.pausedReasonLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Until removed
      public static var repeatForever: Swift.String { Swift.String(localized: "cron.detail.repeatForever", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Repeat
      public static var repeatLabel: Swift.String { Swift.String(localized: "cron.detail.repeatLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Resume
      public static var resume: Swift.String { Swift.String(localized: "cron.detail.resume", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// RUN HISTORY
      public static var runHistory: Swift.String { Swift.String(localized: "cron.detail.runHistory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Run now
      public static var runNow: Swift.String { Swift.String(localized: "cron.detail.runNow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Starting…
      public static var running: Swift.String { Swift.String(localized: "cron.detail.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Could not load the run history: {reason}
      public static func runsFailed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.detail.runsFailed", defaultValue: "Could not load the run history: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Schedule
      public static var schedule: Swift.String { Swift.String(localized: "cron.detail.schedule", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Schedule
      public static var scheduleLabel: Swift.String { Swift.String(localized: "cron.detail.scheduleLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Skills
      public static var skillsLabel: Swift.String { Swift.String(localized: "cron.detail.skillsLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// State
      public static var stateLabel: Swift.String { Swift.String(localized: "cron.detail.stateLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// —
      public static var unknown: Swift.String { Swift.String(localized: "cron.detail.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Editor {
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "cron.editor.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New cron
      public static var createTitle: Swift.String { Swift.String(localized: "cron.editor.createTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Delivers to
      public static var deliver: Swift.String { Swift.String(localized: "cron.editor.deliver", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Local (save only)
      public static var deliverLocal: Swift.String { Swift.String(localized: "cron.editor.deliverLocal", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit cron
      public static var editTitle: Swift.String { Swift.String(localized: "cron.editor.editTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Name
      public static var name: Swift.String { Swift.String(localized: "cron.editor.name", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Morning briefing
      public static var namePlaceholder: Swift.String { Swift.String(localized: "cron.editor.namePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Give the cron a name.
      public static var nameRequired: Swift.String { Swift.String(localized: "cron.editor.nameRequired", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway decides the next run; it appears here once saved.
      public static var nextRunHint: Swift.String { Swift.String(localized: "cron.editor.nextRunHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Sends to the gateway as: {schedule}
      public static func preview(schedule: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.editor.preview", defaultValue: "Sends to the gateway as: \(schedule)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Profile
      public static var profile: Swift.String { Swift.String(localized: "cron.editor.profile", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This gateway
      public static var profileDefault: Swift.String { Swift.String(localized: "cron.editor.profileDefault", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Whose cron store the job is written to. It runs as that bot.
      public static var profileHint: Swift.String { Swift.String(localized: "cron.editor.profileHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A cron cannot be moved to another profile after it is created.
      public static var profileLocked: Swift.String { Swift.String(localized: "cron.editor.profileLocked", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Instructions
      public static var prompt: Swift.String { Swift.String(localized: "cron.editor.prompt", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Summarize overnight updates and list three takeaways.
      public static var promptPlaceholder: Swift.String { Swift.String(localized: "cron.editor.promptPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Write the instructions the bot should follow.
      public static var promptRequired: Swift.String { Swift.String(localized: "cron.editor.promptRequired", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Save cron
      public static var save: Swift.String { Swift.String(localized: "cron.editor.save", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway refused the cron: {reason}
      public static func saveFailed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.editor.saveFailed", defaultValue: "The gateway refused the cron: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Saving…
      public static var saving: Swift.String { Swift.String(localized: "cron.editor.saving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Schedule
      public static var schedule: Swift.String { Swift.String(localized: "cron.editor.schedule", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What it does
      public static var what: Swift.String { Swift.String(localized: "cron.editor.what", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Where it goes
      public static var `where`: Swift.String { Swift.String(localized: "cron.editor.where", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Crons will not run: the Hermes gateway process is not running
    public static var gatewayBanner: Swift.String { Swift.String(localized: "cron.gatewayBanner", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum List {
      /// New cron
      public static var add: Swift.String { Swift.String(localized: "cron.list.add", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No crons yet. Create one to have a bot work while you are away.
      public static var empty: Swift.String { Swift.String(localized: "cron.list.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Could not load the crons: {reason}
      public static func failed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.list.failed", defaultValue: "Could not load the crons: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// last
      public static var lastLabel: Swift.String { Swift.String(localized: "cron.list.lastLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Last run {when}
      public static func lastRun(when: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.list.lastRun", defaultValue: "Last run \(when)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Loading crons…
      public static var loading: Swift.String { Swift.String(localized: "cron.list.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Never run
      public static var neverRun: Swift.String { Swift.String(localized: "cron.list.neverRun", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// next
      public static var nextLabel: Swift.String { Swift.String(localized: "cron.list.nextLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Next: {when}
      public static func nextRun(when: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.list.nextRun", defaultValue: "Next: \(when)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Not scheduled
      public static var noNextRun: Swift.String { Swift.String(localized: "cron.list.noNextRun", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Overdue
      public static var overdue: Swift.String { Swift.String(localized: "cron.list.overdue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Profile: {name}
      public static func profile(name: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.list.profile", defaultValue: "Profile: \(name)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Refreshed {when}
      public static func refreshedAt(when: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.list.refreshedAt", defaultValue: "Refreshed \(when)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Not refreshed yet
      public static var refreshedNever: Swift.String { Swift.String(localized: "cron.list.refreshedNever", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Relative {
      /// {value}d ago
      public static func daysAgo(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.daysAgo", defaultValue: "\(value)d ago", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {value}h ago
      public static func hoursAgo(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.hoursAgo", defaultValue: "\(value)h ago", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// in {value}d
      public static func inDays(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.inDays", defaultValue: "in \(value)d", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// in {value}h
      public static func inHours(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.inHours", defaultValue: "in \(value)h", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// in {value} min
      public static func inMinutes(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.inMinutes", defaultValue: "in \(value) min", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// in {value}s
      public static func inSeconds(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.inSeconds", defaultValue: "in \(value)s", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// {value} min ago
      public static func minutesAgo(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.minutesAgo", defaultValue: "\(value) min ago", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// now
      public static var now: Swift.String { Swift.String(localized: "cron.relative.now", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {value}s ago
      public static func secondsAgo(value: Swift.Int) -> Swift.String {
        Swift.String(localized: "cron.relative.secondsAgo", defaultValue: "\(value)s ago", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    public enum Run {
      /// Cron
      public static var back: Swift.String { Swift.String(localized: "cron.run.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This run recorded no messages.
      public static var empty: Swift.String { Swift.String(localized: "cron.run.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Could not load this run: {reason}
      public static func failed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "cron.run.failed", defaultValue: "Could not load this run: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Loading the run…
      public static var loading: Swift.String { Swift.String(localized: "cron.run.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Read-only: a cron run cannot be continued from here.
      public static var readOnly: Swift.String { Swift.String(localized: "cron.run.readOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Run
      public static var title: Swift.String { Swift.String(localized: "cron.run.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Schedule {
      /// Cron expression
      public static var cronExpression: Swift.String { Swift.String(localized: "cron.schedule.cronExpression", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Five fields: minute, hour, day of month, month, day of week.
      public static var cronHint: Swift.String { Swift.String(localized: "cron.schedule.cronHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// 0 9 * * 1-5
      public static var cronPlaceholder: Swift.String { Swift.String(localized: "cron.schedule.cronPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Days
      public static var days: Swift.String { Swift.String(localized: "cron.schedule.days", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No day selected means every day.
      public static var daysHint: Swift.String { Swift.String(localized: "cron.schedule.daysHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Errors {
        /// The {field} field does not accept “{value}”.
        public static func cronField(field: Swift.String, value: Swift.String) -> Swift.String {
          Swift.String(localized: "cron.schedule.errors.cronField", defaultValue: "The \(field) field does not accept “\(value)”.", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// A cron expression has five fields, for example 0 9 * * 1-5.
        public static var cronFieldCount: Swift.String { Swift.String(localized: "cron.schedule.errors.cronFieldCount", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Enter how many minutes, hours or days between runs.
        public static var interval: Swift.String { Swift.String(localized: "cron.schedule.errors.interval", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Enter a delay such as “in 2h”, or a date and time such as 2026-09-20T09:00.
        public static var once: Swift.String { Swift.String(localized: "cron.schedule.errors.once", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Enter a time as HH:MM, for example 09:00.
        public static var time: Swift.String { Swift.String(localized: "cron.schedule.errors.time", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Every
      public static var everyLabel: Swift.String { Swift.String(localized: "cron.schedule.everyLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Repeat
      public static var mode: Swift.String { Swift.String(localized: "cron.schedule.mode", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Modes {
        /// Cron
        public static var cron: Swift.String { Swift.String(localized: "cron.schedule.modes.cron", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Daily
        public static var daily: Swift.String { Swift.String(localized: "cron.schedule.modes.daily", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Interval
        public static var interval: Swift.String { Swift.String(localized: "cron.schedule.modes.interval", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Once
        public static var once: Swift.String { Swift.String(localized: "cron.schedule.modes.once", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// When
      public static var once: Swift.String { Swift.String(localized: "cron.schedule.once", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A delay such as “in 2h”, or a date and time such as 2026-09-20T09:00.
      public static var onceHint: Swift.String { Swift.String(localized: "cron.schedule.onceHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// in 2h
      public static var oncePlaceholder: Swift.String { Swift.String(localized: "cron.schedule.oncePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Time
      public static var time: Swift.String { Swift.String(localized: "cron.schedule.time", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// 09:00
      public static var timePlaceholder: Swift.String { Swift.String(localized: "cron.schedule.timePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Units {
        /// days
        public static var days: Swift.String { Swift.String(localized: "cron.schedule.units.days", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// hours
        public static var hours: Swift.String { Swift.String(localized: "cron.schedule.units.hours", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// minutes
        public static var minutes: Swift.String { Swift.String(localized: "cron.schedule.units.minutes", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      public static var weekdayInitials: [Swift.String] {
        [
          Swift.String(localized: "cron.schedule.weekdayInitials[0]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[1]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[2]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[3]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[4]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[5]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayInitials[6]", table: "Localizable", bundle: HermieStringsLookup.bundle),
        ]
      }
      public static var weekdayNames: [Swift.String] {
        [
          Swift.String(localized: "cron.schedule.weekdayNames[0]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[1]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[2]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[3]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[4]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[5]", table: "Localizable", bundle: HermieStringsLookup.bundle),
          Swift.String(localized: "cron.schedule.weekdayNames[6]", table: "Localizable", bundle: HermieStringsLookup.bundle),
        ]
      }
    }
    public enum Sections {
      /// ACTIVE
      public static var active: Swift.String { Swift.String(localized: "cron.sections.active", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// PAUSED
      public static var paused: Swift.String { Swift.String(localized: "cron.sections.paused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Status {
      /// Failed
      public static var failed: Swift.String { Swift.String(localized: "cron.status.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Success
      public static var ok: Swift.String { Swift.String(localized: "cron.status.ok", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Paused
      public static var paused: Swift.String { Swift.String(localized: "cron.status.paused", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Waiting
      public static var pending: Swift.String { Swift.String(localized: "cron.status.pending", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Running
      public static var running: Swift.String { Swift.String(localized: "cron.status.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// A little progress, on repeat.
    public static var subtitle: Swift.String { Swift.String(localized: "cron.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Crons
    public static var title: Swift.String { Swift.String(localized: "cron.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
  }
  public enum Kanban {
    /// This gateway has no Kanban plugin.
    public static var absent: Swift.String { Swift.String(localized: "kanban.absent", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// hermes plugins install kanban
    public static var absentCommand: Swift.String { Swift.String(localized: "kanban.absentCommand", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Install it on the machine that runs the gateway:
    public static var absentHint: Swift.String { Swift.String(localized: "kanban.absentHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Settings
    public static var back: Swift.String { Swift.String(localized: "kanban.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Board {
      /// Boards
      public static var back: Swift.String { Swift.String(localized: "kanban.board.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing here.
      public static var columnEmpty: Swift.String { Swift.String(localized: "kanban.board.columnEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing on this board yet.
      public static var empty: Swift.String { Swift.String(localized: "kanban.board.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Hide archived
      public static var hideArchived: Swift.String { Swift.String(localized: "kanban.board.hideArchived", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reading the board…
      public static var loading: Swift.String { Swift.String(localized: "kanban.board.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New card
      public static var newCard: Swift.String { Swift.String(localized: "kanban.board.newCard", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Show archived
      public static var showArchived: Swift.String { Swift.String(localized: "kanban.board.showArchived", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// {count} cards
    public static func boardCards(count: Swift.Int) -> Swift.String {
      Swift.String(localized: "kanban.boardCards", defaultValue: "\(count) cards", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    public enum Card {
      /// Archive
      public static var archive: Swift.String { Swift.String(localized: "kanban.card.archive", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Archiving keeps the card and its history. It is not a delete.
      public static var archiveHint: Swift.String { Swift.String(localized: "kanban.card.archiveHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Archived.
      public static var archived: Swift.String { Swift.String(localized: "kanban.card.archived", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Archiving…
      public static var archiving: Swift.String { Swift.String(localized: "kanban.card.archiving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Assignee
      public static var assignee: Swift.String { Swift.String(localized: "kanban.card.assignee", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Board
      public static var back: Swift.String { Swift.String(localized: "kanban.card.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Notes
      public static var body: Swift.String { Swift.String(localized: "kanban.card.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Column
      public static var column: Swift.String { Swift.String(localized: "kanban.card.column", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Created
      public static var created: Swift.String { Swift.String(localized: "kanban.card.created", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Priority
      public static var priority: Swift.String { Swift.String(localized: "kanban.card.priority", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Save
      public static var save: Swift.String { Swift.String(localized: "kanban.card.save", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Saved.
      public static var saved: Swift.String { Swift.String(localized: "kanban.card.saved", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Saving…
      public static var saving: Swift.String { Swift.String(localized: "kanban.card.saving", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// LATEST SUMMARY
      public static var summary: Swift.String { Swift.String(localized: "kanban.card.summary", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Title
      public static var title: Swift.String { Swift.String(localized: "kanban.card.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Columns {
      /// Archived
      public static var archived: Swift.String { Swift.String(localized: "kanban.columns.archived", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Blocked
      public static var blocked: Swift.String { Swift.String(localized: "kanban.columns.blocked", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Done
      public static var done: Swift.String { Swift.String(localized: "kanban.columns.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Ready
      public static var ready: Swift.String { Swift.String(localized: "kanban.columns.ready", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Review
      public static var review: Swift.String { Swift.String(localized: "kanban.columns.review", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Running
      public static var running: Swift.String { Swift.String(localized: "kanban.columns.running", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Scheduled
      public static var scheduled: Swift.String { Swift.String(localized: "kanban.columns.scheduled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// To do
      public static var todo: Swift.String { Swift.String(localized: "kanban.columns.todo", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Triage
      public static var triage: Swift.String { Swift.String(localized: "kanban.columns.triage", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The entry for a key that arrives at run time, or nil for one this table does not have.
      public static subscript(key: Swift.String) -> Swift.String? {
        switch key {
        case "archived": archived
        case "blocked": blocked
        case "done": done
        case "ready": ready
        case "review": review
        case "running": running
        case "scheduled": scheduled
        case "todo": todo
        case "triage": triage
        default: nil
        }
      }
    }
    public enum Comments {
      /// Comment
      public static var add: Swift.String { Swift.String(localized: "kanban.comments.add", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Posting…
      public static var adding: Swift.String { Swift.String(localized: "kanban.comments.adding", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// COMMENTS
      public static var header: Swift.String { Swift.String(localized: "kanban.comments.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No comments yet.
      public static var none: Swift.String { Swift.String(localized: "kanban.comments.none", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Add a comment
      public static var placeholder: Swift.String { Swift.String(localized: "kanban.comments.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Create {
      /// Notes
      public static var bodyField: Swift.String { Swift.String(localized: "kanban.create.bodyField", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// COLUMN
      public static var column: Swift.String { Swift.String(localized: "kanban.create.column", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A card needs a title.
      public static var needsTitle: Swift.String { Swift.String(localized: "kanban.create.needsTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Make the card
      public static var submit: Swift.String { Swift.String(localized: "kanban.create.submit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Making it…
      public static var submitting: Swift.String { Swift.String(localized: "kanban.create.submitting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New card
      public static var title: Swift.String { Swift.String(localized: "kanban.create.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Title
      public static var titleField: Swift.String { Swift.String(localized: "kanban.create.titleField", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What needs doing
      public static var titlePlaceholder: Swift.String { Swift.String(localized: "kanban.create.titlePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Hold a card to pick it up, then drop it on a column.
    public static var dragHint: Swift.String { Swift.String(localized: "kanban.dragHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Hold to pick this card up, or use Move to…
    public static var dragLabel: Swift.String { Swift.String(localized: "kanban.dragLabel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// This gateway has no boards yet.
    public static var empty: Swift.String { Swift.String(localized: "kanban.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Make one with `hermes kanban board create`, or from the Hermes desktop app.
    public static var emptyHint: Swift.String { Swift.String(localized: "kanban.emptyHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not read the boards: {reason}
    public static func failed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "kanban.failed", defaultValue: "Could not read the boards: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Reading the boards…
    public static var loading: Swift.String { Swift.String(localized: "kanban.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Running, Review and Scheduled are the dispatcher’s. A card can leave them but not be put into them.
    public static var locked: Swift.String { Swift.String(localized: "kanban.locked", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// {column} is the dispatcher’s. A card cannot be put there.
    public static func lockedTarget(column: Swift.String) -> Swift.String {
      Swift.String(localized: "kanban.lockedTarget", defaultValue: "\(column) is the dispatcher’s. A card cannot be put there.", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Boards
    public static var menu: Swift.String { Swift.String(localized: "kanban.menu", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Move to…
    public static var move: Swift.String { Swift.String(localized: "kanban.move", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// {reason}
    public static func moveRefused(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "kanban.moveRefused", defaultValue: "\(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Moved to {column}.
    public static func moved(column: Swift.String) -> Swift.String {
      Swift.String(localized: "kanban.moved", defaultValue: "Moved to \(column).", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Asked for {asked}; the board put it in {got}.
    public static func movedElsewhere(asked: Swift.String, got: Swift.String) -> Swift.String {
      Swift.String(localized: "kanban.movedElsewhere", defaultValue: "Asked for \(asked); the board put it in \(got).", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Cards are ordered by priority and age, so there is no order to drag within a column.
    public static var noOrder: Swift.String { Swift.String(localized: "kanban.noOrder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Settings {
      /// The Kanban boards this gateway keeps
      public static var hint: Swift.String { Swift.String(localized: "kanban.settings.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Boards
      public static var row: Swift.String { Swift.String(localized: "kanban.settings.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Work your bots pick up.
    public static var subtitle: Swift.String { Swift.String(localized: "kanban.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Boards
    public static var title: Swift.String { Swift.String(localized: "kanban.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
  }
  public enum Mcp {
    /// Authorise…
    public static var authorise: Swift.String { Swift.String(localized: "mcp.authorise", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Authorisation did not finish: {reason}
    public static func authoriseFailed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "mcp.authoriseFailed", defaultValue: "Authorisation did not finish: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Opens your browser. Come back here when you have finished signing in.
    public static var authoriseHint: Swift.String { Swift.String(localized: "mcp.authoriseHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Authorised.
    public static var authoriseOk: Swift.String { Swift.String(localized: "mcp.authoriseOk", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Waiting for the browser…
    public static var authorising: Swift.String { Swift.String(localized: "mcp.authorising", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Settings
    public static var back: Swift.String { Swift.String(localized: "mcp.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Detail {
      /// Address
      public static var address: Swift.String { Swift.String(localized: "mcp.detail.address", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Authentication
      public static var auth: Swift.String { Swift.String(localized: "mcp.detail.auth", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// None
      public static var authNone: Swift.String { Swift.String(localized: "mcp.detail.authNone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// MCP servers
      public static var back: Swift.String { Swift.String(localized: "mcp.detail.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// ENVIRONMENT KEYS
      public static var env: Swift.String { Swift.String(localized: "mcp.detail.env", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway never sends their values — only which keys this server expects.
      public static var envHint: Swift.String { Swift.String(localized: "mcp.detail.envHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// MCP server
      public static var title: Swift.String { Swift.String(localized: "mcp.detail.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// TOOLS
      public static var tools: Swift.String { Swift.String(localized: "mcp.detail.tools", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This server offered no tools.
      public static var toolsEmpty: Swift.String { Swift.String(localized: "mcp.detail.toolsEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Test the connection to see what this server offers.
      public static var toolsUnknown: Swift.String { Swift.String(localized: "mcp.detail.toolsUnknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Transport
      public static var transport: Swift.String { Swift.String(localized: "mcp.detail.transport", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// No MCP servers are configured on this gateway.
    public static var empty: Swift.String { Swift.String(localized: "mcp.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Add one with `hermes mcp add`, or from the Hermes desktop app.
    public static var emptyHint: Swift.String { Swift.String(localized: "mcp.emptyHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not read the servers: {reason}
    public static func failed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "mcp.failed", defaultValue: "Could not read the servers: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Reading the server list…
    public static var loading: Swift.String { Swift.String(localized: "mcp.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Needs authorising
    public static var needsAuth: Swift.String { Swift.String(localized: "mcp.needsAuth", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Reload servers
    public static var reload: Swift.String { Swift.String(localized: "mcp.reload", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Applies configuration changes to chats that are already running.
    public static var reloadHint: Swift.String { Swift.String(localized: "mcp.reloadHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Runtime {
      /// Configured
      public static var configured: Swift.String { Swift.String(localized: "mcp.runtime.configured", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connected
      public static var connected: Swift.String { Swift.String(localized: "mcp.runtime.connected", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Connecting…
      public static var connecting: Swift.String { Swift.String(localized: "mcp.runtime.connecting", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Switched off
      public static var disabled: Swift.String { Swift.String(localized: "mcp.runtime.disabled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Not connected
      public static var failed: Swift.String { Swift.String(localized: "mcp.runtime.failed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Starts when needed
      public static var lazy: Swift.String { Swift.String(localized: "mcp.runtime.lazy", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Not started yet
      public static var unknown: Swift.String { Swift.String(localized: "mcp.runtime.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Settings {
      /// Tools your bots reach over the Model Context Protocol
      public static var hint: Swift.String { Swift.String(localized: "mcp.settings.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// MCP servers
      public static var row: Swift.String { Swift.String(localized: "mcp.settings.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Tools your bots can reach.
    public static var subtitle: Swift.String { Swift.String(localized: "mcp.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Test connection
    public static var test: Swift.String { Swift.String(localized: "mcp.test", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not connect: {reason}
    public static func testFailed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "mcp.testFailed", defaultValue: "Could not connect: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Connected. {count} tools available.
    public static func testOk(count: Swift.Int) -> Swift.String {
      Swift.String(localized: "mcp.testOk", defaultValue: "Connected. \(count) tools available.", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Connecting…
    public static var testing: Swift.String { Swift.String(localized: "mcp.testing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// MCP servers
    public static var title: Swift.String { Swift.String(localized: "mcp.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// {count} tools
    public static func toolCount(count: Swift.Int) -> Swift.String {
      Swift.String(localized: "mcp.toolCount", defaultValue: "\(count) tools", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
  }
  public enum Memory {
    public enum Add {
      /// Add
      public static var action: Swift.String { Swift.String(localized: "memory.add.action", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Add to {target}
      public static func label(target: Swift.String) -> Swift.String {
        Swift.String(localized: "memory.add.label", defaultValue: "Add to \(target)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Write something down
      public static var placeholder: Swift.String { Swift.String(localized: "memory.add.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// No bots yet.
    public static var botsEmpty: Swift.String { Swift.String(localized: "memory.botsEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Read and edit what each bot remembers.
    public static var botsHint: Swift.String { Swift.String(localized: "memory.botsHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Memory
    public static var botsTitle: Swift.String { Swift.String(localized: "memory.botsTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Edit {
      /// Edit
      public static var action: Swift.String { Swift.String(localized: "memory.edit.action", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "memory.edit.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Edit entry {index|add(1)}
      public static func label(index: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.edit.label", defaultValue: "Edit entry \(index + 1)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Replace
      public static var save: Swift.String { Swift.String(localized: "memory.edit.save", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Empty {
      /// Nothing written down yet.
      public static var memory: Swift.String { Swift.String(localized: "memory.empty.memory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing written down about you yet.
      public static var user: Swift.String { Swift.String(localized: "memory.empty.user", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Could not read this memory: {reason}
    public static func failed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "memory.failed", defaultValue: "Could not read this memory: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// {name}'s memory
    public static func forBot(name: Swift.String) -> Swift.String {
      Swift.String(localized: "memory.forBot", defaultValue: "\(name)'s memory", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    public enum Graph {
      public enum Detail {
        /// Close
        public static var close: Swift.String { Swift.String(localized: "memory.graph.detail.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Entry
        public static var entry: Swift.String { Swift.String(localized: "memory.graph.detail.entry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// No topics in this entry.
        public static var noTopics: Swift.String { Swift.String(localized: "memory.graph.detail.noTopics", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Show in the list
        public static var `open`: Swift.String { Swift.String(localized: "memory.graph.detail.open", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// This bot
        public static var profile: Swift.String { Swift.String(localized: "memory.graph.detail.profile", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Topic
        public static var topic: Swift.String { Swift.String(localized: "memory.graph.detail.topic", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// MENTIONS
        public static var topics: Swift.String { Swift.String(localized: "memory.graph.detail.topics", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// {count} more nodes were left out of the drawing.
      public static func dropped(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.graph.dropped", defaultValue: "\(count) more nodes were left out of the drawing.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Nothing to draw yet.
      public static var empty: Swift.String { Swift.String(localized: "memory.graph.empty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Full {
        /// Close
        public static var close: Swift.String { Swift.String(localized: "memory.graph.full.close", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Close the graph
        public static var dismiss: Swift.String { Swift.String(localized: "memory.graph.full.dismiss", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Open full screen
        public static var `open`: Swift.String { Swift.String(localized: "memory.graph.full.open", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Memory graph
        public static var title: Swift.String { Swift.String(localized: "memory.graph.full.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// A map of this memory: the bot, its entries and the topics they share
      public static var label: Swift.String { Swift.String(localized: "memory.graph.label", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Drawing…
      public static var loading: Swift.String { Swift.String(localized: "memory.graph.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reset
      public static var reset: Swift.String { Swift.String(localized: "memory.graph.reset", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Showing {shown} of {total} entries. The rest are not on this page of the map.
      public static func truncated(shown: Swift.Int, total: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.graph.truncated", defaultValue: "Showing \(shown) of \(total) entries. The rest are not on this page of the map.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Zoom in
      public static var zoomIn: Swift.String { Swift.String(localized: "memory.graph.zoomIn", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Zoom out
      public static var zoomOut: Swift.String { Swift.String(localized: "memory.graph.zoomOut", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Reading memory…
    public static var loading: Swift.String { Swift.String(localized: "memory.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Missing {
      /// Reading a bot’s memory needs the hermie plugin, version 0.5.0 or newer, installed on the gateway and enabled for this profile.
      public static var body: Swift.String { Swift.String(localized: "memory.missing.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Read the guide
      public static var guide: Swift.String { Swift.String(localized: "memory.missing.guide", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// ON THE GATEWAY
      public static var install: Swift.String { Swift.String(localized: "memory.missing.install", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The Hermie plugin has no memory browser
      public static var title: Swift.String { Swift.String(localized: "memory.missing.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Waiting for the gateway to say what is installed…
      public static var unknown: Swift.String { Swift.String(localized: "memory.missing.unknown", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Providers {
      /// PROVIDERS
      public static var header: Swift.String { Swift.String(localized: "memory.providers.header", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// An external memory provider answers a bot with text for one turn. It offers no call that lists what it holds, so there is nothing here to show.
      public static var hint: Swift.String { Swift.String(localized: "memory.providers.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Not browsable
      public static var notBrowsable: Swift.String { Swift.String(localized: "memory.providers.notBrowsable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Raw {
      /// {chars} characters
      public static func chars(chars: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.raw.chars", defaultValue: "\(chars) characters", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// This one is empty.
      public static var emptyDocument: Swift.String { Swift.String(localized: "memory.raw.emptyDocument", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Reading what each backend holds…
      public static var loading: Swift.String { Swift.String(localized: "memory.raw.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This gateway’s Hermie plugin does not serve raw memory.
      public static var missing: Swift.String { Swift.String(localized: "memory.raw.missing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// hermes plugins install hermie
      public static var missingCommand: Swift.String { Swift.String(localized: "memory.raw.missingCommand", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Update the plugin on the machine that runs the gateway:
      public static var missingHint: Swift.String { Swift.String(localized: "memory.raw.missingHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This gateway named no memory backends.
      public static var none: Swift.String { Swift.String(localized: "memory.raw.none", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This backend cannot say what it holds.
      public static var notListable: Swift.String { Swift.String(localized: "memory.raw.notListable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Read-only. Entries are edited on the Entries tab.
      public static var readOnly: Swift.String { Swift.String(localized: "memory.raw.readOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway sent only the beginning of this one.
      public static var truncated: Swift.String { Swift.String(localized: "memory.raw.truncated", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This backend is not available on this gateway.
      public static var unavailable: Swift.String { Swift.String(localized: "memory.raw.unavailable", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// This gateway lets memory be read and not written. Switch on the plugin’s memory.edit for this profile to change that.
    public static var readOnly: Swift.String { Swift.String(localized: "memory.readOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Remove {
      /// Remove
      public static var action: Swift.String { Swift.String(localized: "memory.remove.action", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Keep it
      public static var cancel: Swift.String { Swift.String(localized: "memory.remove.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove
      public static var confirm: Swift.String { Swift.String(localized: "memory.remove.confirm", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The bot stops being told this. Hermes keeps no history of a memory file.
      public static var confirmBody: Swift.String { Swift.String(localized: "memory.remove.confirmBody", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove this entry?
      public static var confirmTitle: Swift.String { Swift.String(localized: "memory.remove.confirmTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Remove entry {index|add(1)}
      public static func label(index: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.remove.label", defaultValue: "Remove entry \(index + 1)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
    }
    /// Try again
    public static var retry: Swift.String { Swift.String(localized: "memory.retry", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// What this bot remembers about its work, and about you.
    public static var rowHint: Swift.String { Swift.String(localized: "memory.rowHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Memory
    public static var rowTitle: Swift.String { Swift.String(localized: "memory.rowTitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Search {
      /// Clear
      public static var clear: Swift.String { Swift.String(localized: "memory.search.clear", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {found} entries
      public static func count(found: Swift.Int) -> Swift.String {
        Swift.String(localized: "memory.search.count", defaultValue: "\(found) entries", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Every word has to appear somewhere in the entry. Order does not matter.
      public static var hint: Swift.String { Swift.String(localized: "memory.search.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Nothing matches “{query}”.
      public static func none(query: Swift.String) -> Swift.String {
        Swift.String(localized: "memory.search.none", defaultValue: "Nothing matches “\(query)”.", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Search this memory
      public static var placeholder: Swift.String { Swift.String(localized: "memory.search.placeholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Searching…
      public static var searching: Swift.String { Swift.String(localized: "memory.search.searching", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum SectionHint {
      /// What the bot has written down about its work. Hermes' own MEMORY.md.
      public static var memory: Swift.String { Swift.String(localized: "memory.sectionHint.memory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What the bot has written down about you. USER.md.
      public static var user: Swift.String { Swift.String(localized: "memory.sectionHint.user", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Sections {
      /// MEMORY
      public static var memory: Swift.String { Swift.String(localized: "memory.sections.memory", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// USER
      public static var user: Swift.String { Swift.String(localized: "memory.sections.user", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Tabs {
      /// Entries
      public static var entries: Swift.String { Swift.String(localized: "memory.tabs.entries", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Graph
      public static var graph: Swift.String { Swift.String(localized: "memory.tabs.graph", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Raw
      public static var raw: Swift.String { Swift.String(localized: "memory.tabs.raw", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Memory
    public static var title: Swift.String { Swift.String(localized: "memory.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// {chars} of {limit} characters
    public static func usage(chars: Swift.Int, limit: Swift.Int) -> Swift.String {
      Swift.String(localized: "memory.usage", defaultValue: "\(chars) of \(limit) characters", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// {target} is {percent}% full
    public static func usageLabel(target: Swift.String, percent: Swift.Int) -> Swift.String {
      Swift.String(localized: "memory.usageLabel", defaultValue: "\(target) is \(percent)% full", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// {chars} characters
    public static func usageUnbounded(chars: Swift.Int) -> Swift.String {
      Swift.String(localized: "memory.usageUnbounded", defaultValue: "\(chars) characters", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
  }
  public enum Profiles {
    public enum Capabilities {
      /// Could not read the configuration: {reason}
      public static func failed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "profiles.capabilities.failed", defaultValue: "Could not read the configuration: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Reading this bot’s configuration…
      public static var loading: Swift.String { Swift.String(localized: "profiles.capabilities.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Manage servers…
      public static var manageMcp: Swift.String { Swift.String(localized: "profiles.capabilities.manageMcp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// MCP SERVERS
      public static var mcp: Swift.String { Swift.String(localized: "profiles.capabilities.mcp", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No MCP servers configured on this gateway.
      public static var mcpEmpty: Swift.String { Swift.String(localized: "profiles.capabilities.mcpEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Switching a server on here makes its tools available to this bot.
      public static var mcpFooter: Swift.String { Swift.String(localized: "profiles.capabilities.mcpFooter", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      public enum Reload {
        /// Reload, and stop asking
        public static var always: Swift.String { Swift.String(localized: "profiles.capabilities.reload.always", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Stops the gateway asking again — in the CLI and the desktop app too.
        public static var alwaysHint: Swift.String { Swift.String(localized: "profiles.capabilities.reload.alwaysHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// MCP servers reload for every live chat. The next message in each one re-sends its full input.
        public static var body: Swift.String { Swift.String(localized: "profiles.capabilities.reload.body", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// MCP servers reloaded.
        public static var done: Swift.String { Swift.String(localized: "profiles.capabilities.reload.done", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// MCP reload
        public static var eyebrow: Swift.String { Swift.String(localized: "profiles.capabilities.reload.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Could not reload: {reason}
        public static func failed(reason: Swift.String) -> Swift.String {
          Swift.String(localized: "profiles.capabilities.reload.failed", defaultValue: "Could not reload: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
        }
        /// Not now
        public static var later: Swift.String { Swift.String(localized: "profiles.capabilities.reload.later", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Reload now
        public static var now: Swift.String { Swift.String(localized: "profiles.capabilities.reload.now", table: "Localizable", bundle: HermieStringsLookup.bundle) }
        /// Apply to running chats?
        public static var title: Swift.String { Swift.String(localized: "profiles.capabilities.reload.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      }
      /// Capabilities
      public static var row: Swift.String { Swift.String(localized: "profiles.capabilities.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Skills, tools and MCP servers for this bot
      public static var rowDetail: Swift.String { Swift.String(localized: "profiles.capabilities.rowDetail", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// The gateway refused the change: {reason}
      public static func saveFailed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "profiles.capabilities.saveFailed", defaultValue: "The gateway refused the change: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// SKILLS
      public static var skills: Swift.String { Swift.String(localized: "profiles.capabilities.skills", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// No skills installed for this bot.
      public static var skillsEmpty: Swift.String { Swift.String(localized: "profiles.capabilities.skillsEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Skills are folders of instructions the bot can open when it needs them.
      public static var skillsFooter: Swift.String { Swift.String(localized: "profiles.capabilities.skillsFooter", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Capabilities
      public static var title: Swift.String { Swift.String(localized: "profiles.capabilities.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// {count} tools
      public static func toolCount(count: Swift.Int) -> Swift.String {
        Swift.String(localized: "profiles.capabilities.toolCount", defaultValue: "\(count) tools", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// TOOLSETS
      public static var toolsets: Swift.String { Swift.String(localized: "profiles.capabilities.toolsets", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Pinned for this bot.
      public static var toolsetsPinned: Swift.String { Swift.String(localized: "profiles.capabilities.toolsetsPinned", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This bot follows the gateway’s defaults. Changing a switch pins the whole list.
      public static var toolsetsUnpinned: Swift.String { Swift.String(localized: "profiles.capabilities.toolsetsUnpinned", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum New {
      /// Cancel
      public static var cancel: Swift.String { Swift.String(localized: "profiles.new.cancel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Clone settings from
      public static var cloneFrom: Swift.String { Swift.String(localized: "profiles.new.cloneFrom", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A clone copies the source bot’s skills, tools and MCP switches. Its messaging accounts are never copied — two bots cannot hold one Telegram token.
      public static var cloneHint: Swift.String { Swift.String(localized: "profiles.new.cloneHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Start fresh
      public static var cloneNone: Swift.String { Swift.String(localized: "profiles.new.cloneNone", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Create bot
      public static var create: Swift.String { Swift.String(localized: "profiles.new.create", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Making the bot…
      public static var creating: Swift.String { Swift.String(localized: "profiles.new.creating", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Description
      public static var description: Swift.String { Swift.String(localized: "profiles.new.description", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Looks things up before anyone asks.
      public static var descriptionPlaceholder: Swift.String { Swift.String(localized: "profiles.new.descriptionPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Display name
      public static var displayName: Swift.String { Swift.String(localized: "profiles.new.displayName", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// What Hermie shows in the list. Leave it blank to use the handle.
      public static var displayNameHint: Swift.String { Swift.String(localized: "profiles.new.displayNameHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Scout
      public static var displayNamePlaceholder: Swift.String { Swift.String(localized: "profiles.new.displayNamePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A bot of your own
      public static var eyebrow: Swift.String { Swift.String(localized: "profiles.new.eyebrow", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Could not make the bot: {reason}
      public static func failed(reason: Swift.String) -> Swift.String {
        Swift.String(localized: "profiles.new.failed", defaultValue: "Could not make the bot: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
      }
      /// Handle
      public static var handle: Swift.String { Swift.String(localized: "profiles.new.handle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Lower case, no spaces. This is the name the gateway knows it by, and it cannot be changed later.
      public static var handleHint: Swift.String { Swift.String(localized: "profiles.new.handleHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// scout
      public static var handlePlaceholder: Swift.String { Swift.String(localized: "profiles.new.handlePlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Model
      public static var model: Swift.String { Swift.String(localized: "profiles.new.model", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// A new bot inherits the gateway’s own model unless you pin one here.
      public static var modelHint: Swift.String { Swift.String(localized: "profiles.new.modelHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Inherit from the launch bot
      public static var modelInherit: Swift.String { Swift.String(localized: "profiles.new.modelInherit", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New bot
      public static var title: Swift.String { Swift.String(localized: "profiles.new.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// This bot has no model yet. Pick one in its profile before you write to it.
      public static var withoutModel: Swift.String { Swift.String(localized: "profiles.new.withoutModel", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    public enum Settings {
      /// Bots
      public static var group: Swift.String { Swift.String(localized: "profiles.settings.group", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// New bot…
      public static var newBot: Swift.String { Swift.String(localized: "profiles.settings.newBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Make another bot on this gateway
      public static var newBotHint: Swift.String { Swift.String(localized: "profiles.settings.newBotHint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
  }
  public enum Skills {
    /// Installed
    public static var alreadyInstalled: Swift.String { Swift.String(localized: "skills.alreadyInstalled", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Settings
    public static var back: Swift.String { Swift.String(localized: "skills.back", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Bot
    public static var botPicker: Swift.String { Swift.String(localized: "skills.botPicker", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// CATALOGUE
    public static var catalogue: Swift.String { Swift.String(localized: "skills.catalogue", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Nothing matched.
    public static var catalogueEmpty: Swift.String { Swift.String(localized: "skills.catalogueEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// This gateway cannot install skills over its socket. Run this on the machine that hosts it:
    public static var cliOnly: Swift.String { Swift.String(localized: "skills.cliOnly", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not read the skills: {reason}
    public static func failed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "skills.failed", defaultValue: "Could not read the skills: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Switches are for {name}.
    public static func forBot(name: Swift.String) -> Swift.String {
      Swift.String(localized: "skills.forBot", defaultValue: "Switches are for \(name).", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Install
    public static var install: Swift.String { Swift.String(localized: "skills.install", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not install: {reason}
    public static func installFailed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "skills.installFailed", defaultValue: "Could not install: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// INSTALLED
    public static var installed: Swift.String { Swift.String(localized: "skills.installed", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// No skills installed yet.
    public static var installedEmpty: Swift.String { Swift.String(localized: "skills.installedEmpty", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// A skill is a folder of instructions a bot opens when it needs them.
    public static var installedFooter: Swift.String { Swift.String(localized: "skills.installedFooter", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Installed {name}.
    public static func installed_(name: Swift.String) -> Swift.String {
      Swift.String(localized: "skills.installed_", defaultValue: "Installed \(name).", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
    /// Installing…
    public static var installing: Swift.String { Swift.String(localized: "skills.installing", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Reading the skills…
    public static var loading: Swift.String { Swift.String(localized: "skills.loading", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Pick a bot to switch skills on and off for it.
    public static var noBot: Swift.String { Swift.String(localized: "skills.noBot", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Search the hub
    public static var search: Swift.String { Swift.String(localized: "skills.search", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// pdf, spreadsheets, video…
    public static var searchPlaceholder: Swift.String { Swift.String(localized: "skills.searchPlaceholder", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Searching…
    public static var searching: Swift.String { Swift.String(localized: "skills.searching", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    public enum Settings {
      /// What your bots know how to do
      public static var hint: Swift.String { Swift.String(localized: "skills.settings.hint", table: "Localizable", bundle: HermieStringsLookup.bundle) }
      /// Skills
      public static var row: Swift.String { Swift.String(localized: "skills.settings.row", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    }
    /// Instructions your bots can open.
    public static var subtitle: Swift.String { Swift.String(localized: "skills.subtitle", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Skills
    public static var title: Swift.String { Swift.String(localized: "skills.title", table: "Localizable", bundle: HermieStringsLookup.bundle) }
    /// Could not change that: {reason}
    public static func toggleFailed(reason: Swift.String) -> Swift.String {
      Swift.String(localized: "skills.toggleFailed", defaultValue: "Could not change that: \(reason)", table: "Localizable", bundle: HermieStringsLookup.bundle)
    }
  }
}

/// Where the accessors look their text up. A test reads another language by binding a
/// localization's own bundle (`nl.lproj`) for the duration of a call.
enum HermieStringsLookup {
  @TaskLocal static var bundle: Foundation.Bundle = .module
}

/// `list(separator, last)` from the template language: "a, b or c".
private func hermieJoinList(_ items: [Swift.String], _ separator: Swift.String, _ last: Swift.String) -> Swift.String {
  guard items.count > 1, let final = items.last else { return items.first ?? "" }
  return items.dropLast().joined(separator: separator) + last + final
}
