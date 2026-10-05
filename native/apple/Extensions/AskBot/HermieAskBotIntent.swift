import AppIntents
import Foundation
import HermieShared

/**
 "Write to a bot": the one action behind the Action button, the Control Center and Lock Screen
 control, Shortcuts and Siri that opens a bot's chat with the caret in the composer.

 Compiled into the app AND the widget extension, because the control (an iOS 18 / macOS 26
 `ControlWidget`) builds this intent in the extension, while the system runs it in the app
 (`supportedModes = .foreground`) where Hermie can open the chat. That is also why this file may not
 touch `UIApplication`, `HermieUI` or the keychain: it links `HermieShared` and nothing else.

 ## What it does

 Nothing here talks to a gateway or writes a word. `perform()` builds the link the router already
 follows (`DeepLink.ask`, through `AskBotRoute`, which is where the route is decided and tested) and
 hands it to the system as `OpenURLIntent`. The app then opens the chat and the composer takes focus
 (`AppRouter.composeRequest`). With no bot chosen it opens the app on its list instead.

 ## The app lock

 `.requiresAuthentication` asks for an unlocked device, so the Lock Screen control and the Action
 button prompt for Face ID or the passcode first. The app's own lock is not bypassed either: the link
 is only kept by the router, and the chat is drawn once the lock gate opens (`LockGate`).

 ## The bot

 The picker's entity is the Focus filter's (`HermieFocusBotEntity`, identified by
 `<gateway key>/<handle>`), read from the roster the app last wrote for the widgets. It carries the
 gateway key, which a link needs and a bare handle does not.
 */

/** One bot of the pickers (the Focus filter, "Write to a bot"): identified by gateway key and handle. */
struct HermieFocusBotEntity: AppEntity {
  /** `<gateway key>/<handle>` (`FocusFilter.Bot.id`). */
  let id: String
  let name: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Bot")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }

  static let defaultQuery = HermieFocusBotQuery()

  init(_ choice: FocusBotChoice) {
    id = choice.id
    name = choice.displayName
  }
}

/**
 The bots a picker can name: the roster in the App Group, nothing a gateway has to answer.

 `EntityStringQuery`, because Siri hands over words rather than an id: "Write to Researcher in Hermie"
 needs `entities(matching:)` to find the bot (`FocusBotChoices.matching`).
 */
struct HermieFocusBotQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [HermieFocusBotEntity] {
    // A bot chosen earlier that the roster no longer lists is kept, under its handle: the filter is a
    // list of identities, and dropping one here would quietly widen what a Focus lets through.
    FocusBotChoices.resolve(identifiers, in: FocusBotChoices.load(container: SharedContainer.url()))
      .map(HermieFocusBotEntity.init)
  }

  func entities(matching string: String) async throws -> [HermieFocusBotEntity] {
    FocusBotChoices.matching(string, in: FocusBotChoices.load(container: SharedContainer.url()))
      .map(HermieFocusBotEntity.init)
  }

  func suggestedEntities() async throws -> [HermieFocusBotEntity] {
    FocusBotChoices.load(container: SharedContainer.url()).map(HermieFocusBotEntity.init)
  }
}

/** What the action says when it cannot do the thing. One sentence, shown as-is. */
struct HermieAskBotError: Error, CustomLocalizedStringResourceConvertible {
  var localizedStringResource: LocalizedStringResource { "That chat could not be opened." }
}

struct HermieAskBotIntent: AppIntent {
  static let title: LocalizedStringResource = "Write to a bot"
  static let description = IntentDescription(
    "Open the chat with one of your bots, ready for you to type.",
    categoryName: "Chats"
  )

  /// The app comes forward and `perform()` continues inside it, where the link is followed.
  static let supportedModes: IntentModes = .foreground
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  /// Optional so that a control nobody has configured yet still does something: it opens the app.
  @Parameter(title: "Bot", requestValueDialog: "Which bot?")
  var bot: HermieFocusBotEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Write to \(\.$bot)")
  }

  init() {}

  init(bot: HermieFocusBotEntity?) {
    self.bot = bot
  }

  /** The link this action opens: the bot's chat to write in, or the app alone when no bot is chosen. */
  var link: URL? {
    guard let bot else {
      return Self.appURL
    }

    return AskBotRoute.link(forBotIdentifier: bot.id)?.url
  }

  /// The app's own list, for a tap that names no chat. Not a `DeepLink`: the router ignores it.
  private static let appURL = URL(string: "\(DeepLink.scheme)://chat")

  func perform() async throws -> some AppIntents.IntentResult & OpensIntent {
    guard let link else {
      throw HermieAskBotError()
    }

    return .result(opensIntent: OpenURLIntent(link))
  }
}
