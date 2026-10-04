import HermieCore
import SwiftUI

/**
 Push's part of a main window: route notification taps to this window's router while it is up,
 start push once the gateway list is known, follow that list, and re-read the permission whenever
 the app comes to the front (the reader may have changed it in the system's settings).

 Push starts only on a KNOWN gateway list (`GatewayDirectory.pushGateways`): one that has not been
 read, cannot be read, or was stored by a newer build is not followed at all, because a pass on it
 would revoke the registration of every gateway as if it had been removed.

 With several windows, taps go to the one most recently in front; a closed window's router is let
 go, and with no window left taps wait for the next one. The window in front also tells the live
 wiring which chat is on screen (the `seen` heartbeat), and every window tells it whether it is in
 front: the app counts as in front while any of its windows is.
 */
struct PushLifecycle: ViewModifier {
  let launch: AppLaunch
  let router: AppRouter

  @State private var handlerId = UUID()
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveWiring) private var wiring
  #if os(macOS)
    @Environment(\.controlActiveState) private var controlActiveState
    @Environment(\.openSettings) private var openSettings
  #endif

  func body(content: Content) -> some View {
    content
      .onAppear {
        launch.push.attachLinkHandler(handlerId) { route in
          follow(route)
        }
        wiring?.setForeground(scenePhase != .background, window: handlerId)
        reportPresence()
      }
      .onDisappear {
        launch.push.detachLinkHandler(handlerId)
        wiring?.windowClosed(handlerId)
      }
      .task(id: launch.gateways.pushGateways) {
        guard let gateways = launch.gateways.pushGateways else {
          return
        }

        await launch.push.setGateways(gateways)
        await launch.push.start()
      }
      .onChange(of: scenePhase) { _, phase in
        sceneChanged(phase)
      }
      .onChange(of: router.selectedChat, initial: true) { _, chat in
        wiring?.setOpenChat(gatewayId: chat?.gatewayId, bot: chat?.bot)
        reportPresence()
      }
      #if os(macOS)
        .onChange(of: controlActiveState) { _, state in
          reportPresence()

          if state == .key {
            launch.push.activateLinkHandler(handlerId)
            wiring?.setOpenChat(gatewayId: router.selectedChat?.gatewayId, bot: router.selectedChat?.bot)
          }
        }
      #endif
  }

  private func sceneChanged(_ phase: ScenePhase) {
    // Per window: the wiring keeps the app in front while any window is.
    wiring?.setForeground(phase != .background, window: handlerId)
    reportPresence(phase)

    guard phase == .active else {
      return
    }

    launch.push.activateLinkHandler(handlerId)
    Task { await launch.push.becameActive() }
  }

  /**
   What this window shows the person, for the local notifications of requests (`AppPresence`): the
   app is active in it, it is the key window, and the chat on screen. On the Mac a window that is
   visible but not the one typed into does not count as looked at.
   */
  private func reportPresence(_ phase: ScenePhase? = nil) {
    let phase = phase ?? scenePhase
    let chat = router.selectedChat

    #if os(macOS)
      let active = phase != .background && controlActiveState != .inactive
      let key = phase != .background && controlActiveState == .key
    #else
      let active = phase == .active
      let key = active
    #endif

    wiring?.setPresence(window: handlerId, active: active, key: key, gatewayId: chat?.gatewayId, bot: chat?.bot)
  }

  /**
   Where a tap lands. A request that is not an approval opens the bot's chat: the request is shown
   there as it is today (the confirmation, secure input and passkey sheets come with their own
   task), and an approval's card is in that chat's transcript. A `security` notice opens the
   gateway's account settings.
   */
  private func follow(_ route: PushRoute) {
    switch route {
    case .request(let link, let request):
      // Asked for by the tap, so it comes up again even if it had been put away.
      wiring?.bringBack(gatewayKey: request.gatewayKey, bot: request.bot, requestId: request.requestId)
      perform(router.handle(link), on: launch)
    case .chat(let link), .conversation(let link, _):
      // Seam: the router has no conversation route yet, so a named conversation opens the bot's chat.
      perform(router.handle(link), on: launch)
    case .security(let gatewayId):
      showAccount(of: gatewayId)
    case .chatList:
      router.closeChat()
      router.section = .chats
    }
  }

  private func showAccount(of gatewayId: String) {
    let (shown, effects) = router.showAccount(of: gatewayId)

    guard shown else {
      return
    }

    perform(effects, on: launch)
    ShellRequests.shared.settingsCategory = .account

    #if os(macOS)
      openSettings()
    #else
      router.present(.settings)
    #endif
  }
}

extension View {
  /// See `PushLifecycle`.
  func pushLifecycle(launch: AppLaunch, router: AppRouter) -> some View {
    modifier(PushLifecycle(launch: launch, router: router))
  }
}

/**
 What an extra window for one chat shows the person, for the local notifications of requests
 (`AppPresence`): its own entry beside the main window's, so a request for the chat in the window
 that is in front raises nothing, and one for the chat in the window behind does.
 */
struct ChatWindowPresence: ViewModifier {
  let chat: ChatRef?

  @State private var windowId = UUID()
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveWiring) private var wiring
  #if os(macOS)
    @Environment(\.controlActiveState) private var controlActiveState
  #endif

  func body(content: Content) -> some View {
    content
      .onAppear { report() }
      .onDisappear { wiring?.windowClosed(windowId) }
      .onChange(of: scenePhase) { report() }
      .onChange(of: chat) { report() }
      #if os(macOS)
        .onChange(of: controlActiveState) { report() }
      #endif
  }

  private func report() {
    #if os(macOS)
      let active = scenePhase != .background && controlActiveState != .inactive
      let key = scenePhase != .background && controlActiveState == .key
    #else
      let active = scenePhase == .active
      let key = active
    #endif

    wiring?.setPresence(window: windowId, active: active, key: key, gatewayId: chat?.gatewayId, bot: chat?.bot)
  }
}

extension View {
  /// See `ChatWindowPresence`.
  func chatWindowPresence(_ chat: ChatRef?) -> some View {
    modifier(ChatWindowPresence(chat: chat))
  }
}
