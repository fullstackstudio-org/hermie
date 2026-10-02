import AppIntents
import Foundation
import HermieCore
import HermieShared

#if os(iOS)
  import UIKit
#else
  import AppKit
#endif

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

 The gateway session lives inside the app, behind a socket that only exists
 while the app is running and signed in. Nothing in this file can reach it.
 `supportedModes = .foreground` therefore brings the app forward and `perform()`
 continues in the app's own process, where it can write a request into the
 shared container and wait for the answer to appear beside it
 (`IntentQueueDrainer` answers it).

 ## The app lock

 Every action asks for an unlocked device (`.requiresAuthentication`), and none of them does
 anything the app lock has not allowed: the app answers a queued request only while it is unlocked
 (`IntentQueueDrainer` with `SystemSurfaceLock`), so "Send to" and "Ask" wait while it is locked,
 and "Bots needing input" names nobody. Siri must not read a bot's name or reply past a lock the
 owner turned on.

 ## The budget

 `PendingIntent.budget` is forty-five seconds, shared with the app. Plenty of
 real prompts take longer than that, and one that does returns a message saying
 so rather than a reply. The message names the way out, which is "Send to", and
 that is deliberate: a longer budget would trade a clear sentence for a spinner.
 */

/** One bot, as Shortcuts and Siri let somebody pick it. */
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

  static let defaultQuery = HermieBotEntityQuery()

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
  init(_ failure: HermieIntentQueue.Failure) {
    switch failure {
    case .unavailable:
      message = String(localized: "Hermie could not reach its shared storage. Open Hermie once, then try again.")
    case .timedOut:
      message = String(
        localized: "Hermie did not answer in time. The message may still have been sent — open Hermie to check.")
    case .tooLong:
      message = String(localized: "That message is too long for a Shortcut. Send it from Hermie instead.")
    case .cancelled:
      message = String(localized: "The Shortcut was stopped before Hermie answered.")
    case let .refused(reason):
      message = reason
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
struct HermieAskIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask a bot"
  static let description = IntentDescription(
    "Send a message to one of your bots and wait for its reply.",
    categoryName: "Chats"
  )

  /**
   The app comes forward, and `perform()` continues inside it.

   Not a choice so much as the only shape available: the gateway session lives
   in the app. See the note at the top of this file.
   */
  static let supportedModes: IntentModes = .foreground
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  @Parameter(title: "Message", requestValueDialog: "What should I ask?")
  var prompt: String

  static var parameterSummary: some ParameterSummary {
    Summary("Ask \(\.$bot) \(\.$prompt)")
  }

  @MainActor
  func perform() async throws -> some AppIntents.IntentResult & ReturnsValue<String> & ProvidesDialog {
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
struct HermieSendIntent: AppIntent {
  static let title: LocalizedStringResource = "Send to a bot"
  static let description = IntentDescription(
    "Send a message to one of your bots without waiting for a reply.",
    categoryName: "Chats"
  )

  static let supportedModes: IntentModes = .foreground
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  @Parameter(title: "Message", requestValueDialog: "What should I send?")
  var prompt: String

  static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$prompt) to \(\.$bot)")
  }

  @MainActor
  func perform() async throws -> some AppIntents.IntentResult {
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
struct HermieOpenChatIntent: AppIntent {
  static let title: LocalizedStringResource = "Open a chat"
  static let description = IntentDescription("Open one of your bots' chats in Hermie.", categoryName: "Chats")

  static let supportedModes: IntentModes = .foreground
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Bot")
  var bot: HermieBotAppEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Open the chat with \(\.$bot)")
  }

  @MainActor
  func perform() async throws -> some AppIntents.IntentResult {
    guard let url = DeepLink.chat(bot: bot.id, gatewayKey: HermieIntentRoster.snapshot().gatewayKey ?? "").url else {
      throw HermieIntentError(message: String(localized: "That chat could not be opened."))
    }

    await HermieIntentRunner.open(url)

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
struct HermieNeedsInputIntent: AppIntent {
  static let title: LocalizedStringResource = "Bots needing input"
  static let description = IntentDescription(
    "List the bots that are waiting for an answer, without opening Hermie.",
    categoryName: "Chats"
  )

  /// It answers without opening the app, so it is the one Siri could run on a locked device.
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  static var parameterSummary: some ParameterSummary {
    Summary("Get the bots needing input")
  }

  @MainActor
  func perform() async throws -> some AppIntents.IntentResult & ReturnsValue<[HermieBotAppEntity]> & ProvidesDialog {
    // Behind the app lock, nobody is named: not to Siri, not to the next step of a Shortcut.
    guard !SystemSurfaceLock.isLocked else {
      return .result(value: [], dialog: "\(String(localized: "Unlock Hermie to see which bots are waiting."))")
    }

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
      return String(localized: "Nothing is waiting on you.")
    case 1:
      return String(localized: "\(waiting[0].label) is waiting on you.")
    case 2, 3:
      return String(localized: "\(waiting.map(\.label).formatted(.list(type: .and))) are waiting on you.")
    default:
      return String(localized: "\(waiting.count) bots are waiting on you.")
    }
  }
}

/**
 The three lines every queued action shares.

 Write the request, tell the app to look now, wait for the answer. Held apart
 from the intents themselves so that the two that queue cannot drift, and so
 that the ONE place that decides what a failure reads like is one place.
 */
enum HermieIntentRunner {
  @MainActor
  static func run(kind: HermieIntentQueue.Kind, bot: String, text: String) async throws -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !trimmed.isEmpty else {
      throw HermieIntentError(message: String(localized: "There was nothing to send."))
    }

    let identifier: String

    do {
      identifier = try HermieIntentQueue.enqueue(
        kind: kind, bot: bot, gatewayKey: HermieIntentRoster.snapshot().gatewayKey, text: trimmed)
    } catch {
      throw HermieIntentError(error)
    }

    // The app is already forward; this is what makes it LOOK, rather than
    // waiting for the next time it drains the queue on its own. Best effort: the
    // app also drains whenever the gateway becomes ready, so a link that went
    // nowhere costs latency and not the request.
    if let url = HermieIntentQueue.deepLink(for: identifier) {
      await open(url)
    }

    do {
      return try await HermieIntentQueue.awaitResult(id: identifier).reply
    } catch {
      throw HermieIntentError(error)
    }
  }

  /// Hand a `hermie://` link to the system, which routes it to this app's own link handling.
  @MainActor
  static func open(_ url: URL) async {
    #if os(iOS)
      await UIApplication.shared.open(url)
    #else
      NSWorkspace.shared.open(url)
    #endif
  }
}
