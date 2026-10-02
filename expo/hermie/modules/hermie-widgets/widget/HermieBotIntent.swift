import AppIntents

/**
 Which chat the small widget shows, as the reader picks it in the widget's own configuration.

 The list the picker offers is the snapshot's, which means it is the roster the app last saw — a
 widget cannot ask a gateway anything, and a picker that offered a name the app no longer knows
 would configure a widget that can never fill in. The consequence worth knowing: a bot added to
 the gateway does not appear here until the app has run once since.

 The parameter is OPTIONAL and nil means "the most recent chat", which is the default a fresh
 widget gets. That is a deliberate alternative to `EntityQuery.defaultResult()`: a default
 resolved once at configuration time would pin the widget to whichever chat happened to be on top
 the afternoon it was added, and the thing a reader wants from an unconfigured widget is the chat
 that is live NOW. Picking a chat explicitly pins it; leaving it alone keeps it following.
 */
struct HermieBotEntity: AppEntity {
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Chat")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }

  static var defaultQuery = HermieBotQuery()
}

struct HermieBotQuery: EntityQuery {
  /**
   Resolve the ids a configured widget stored.

   A widget configured for a bot that has since left the roster resolves to nothing, and the
   provider then falls back to the most recent — which is a better answer than an empty square,
   and honest, because the chat it named genuinely is not there any more.
   */
  func entities(for identifiers: [String]) async throws -> [HermieBotEntity] {
    let bots = HermieWidgetStore.load().bots

    return identifiers.compactMap { identifier in
      bots.first { $0.name == identifier }.map { HermieBotEntity(id: $0.name, name: $0.displayName) }
    }
  }

  /** The picker's list, in the snapshot's order: most recently active first. */
  func suggestedEntities() async throws -> [HermieBotEntity] {
    HermieWidgetStore.load().bots.map { HermieBotEntity(id: $0.name, name: $0.displayName) }
  }
}

struct HermieSelectBotIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Chat"
  static var description = IntentDescription("Which conversation this widget shows.")

  @Parameter(title: "Chat")
  var bot: HermieBotEntity?
}

/**
 Which FOLDER the medium widget shows, as the reader picks it.

 The same shape as the chat picker above and the same nil-means-everything
 default, but the thing it answers is different enough to be worth saying: the
 chat widget is pinned to one conversation, and this is pinned to a part of the
 owner's list. A folder is the only way this app lets somebody say "these bots,
 and not the others", and a home screen is where that sentence is worth the
 most — four square centimetres about Finance, whatever happened in the other
 eleven chats this afternoon.

 Nil is "the whole list, most recent first", which is what the widget did before
 it could be configured and what a freshly added one still does.
 */
struct HermieFolderEntity: AppEntity {
  let id: String
  let name: String
  /** How many bots are inside, for the second line of the picker's row. */
  let size: Int

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Folder")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: size == 1 ? "1 chat" : "\(size) chats")
  }

  static var defaultQuery = HermieFolderQuery()
}

struct HermieFolderQuery: EntityQuery {
  /**
   Resolve the ids a configured widget stored.

   A widget configured for a folder the owner has since deleted — or emptied,
   which `snapshot.ts` treats the same way — resolves to nothing, and the
   provider falls back to the whole list. That is a better answer than an empty
   square and an honest one: the folder it named really is not there any more.
   */
  func entities(for identifiers: [String]) async throws -> [HermieFolderEntity] {
    let folders = HermieWidgetStore.load().folders ?? []

    return identifiers.compactMap { identifier in
      folders.first { $0.id == identifier }.map { HermieFolderEntity(id: $0.id, name: $0.name, size: $0.size) }
    }
  }

  /** The picker's list, in the order the chat list draws the folders. */
  func suggestedEntities() async throws -> [HermieFolderEntity] {
    (HermieWidgetStore.load().folders ?? []).map { HermieFolderEntity(id: $0.id, name: $0.name, size: $0.size) }
  }
}

struct HermieSelectFolderIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Folder"
  static var description = IntentDescription("Which part of your chat list this widget shows.")

  @Parameter(title: "Folder")
  var folder: HermieFolderEntity?
}
