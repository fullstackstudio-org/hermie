import Foundation
import HermieProtocol

extension GatewaySession {
  /// The model behind one bot's settings screen, over this session's link. A screen builds one per
  /// time it is opened: it holds drafts, and drafts are not kept.
  public func botSettings(for name: String) -> BotSettingsModel {
    BotSettingsModel(
      gateway: .link(link),
      profile: name,
      runtimeSessionID: { [weak self] in
        await self?.store.sessionIDs()[name]?.runtime
      },
      onChanged: { [weak self] in
        guard let self else { return }

        Task { _ = try? await self.roster.refresh() }
      }
    )
  }

  /// The two names a bot is drawn with, in the order the reader chose: the name they gave it, else the
  /// gateway's display name, and the handle (`BotNames`, `botNamePolicy`).
  public func botNames(_ name: String) -> BotNames {
    BotNames.of(
      handle: name,
      displayName: chatList.rows[name]?.bot.displayName ?? "",
      label: arrangement.label(name),
      policy: botNamePolicy
    )
  }

  /// What this person calls the bot: the name that leads (`botNames(_:)`), which is the name they gave
  /// it, else the gateway's display name, else the handle, unless they asked for the handle first.
  public func chatName(_ name: String) -> String {
    botNames(name).primary
  }
}
