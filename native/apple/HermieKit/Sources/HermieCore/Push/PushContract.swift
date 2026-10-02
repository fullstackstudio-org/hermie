import Foundation

/**
 The push contract (`contract/push/contract.json`, D31) as this build knows it: the types, the
 category an approval is posted under, and its two actions. A test reads the contract file and fails
 when it names an action, a type or a flag this file does not.

 Also the ids that came before the contract (`expo/hermie/src/features/push/platform-contract.ts`),
 which an older sender may still put on a notification while both generations are in use.
 */
public enum PushContract {
  /// The data `type`s, in the order the switches are drawn in.
  public static let types = ["message", "request", "cron", "cron_done", "cron_failed", "turn_done", "turn_failed"]

  /// The category an approval is posted under, so it grows the two buttons.
  public static let requestCategory = "hermie.request"

  /// The same notification's category from senders older than the contract: `request` (the gateway
  /// plugin sent the type) and `hermie.approval` (Hermie Web). Registered with the same actions.
  public static let legacyRequestCategories = ["request", "hermie.approval"]

  /// The payload types whose notifications carry the actions.
  public static let typesWithActions = ["request"]

  /**
   TEMPORARY, against the contract: both actions bring the app to the front.

   The contract registers them as background actions, which assumes an app that can re-read the
   open request and answer it without being seen. Until the session layer can do that from a
   background launch, an action that stayed in the background would answer nothing and show
   nothing; in front, the reader at least lands in the chat (as with the Expo app, which also opened
   the app for both). Set this to false once background answering works.
   */
  public static let actionsForegroundOverride = true

  /// The two buttons. Neither answers anything by itself: the app re-reads the open request and
  /// answers only one that is still open and still says what the notification said.
  public enum Action: String, Sendable, CaseIterable {
    case allow = "hermie.request.allow"
    case deny = "hermie.request.deny"

    /// The contract's English title; the app shows a localised one.
    public var contractTitle: String {
      switch self {
      case .allow: "Allow"
      case .deny: "Deny"
      }
    }

    public var destructive: Bool { self == .deny }

    /// What the contract says: no, the action is handled without bringing the app to the front.
    public var contractForeground: Bool { false }

    /// What this build registers: the contract's value, unless `actionsForegroundOverride` is on.
    public var foreground: Bool { contractForeground || PushContract.actionsForegroundOverride }

    /// The action ids the Expo app 0.1.9 registered for the same buttons.
    public var legacyIdentifier: String {
      switch self {
      case .allow: "allow"
      case .deny: "deny"
      }
    }

    /// The action an identifier names, in either spelling, or nil (a plain open, a dismissal).
    public init?(identifier: String) {
      guard let action = Action.allCases.first(where: { $0.rawValue == identifier || $0.legacyIdentifier == identifier })
      else {
        return nil
      }

      self = action
    }
  }
}

/// One notification action as the system needs it, without the UserNotifications types (which are
/// not `Sendable` and need a bundle), so the shape is tested on its own.
public struct PushActionDescriptor: Sendable, Equatable {
  public var identifier: String
  public var title: String
  public var destructive: Bool
  public var foreground: Bool
  /// Asked for every action: an answer to an agent's request is never given from a locked device.
  public var requiresAuthentication: Bool

  public init(identifier: String, title: String, destructive: Bool, foreground: Bool, requiresAuthentication: Bool) {
    self.identifier = identifier
    self.title = title
    self.destructive = destructive
    self.foreground = foreground
    self.requiresAuthentication = requiresAuthentication
  }
}

/// One notification category as the system needs it.
public struct PushCategoryDescriptor: Sendable, Equatable {
  public var identifier: String
  public var actions: [PushActionDescriptor]

  public init(identifier: String, actions: [PushActionDescriptor]) {
    self.identifier = identifier
    self.actions = actions
  }

  /// The contract's category and the older names for it, each with both actions, titled by `title`.
  public static func all(title: (PushContract.Action) -> String) -> [PushCategoryDescriptor] {
    let actions = PushContract.Action.allCases.map { action in
      PushActionDescriptor(
        identifier: action.rawValue,
        title: title(action),
        destructive: action.destructive,
        foreground: action.foreground,
        requiresAuthentication: true
      )
    }

    return ([PushContract.requestCategory] + PushContract.legacyRequestCategories).map {
      PushCategoryDescriptor(identifier: $0, actions: actions)
    }
  }
}
