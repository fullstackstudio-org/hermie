import Foundation

/**
 "Write to a bot": the chat of one bot, opened with the caret in the composer.

 The Action button, the Control Center and Lock Screen control, Shortcuts and Siri all run one App
 Intent (`HermieAskBotIntent`) whose parameter is the Focus picker's bot entity, identified by
 `<gateway key>/<handle>`. The intent's whole job is this function: turn that identifier into the
 link the router already follows (`DeepLink.ask`), so the route is decided in one tested place and
 the intent only hands it to the system.
 */
public enum AskBotRoute {
  /// The link for the bot an identifier names (`FocusFilter.Bot.id`), or nil when it names none.
  public static func link(forBotIdentifier identifier: String) -> DeepLink? {
    FocusFilter.Bot(id: identifier).map { .ask(bot: $0.handle, gatewayKey: $0.gatewayKey) }
  }
}

extension FocusBotChoices {
  /**
   The bots whose name or handle holds `words`, in the roster's order. What Siri's "Write to ⟨bot⟩ in
   Hermie" resolves a spoken name with: it hands over words, not an identifier. An exact name or
   handle (case aside) wins alone, so "ops" does not also offer "ops-staging"; words that name
   nothing offer everything that contains them, so a picker can show a list rather than nothing.
   */
  public static func matching(_ words: String, in choices: [FocusBotChoice]) -> [FocusBotChoice] {
    let needle = words.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

    guard !needle.isEmpty else {
      return choices
    }

    let exact = choices.filter { $0.bot.handle.lowercased() == needle || $0.displayName.lowercased() == needle }

    if !exact.isEmpty {
      return exact
    }

    return choices.filter {
      $0.bot.handle.lowercased().contains(needle) || $0.displayName.lowercased().contains(needle)
    }
  }
}
