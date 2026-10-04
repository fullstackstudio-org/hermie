import Foundation

/// One canonical chat: a bot on a gateway. The value an extra chat window is opened for.
public struct ChatRef: Codable, Hashable, Sendable {
  /// The registry id (`g…`), not the link key.
  public var gatewayId: String
  /// The bot's profile name, as the roster spells it.
  public var bot: String

  public init(gatewayId: String, bot: String) {
    self.gatewayId = gatewayId
    self.bot = bot
  }
}

/// "Open this chat at the words I searched for": the one thing a message search hit hands the chat
/// screen besides the route. Each request has its own id, so the same words asked twice in one chat
/// are looked for twice.
public struct ChatFindRequest: Hashable, Sendable {
  public var id: Int
  public var chat: ChatRef
  /// The words, as typed (trimmed).
  public var query: String

  public init(id: Int, chat: ChatRef, query: String) {
    self.id = id
    self.chat = chat
    self.query = query
  }
}

/// What the sidebar lists. The Expo app's tabs, minus Settings, which is a sheet or its own window.
public enum SidebarSection: String, Codable, Hashable, Sendable, CaseIterable {
  case chats
  case activity
  case routines
}

/// A page pushed on top of the chat in the detail column. Filled in by the tasks that own them.
public enum DetailRoute: Codable, Hashable, Sendable {
  case botProfile(ChatRef)
  case sessions(ChatRef)
}

/// Why setup is being opened.
public enum OnboardingMode: String, Codable, Hashable, Sendable {
  /// Nothing configured yet.
  case firstGateway
  /// From Settings → Gateways → Add gateway; the live gateway stays connected.
  case additionalGateway
}

/// A sheet over a scene. Settings is a sheet on iPhone and iPad only; the Mac has its own window.
public enum AppSheet: Hashable, Sendable, Identifiable {
  case settings
  case onboarding(OnboardingMode)
  case signIn(gatewayId: String)
  case gatewayPicker

  public var id: Self { self }
}

/// Something the router could not do, said in the scene that asked.
public enum RouterNotice: Hashable, Sendable {
  /// A link named a gateway key this device has not configured. Nothing was opened.
  case gatewayNotConfigured
  /// A chat link arrived with no gateway configured at all.
  case noGatewayYet
}

/// Work a router transition asks its owner to carry out. The router itself touches no store.
public enum RouterEffect: Equatable, Sendable {
  /// Make this gateway the live one (`GatewayDirectory.activate`).
  case activateGateway(String)
}

/// What the router knows about the configured gateways: ids, link keys and the live one.
public struct GatewayIndex: Equatable, Sendable {
  public struct Entry: Equatable, Sendable {
    public var id: String
    public var key: String

    public init(id: String, key: String) {
      self.id = id
      self.key = key
    }
  }

  public var entries: [Entry]
  public var activeId: String?

  public init(entries: [Entry], activeId: String?) {
    self.entries = entries
    self.activeId = activeId
  }

  public var isEmpty: Bool { entries.isEmpty }

  public func contains(_ id: String) -> Bool {
    entries.contains { $0.id == id }
  }

  /// `gatewayForKey`: an empty key names nothing.
  public func id(forKey key: String) -> String? {
    guard !key.isEmpty else {
      return nil
    }

    return entries.first { $0.key == key }?.id
  }
}

/// A scene's navigation, as it is saved and restored (`SceneStorage`). No sheets and no notices:
/// a relaunch does not reopen a dialog.
public struct RouterSnapshot: Codable, Equatable, Sendable {
  public var section: SidebarSection
  public var selectedChat: ChatRef?
  public var detailPath: [DetailRoute]

  public init(section: SidebarSection = .chats, selectedChat: ChatRef? = nil, detailPath: [DetailRoute] = []) {
    self.section = section
    self.selectedChat = selectedChat
    self.detailPath = detailPath
  }

  public func encoded() -> Data? {
    try? JSONEncoder().encode(self)
  }

  public static func decode(_ data: Data?) -> RouterSnapshot? {
    data.flatMap { try? JSONDecoder().decode(RouterSnapshot.self, from: $0) }
  }
}
