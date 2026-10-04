import HermieCore
import SwiftUI

/**
 Settings → Chats: which name of a bot leads, and whether its handle is shown at all
 (`ChatsMessages.tsx` in the Expo app).

 A bot has two names, its handle (what `@`-addressing and the gateway use) and a name somebody typed.
 **Bot names** says which one leads the chat list and the chat's title; it follows the account to
 every device (`AppSettings.synced`). **Hide profile name** is this device's: a bot that has a name of
 its own is shown by it alone, so the order stops mattering and is disabled while the switch is on
 (an order that still surfaced the handle one way round would be the setting lying about what it does).
 */
struct BotNameSettingsSections: View {
  let settings: AppSettings

  var body: some View {
    // Its own group for its own footer: which of the two names the rest of the app addresses a bot by
    // is the whole reason somebody would move this, and a group has one footer.
    Section {
      Picker(
        Strings.App.Settings.botNames,
        selection: Binding(
          get: { settings.synced.botNameOrder },
          set: { settings.setBotNameOrder($0) }
        )
      ) {
        Text(Strings.App.Settings.BotNameOptions.display).tag(BotNameOrder.display)
        Text(Strings.App.Settings.BotNameOptions.profile).tag(BotNameOrder.profile)
      }
      .disabled(settings.hideHandleWhenNamed)
      .accessibilityIdentifier("hermie.settings.chats.botNames")
    } footer: {
      SettingsNote(Strings.App.Settings.botNamesHint)
    }

    // Below the order it overrides, as the footer above says.
    Section {
      Toggle(
        Strings.App.Settings.hideHandle,
        isOn: Binding(
          get: { settings.hideHandleWhenNamed },
          set: { settings.setHideHandleWhenNamed($0) }
        )
      )
      .accessibilityIdentifier("hermie.settings.chats.hideHandle")
    } footer: {
      SettingsNote(Strings.App.Settings.hideHandleHint)
    }
  }
}
