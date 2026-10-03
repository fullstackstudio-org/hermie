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

  /// Types a notification can carry that are not switches (`unfilteredTypes`): no device asks for
  /// one and none can refuse it, so a registration row has no key for them and no settings screen
  /// lists them. A sender delivers them whatever the switches, the per-chat overrides, a mute and
  /// the open-chat suppression say.
  public static let unfilteredTypes = ["security"]

  /// The type spelled by senders older than the contract, still valid on the wire (`legacyTypes`).
  public static let legacyTypes = ["dm"]

  /// The payload types whose notifications can carry the actions. Whether one does depends on its
  /// `method` too: only an approval (`PushPayload.wantsActions`).
  public static let typesWithActions = ["request"]

  /// The method whose notification is posted under `requestCategory`, and nothing else is.
  public static let actionsMethod = PushRequestMethod.approval

  /// Android channel ids (`android.channels`): one per type, the id equal to the type name. iOS has
  /// no channels; the list is here so a test holds both generations to the same names.
  public static var channelIds: [String] { types }

  /// Channels of the unfiltered types (`android.alsoChannels`).
  public static var alsoChannelIds: [String] { unfilteredTypes }

  /// Every `type` a payload may carry and the reader recognises, switch or not.
  public static func isKnownType(_ type: String) -> Bool {
    types.contains(type) || unfilteredTypes.contains(type) || legacyTypes.contains(type)
  }

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

// MARK: - Request methods

/**
 What a `type: request` notification is, per `data.method` (`requests.methods`): the gateway's own
 name for the server request. Only an approval is ever posted with the Allow and Deny actions; every
 other kind has no answer a button could send (a clarify), has to be typed (the secure inputs) or is
 the person's own act (a confirmation, possibly on a locked screen).
 */
public enum PushRequestMethod: String, Sendable, CaseIterable {
  case approval
  case clarify
  case secret
  case sudo
  case vaultUnlockPrompt = "vault.unlock_prompt"
  case vaultCode = "vault.code"
  case vaultSaveLogin = "vault.save_login"
  case confirm

  /// Whether the sender always names the request id or only when it knows it.
  public enum RequestIdRule: String, Sendable, Equatable {
    case required
    case whenKnown
  }

  /// A method this build names, or a `vault.*` method a newer plugin may add: a request kind either
  /// way, and never one with actions.
  public static func isRequestKind(_ method: String) -> Bool {
    PushRequestMethod(rawValue: method) != nil || method.hasPrefix("vault.")
  }

  /// Whether the notification is posted under `hermie.request`, with Allow and Deny.
  public var offersActions: Bool { self == PushContract.actionsMethod }

  public var requestId: RequestIdRule { self == .clarify ? .whenKnown : .required }

  /// Whether the data bag and the visible text may ever carry text about the request; `false` means
  /// never, whatever the registration's `preview` says.
  public var carriesPreview: Bool { self == .approval || self == .clarify }

  /// A value typed into the app: the secure inputs (`secret`, `sudo`, `vault.*`).
  public var isSecureInput: Bool {
    switch self {
    case .secret, .sudo, .vaultUnlockPrompt, .vaultCode, .vaultSaveLogin: true
    case .approval, .clarify, .confirm: false
    }
  }

  /// The levels a confirmation can be proven at; empty for every other method.
  public var levels: [PushConfirmLevel] { self == .confirm ? PushConfirmLevel.allCases : [] }
}

/// How a `confirm` is proven (`data.level`). `passkey` can only be done in the app, with the
/// device's own authentication; `plain` is a confirmation in the app that needs no proof. Neither is
/// ever offered as a notification action.
public enum PushConfirmLevel: String, Sendable, CaseIterable {
  case plain
  case passkey
}

/// Why a request stopped being open (`data.reason` of a clearing push).
public enum PushClearReason: String, Sendable, CaseIterable {
  case answered
  case cancelled
  case timeout
}

/// The gateway event a notification reports when `type` alone does not say (`data.event`).
public enum PushEvent: String, Sendable, CaseIterable {
  /// Something the person sent to the background finished. The `type` is `turn_done`.
  case backgroundComplete = "background.complete"

  /// The switch that decides it: the same as for the type it is sent under.
  public var type: String {
    switch self {
    case .backgroundComplete: "turn_done"
    }
  }
}

/// What happened to the person's passkey (`data.change` of a `type: security` notification). Which
/// one, how it was authorised and who did it never travel.
public enum PushSecurityChange: String, Sendable, CaseIterable {
  case added
  case revoked
}
