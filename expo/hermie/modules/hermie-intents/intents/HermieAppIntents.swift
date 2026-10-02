import AppIntents
import UIKit

/**
 Hermie in Shortcuts, in Siri, and on a Home Screen button.

 Four actions, and the interesting decision is which of them need the app.

  - **Bots needing input** reads the snapshot and returns. It never launches
    anything, which is what makes it usable from a widget, a watch face or an
    automation that runs while the phone is locked.
  - **Open chat with** opens a link. There is nothing to wait for.
  - **Send to** opens the app, hands over a prompt, and returns as soon as the
    gateway has it.
  - **Ask** does the same and then waits for the reply, because its whole
    purpose is to return text the next action of a Shortcut can use.

 ## Why anything has to open the app at all

 The gateway session lives in JavaScript, inside the app, behind a socket that
 only exists while the app is running and signed in. Nothing in this file can
 reach it. `openAppWhenRun` therefore brings the app forward and `perform()`
 continues in the app's own process, where it can write a request into the
 shared container and wait for the answer to appear beside it.

 That is a first version and it says so. A Shortcut that ran without taking over
 the screen would need the session to live somewhere a background process can
 reach — an extension holding its own connection, or a gateway that accepts a
 one-shot authenticated request — and both are a different piece of work.

 ## The budget

 `HermieIntentQueue.budget` is forty-five seconds, shared with
 `INTENT_BUDGET_MS` on the JavaScript side. Plenty of real prompts take longer
 than that, and one that does returns a message saying so rather than a reply.
 The message names the way out, which is "Send to", and that is deliberate: a
 longer budget would trade a clear sentence for a spinner.

 ## Everything here is iOS 16

 `AppIntent` and `AppShortcutsProvider` both start there, and the app's floor is
 15.1 (ADR-0001). An iOS 15 device installs the app and simply has no actions to
 add, which is a better answer than an app that refuses to install.
 */

/** One bot, as Shortcuts and Siri let somebody pick it. */
@available(iOS 16.0, *)
struct HermieBotAppEntity: AppEntity {
  /** The HANDLE. It is what a request carries and what the gateway addresses. */
  let id: String
  /** The primary line, per the app's own "Bot names" setting. */
  let label: String
  let subtitle: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Bot")
  }

  var displayRepresentation: DisplayRepresentation {
    subtitle.isEmpty
      ? DisplayRepresentation(title: "\(label)")
      : DisplayRepresentation(title: "\(label)", subtitle: "\(subtitle)")
  }

  static var defaultQuery = HermieBotEntityQuery()

  init(_ bot: HermieRosterBot) {
    id = bot.name
    label = bot.displayName
    subtitle = bot.lastLine
  }
}

/**
 Where the picker's list comes from, and how a spoken name is resolved.

 `EntityStringQuery` rather than the plain one, because Siri hands over words
 rather than an id: without `entities(matching:)`, "Ask Researcher in Hermie …"
 has nothing to match the spoken name against and the phrase does not work.
 */
@available(iOS 16.0, *)
struct HermieBotEntityQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [HermieBotAppEntity] {
    let bots = HermieIntentRoster.load()

    // A Shortcut configured for a bot that has since left the roster resolves
    // to nothing, and Shortcuts then says the action needs attention — which is
    // honest, because the chat it named really is not there any more.
    return identifiers.compactMap { identifier in
      bots.first { $0.name == identifier }.map(HermieBotAppEntity.init)
    }
  }

  func entities(matching string: String) async throws -> [HermieBotAppEntity] {
    let bots = HermieIntentRoster.load()

    if let found = HermieIntentRoster.find(string, in: bots) {
      return [HermieBotAppEntity(found)]
    }

    // No exact or case-insensitive match: offer what contains the words, so
    // Shortcuts can show a list rather than nothing at all. This is a PICKER,
    // not a resolution — `find` is what decides where a message actually goes.
    let lowered = string.lowercased()

    return bots
      .filter { $0.name.lowercased().contains(lowered) || $0.displayName.lowercased().contains(lowered) }
      .map(HermieBotAppEntity.init)
  }

  /** The list, in the snapshot's order: most recently active first. */
  func suggestedEntities() async throws -> [HermieBotAppEntity] {
    HermieIntentRoster.load().map(HermieBotAppEntity.init)
  }
}

/** What an action says when it cannot do the thing. One sentence, shown as-is. */
@available(iOS 16.0, *)
struct HermieIntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String

  var localizedStringResource: LocalizedStringResource { "\(message)" }

  /**
   Turn a queue failure into something worth reading.

   The three cases are kept apart because the person's next move differs for
   each: a missing container is a build problem, a timeout is a reason to use
   "Send to", and a refusal is the app's own sentence and is passed through
   untouched.
   */
  init(_ failure: Error) {
    switch failure {
    case HermieIntentQueue.Failure.unavailable:
      message = "Hermie could not reach its shared storage. Open Hermie once, then try again."
    case HermieIntentQueue.Failure.timedOut:
      message = "Hermie did not answer in time. The message may still have been sent — open Hermie to check."
    case let HermieIntentQueue.Failure.refused(reason):
      message = reason
    default:
      message = "Hermie could not do that."
    }
  }

  init(message: String) {
    self.message = message
  }
}

/**
 Ask a bot something and get the answer back.

 The one action that waits, because the reply is the point: it is what flows
 into the next step of a Shortcut, into a spoken answer from Siri, or into a
 note somebody is appending to.
 */
