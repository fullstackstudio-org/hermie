import AppIntents
import Foundation
import HermieShared

/**
 Hermie's Focus filter: per Focus, which bots may notify, and whether only urgent requests may.

 The person adds it in Settings → Focus → (a Focus) → Add Filter → Hermie. When that Focus turns on
 the system performs this intent in the app's process (the app is launched in the background if it
 is not running), which stores the choice in the App Group (`FocusFilterStore`). The app reads it
 each time it decides about a local notification for a request (`RequestAlerts`), so nothing here
 needs the app to be in front.

 ## What turning the Focus off does

 The parameters default to "all bots, not only urgent", which is the unfiltered state: performing the
 intent with its defaults stores nothing (`FocusFilterStore.save` removes the file for it). As a second
 line, `HermieFocusFilterSync.reconcile()` runs whenever the app comes to the front and asks the system
 for the filter that is in effect (`current`); "not found" means no Focus with this filter is on, so a
 stored filter that outlived its Focus is removed. A filter stuck on would silence approvals, which is
 the one way this feature can do harm, so it is checked from both ends.

 ## The bots

 The picker lists the roster the app last wrote for the widgets (the live gateway's), by gateway key
 and handle. A bot chosen once stays in the filter whatever the roster does later. The picker's
 entity (`HermieFocusBotEntity`, in `AskBot/`) is shared with "Write to a bot", which names a bot the
 same way.
 */

/** Which bots a Focus lets notify. */
enum HermieFocusScope: String, AppEnum {
  case all
  case chosen
  case none

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Bots that may notify")
  }

  static var caseDisplayRepresentations: [HermieFocusScope: DisplayRepresentation] {
    [
      .all: DisplayRepresentation(title: "All bots"),
      .chosen: DisplayRepresentation(title: "Chosen bots"),
      .none: DisplayRepresentation(title: "No bots")
    ]
  }

  var scope: FocusFilter.Scope {
    switch self {
    case .all: .all
    case .chosen: .chosen
    case .none: .none
    }
  }

  init(_ scope: FocusFilter.Scope) {
    switch scope {
    case .all: self = .all
    case .chosen: self = .chosen
    case .none: self = .none
    }
  }
}

struct HermieFocusFilterIntent: SetFocusFilterIntent {
  static let title: LocalizedStringResource = "Choose which bots notify"
  static let description = IntentDescription("Choose which bots may notify you while this Focus is on.")

  // Every parameter of a Focus filter is optional (the system requires it): a nil is the default,
  // which is "all bots, not only urgent", the unfiltered state.
  @Parameter(title: "Bots that may notify", default: .all)
  var scope: HermieFocusScope?

  @Parameter(title: "Chosen bots")
  var bots: [HermieFocusBotEntity]?

  @Parameter(title: "Only urgent requests", default: false)
  var urgentOnly: Bool?

  static var parameterSummary: some ParameterSummary {
    When(\.$scope, .equalTo, HermieFocusScope.chosen) {
      Summary("Notify: \(\.$scope)") {
        \.$bots
        \.$urgentOnly
      }
    } otherwise: {
      Summary("Notify: \(\.$scope)") {
        \.$urgentOnly
      }
    }
  }

  var displayRepresentation: DisplayRepresentation {
    let subtitle: LocalizedStringResource? = urgentOnly == true ? "Only urgent requests" : nil

    switch scope ?? .all {
    case .all: return DisplayRepresentation(title: "All bots", subtitle: subtitle)
    case .chosen: return DisplayRepresentation(title: "Chosen bots", subtitle: subtitle)
    case .none: return DisplayRepresentation(title: "No bots", subtitle: subtitle)
    }
  }

  /** Store what was chosen. The same call the tests make (`FocusFilterStore.apply`). */
  func perform() async throws -> some AppIntents.IntentResult {
    FocusFilterStore.system()?.apply(
      scope: (scope ?? .all).scope, botIdentifiers: (bots ?? []).map(\.id), urgentOnly: urgentOnly ?? false)

    return .result()
  }
}

/** Keeps the stored filter in step with the Focus that is on, for the moment the system did not tell. */
enum HermieFocusFilterSync {
  /**
   Ask the system for the filter in effect and make the stored one the same. "Not found" is no Focus
   with this filter on: the stored filter goes. Any other failure leaves it alone, since a filter
   that cannot be confirmed is better kept than dropped for a Focus that may well be on.
   */
  @MainActor
  static func reconcile() async {
    guard let store = FocusFilterStore.system() else {
      return
    }

    do {
      let current = try await HermieFocusFilterIntent.current

      store.apply(
        scope: (current.scope ?? .all).scope, botIdentifiers: (current.bots ?? []).map(\.id),
        urgentOnly: current.urgentOnly ?? false)
    } catch SetFocusFilterIntentError.notFound {
      store.clear()
    } catch {
      return
    }
  }
}
