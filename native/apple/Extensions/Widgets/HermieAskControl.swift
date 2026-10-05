import AppIntents
import SwiftUI
import WidgetKit

/**
 "Ask Hermie": a button for Control Center, the Lock Screen (iPhone) and the Mac's menu bar that
 opens one bot's chat with the caret in the composer.

 It runs `HermieAskBotIntent` — the same action the Action button, Shortcuts and Siri offer, so a
 person who sets "Write to a bot" on the Action button gets what the control does. The control only
 chooses the bot: the configuration (`HermieAskControlConfiguration`) is asked for when the control is
 added, from the roster the app last wrote for the widgets, and can be changed from the control's
 context menu. A control nobody has configured opens the app.

 Nothing here reads a chat or a word of one: the control shows a name and a symbol, and the intent opens
 the app through the link the router follows. The device's own unlock is asked for first
 (`.requiresAuthentication` on the intent), and the app's lock still stands in front of the chat.
 */
struct HermieAskControlConfiguration: ControlConfigurationIntent {
  static let title: LocalizedStringResource = "Ask Hermie"
  static let description = IntentDescription("Which bot the control opens.")

  @Parameter(title: "Bot")
  var bot: HermieFocusBotEntity?
}

struct HermieAskControl: ControlWidget {
  static let kind = "HermieAskControl"

  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: Self.kind, intent: HermieAskControlConfiguration.self) { configuration in
      ControlWidgetButton(action: HermieAskBotIntent(bot: configuration.bot)) {
        if let bot = configuration.bot {
          Label("Ask \(bot.name)", systemImage: "bubble.left.and.text.bubble.right")
        } else {
          Label("Ask Hermie", systemImage: "bubble.left.and.text.bubble.right")
        }
      }
    }
    .displayName("Ask Hermie")
    .description("Write to one of your bots straight from here.")
    .promptsForUserConfiguration()
  }
}