@available(iOS 16.0, *)
struct HermieAskIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask a bot"
  static var description = IntentDescription(
    "Send a message to one of your bots and wait for its reply.",
    categoryName: "Chats"
  )

  /**
   The app comes forward, and `perform()` continues inside it.

   Not a choice so much as the only shape available: the gateway session lives
   in the app. See the note at the top of this file.
   */
  static var openAppWhenRun = true

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  @Parameter(title: "Message", requestValueDialog: "What should I ask?")
  var prompt: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask \(\.$bot) \(\.$prompt)")
  }

  @MainActor
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let reply = try await HermieIntentRunner.run(kind: .ask, bot: bot.id, text: prompt)

    // The dialog is what Siri speaks and what Shortcuts shows in its result
    // card; the value is what the next action receives. They are the same text
    // — there is nothing to summarise, and a summary would be this app putting
    // words in the bot's mouth.
    return .result(value: reply, dialog: "\(reply)")
  }
}

/**
 Send a bot something and do not wait.

 The honest action for anything that takes real work. It returns as soon as the
 gateway has the prompt, so a Shortcut that fires off a long job finishes in a
 second rather than sitting out the budget and reporting a timeout for a turn
 that is going perfectly well.
 */
@available(iOS 16.0, *)
struct HermieSendIntent: AppIntent {
  static var title: LocalizedStringResource = "Send to a bot"
  static var description = IntentDescription(
    "Send a message to one of your bots without waiting for a reply.",
    categoryName: "Chats"
  )

  static var openAppWhenRun = true

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  @Parameter(title: "Message", requestValueDialog: "What should I send?")
  var prompt: String

  static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$prompt) to \(\.$bot)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    _ = try await HermieIntentRunner.run(kind: .send, bot: bot.id, text: prompt)

    return .result()
  }
}

/**
 Open a chat and stop there.

 No queue: there is nothing for the app to do that a link does not already say.
 It is the cheapest of the four and the one most likely to end up on a Home
 Screen button.
 */
@available(iOS 16.0, *)
struct HermieOpenChatIntent: AppIntent {
  static var title: LocalizedStringResource = "Open a chat"
  static var description = IntentDescription("Open one of your bots' chats in Hermie.", categoryName: "Chats")

  static var openAppWhenRun = true

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Open the chat with \(\.$bot)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    let escaped = bot.id.addingPercentEncoding(
      withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
    ) ?? bot.id

    guard let url = URL(string: "hermie://chat/\(escaped)") else {
      throw HermieIntentError(message: "That chat could not be opened.")
    }

    await UIApplication.shared.open(url)

    return .result()
  }
}

/**
 Which bots are waiting on a person.

 The only action that does not open anything. It reads the same snapshot the
 lock-screen widget counts, so a Shortcut asking this and the accessory widget
 showing a number can never disagree — and because it launches nothing, it can
 run from an automation while the phone is locked.
 */
@available(iOS 16.0, *)
struct HermieNeedsInputIntent: AppIntent {
  static var title: LocalizedStringResource = "Bots needing input"
  static var description = IntentDescription(
    "List the bots that are waiting for an answer, without opening Hermie.",
    categoryName: "Chats"
  )

  static var parameterSummary: some ParameterSummary {
    Summary("Get the bots needing input")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<[HermieBotAppEntity]> & ProvidesDialog {
    let waiting = HermieIntentRoster.load().filter(\.needsInput).map(HermieBotAppEntity.init)

    return .result(value: waiting, dialog: "\(HermieNeedsInputIntent.sentence(for: waiting))")
  }

  /**
   What Siri says out loud.

   Names rather than a bare count, because "two bots are waiting" leaves the
   listener with a second question. Past three it is a count again — a list
   nobody can hold in their head is worse than a number.
   */
  static func sentence(for waiting: [HermieBotAppEntity]) -> String {
    switch waiting.count {
    case 0:
      return "Nothing is waiting on you."
    case 1:
      return "\(waiting[0].label) is waiting on you."
    case 2, 3:
      return "\(waiting.map(\.label).joined(separator: ", ")) are waiting on you."
    default:
      return "\(waiting.count) bots are waiting on you."
    }
  }
}

/**
 The three lines every queued action shares.

 Write the request, tell the app to look now, wait for the answer. Held apart
 from the intents themselves so that the two that queue cannot drift, and so
 that the ONE place that decides what a failure reads like is one place.
 */
@available(iOS 16.0, *)
enum HermieIntentRunner {
  @MainActor
  static func run(kind: HermieIntentQueue.Kind, bot: String, text: String) async throws -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      throw HermieIntentError(message: "There was nothing to send.")
    }

    let identifier: String

    do {
      identifier = try HermieIntentQueue.enqueue(kind: kind, bot: bot, text: trimmed)
    } catch {
      throw HermieIntentError(error)
    }

    // `openAppWhenRun` has already brought the app forward; this is what makes
    // it LOOK, rather than waiting for the next foreground it would otherwise
    // notice. Best effort: the app also drains the queue whenever the gateway
    // becomes ready, so a link that went nowhere costs latency and not the
    // request.
    if let url = HermieIntentQueue.deepLink(for: identifier) {
      await UIApplication.shared.open(url)
    }

    do {
      return try await HermieIntentQueue.awaitResult(id: identifier).reply
    } catch {
      throw HermieIntentError(error)
    }
  }
}
