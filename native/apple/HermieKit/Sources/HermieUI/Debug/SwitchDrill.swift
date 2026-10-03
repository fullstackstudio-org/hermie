#if DEBUG && os(iOS)
  import HermieCore
  import SwiftUI
  import UIKit

  /**
   Switches between chats the way a hand does, for reproducing what a switch does to the chat
   screen without a UI test. Debug builds launched with `-HermieUITest YES` only:

   ```sh
   xcrun simctl launch <device> dev.hermie.app.dev -HermieUITest YES \
     -HermieSeedICloudGateway 'Fake|http://127.0.0.1:<port>|<token>' \
     -HermieSwitchDrill writer,researcher -HermieSwitchDrillMode pop
   ```

   Each step opens the next bot's chat through the router and, after a pause that shortens and
   lengthens from step to step, goes back: `pop` pops the collapsed split view's navigation
   controller as the back button does, `router` closes the chat through the router, `direct` opens
   the next chat straight away (a link, a bot-to-bot row). Every step is in the lifecycle log
   (`log stream --predicate 'subsystem == "dev.hermie.app" AND category == "chat"'`).
   `-HermieSwitchDrillHold YES` stops at the first chat screen SwiftUI called gone while it stayed on
   screen (the old black chat) and copies the chat's diagnostics, for `xcrun simctl pbpaste`.
   */
  struct SwitchDrill: ViewModifier {
    @Environment(AppRouter.self) private var router
    @Environment(LiveGateway.self) private var live: LiveGateway?

    static let copyDiagnostics = Notification.Name("HermieSwitchDrillCopyDiagnostics")

    func body(content: Content) -> some View {
      content.task {
        await run(arguments: ProcessInfo.processInfo.arguments)
      }
    }

    private func run(arguments: [String]) async {
      func value(_ flag: String) -> String? {
        arguments.firstIndex(of: flag).flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
      }

      guard value("-HermieUITest") == "YES", let list = value("-HermieSwitchDrill") else {
        return
      }

      let bots = list.split(separator: ",").map(String.init)
      let mode = value("-HermieSwitchDrillMode") ?? "pop"
      let hold = value("-HermieSwitchDrillHold") == "YES"

      // The roster loads first.
      try? await Task.sleep(for: .seconds(4))

      guard let gatewayId = live?.gatewayID, !bots.isEmpty else {
        ChatLifecycleLog.note("drill: no gateway or no bots")
        return
      }

      let pauses: [Double] = [1.5, 0.8, 0.4, 0.25, 0.15, 0.1, 0.05, 0.6, 0.3, 0.02]

      for step in 0..<(12 * bots.count) {
        let bot = bots[step % bots.count]
        let pause = pauses[step % pauses.count]

        ChatLifecycleLog.note("drill: step \(step) opens \(bot)")
        router.openChat(ChatRef(gatewayId: gatewayId, bot: bot))
        try? await Task.sleep(for: .seconds(pause + 0.6))

        if hold, let last = ChatLifecycleLog.events.last(where: { $0.contains(" screen #") }), last.contains("disappeared") {
          ChatLifecycleLog.note("drill: holding at \(bot), gone to SwiftUI but on screen")
          NotificationCenter.default.post(name: Self.copyDiagnostics, object: nil)
          return
        }

        switch mode {
        case "pop": Self.popCollapsedStack()
        case "router": router.closeChat()
        default: break
        }

        try? await Task.sleep(for: .seconds(pause))
      }

      ChatLifecycleLog.note("drill: done")
    }

    /// What the back button does: pops the outermost navigation controller that has somewhere to
    /// go back to (the collapsed split view's).
    private static func popCollapsedStack() {
      let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      guard let root = windows.first(where: \.isKeyWindow)?.rootViewController else { return }
      var stacks: [UINavigationController] = []

      func walk(_ controller: UIViewController) {
        if let stack = controller as? UINavigationController { stacks.append(stack) }
        controller.children.forEach(walk)
      }

      walk(root)

      if let stack = stacks.first(where: { $0.viewControllers.count > 1 }) {
        stack.popViewController(animated: true)
      } else {
        ChatLifecycleLog.note("drill: nothing to pop")
      }
    }
  }
#endif
