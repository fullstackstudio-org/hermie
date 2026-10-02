import HermieCore
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// What covers a window while it is not in front: the plate's look, without the button.
struct PrivacyCoverView: View {
  var body: some View {
    VStack(spacing: 20) {
      Image(systemName: "lock.fill")
        .font(.largeTitle)
        .foregroundStyle(.tint)
      Text(Strings.App.App.name)
        .font(.title.bold())
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.background)
    .ignoresSafeArea()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(NativeStrings.Lock.coverLabel)
    .accessibilityIdentifier("hermie.privacyCover")
  }
}

/// Whether a window must be covered: it is not in front while a lock is configured (or unknown).
enum PrivacyCoverPolicy {
  static func covers(phase: ScenePhase, lockConfigured: Bool) -> Bool {
    lockConfigured && phase != .active
  }
}

extension View {
  /**
   Cover this window with an opaque view whenever it is not in front while a lock is configured,
   so the app switcher's snapshot never shows a chat.

   On iPhone and iPad the cover is a window of its own above everything the scene shows (sheets
   and alerts included), shown synchronously on `UIScene.willDeactivateNotification`, which is
   before the snapshot is taken. On the Mac it is an overlay on the window's content.
   */
  func privacyCover(_ lock: AppLock) -> some View {
    modifier(PrivacyCoverModifier(lock: lock))
  }
}

private struct PrivacyCoverModifier: ViewModifier {
  let lock: AppLock

  #if os(macOS)
    @Environment(\.scenePhase) private var phase
  #endif

  func body(content: Content) -> some View {
    #if os(iOS)
      content
        .background(PrivacyCoverInstaller(lock: lock).frame(width: 0, height: 0))
    #else
      content
        .overlay {
          if PrivacyCoverPolicy.covers(phase: phase, lockConfigured: lock.coversWhenInactive) {
            PrivacyCoverView()
          }
        }
    #endif
  }
}

#if os(iOS)
  /// Finds the scene this view is in and gives it a cover window, once per scene.
  private struct PrivacyCoverInstaller: UIViewRepresentable {
    let lock: AppLock

    func makeUIView(context: Context) -> InstallerView {
      InstallerView(lock: lock)
    }

    func updateUIView(_ view: InstallerView, context: Context) {}

    final class InstallerView: UIView {
      let lock: AppLock

      init(lock: AppLock) {
        self.lock = lock
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
      }

      @available(*, unavailable)
      required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
      }

      override func didMoveToWindow() {
        super.didMoveToWindow()

        if let scene = window?.windowScene {
          PrivacyCoverController.install(on: scene, lock: lock)
        }
      }
    }
  }

  /// One scene's cover: a window above the alert level, hidden while the scene is in front.
  @MainActor
  final class PrivacyCoverController {
    private static var controllers: [ObjectIdentifier: PrivacyCoverController] = [:]

    static func install(on scene: UIWindowScene, lock: AppLock) {
      let key = ObjectIdentifier(scene)

      guard controllers[key] == nil else {
        return
      }

      controllers[key] = PrivacyCoverController(scene: scene, lock: lock)
    }

    private let window: UIWindow
    private var observers: [NSObjectProtocol] = []

    private init(scene: UIWindowScene, lock: AppLock) {
      window = UIWindow(windowScene: scene)
      window.windowLevel = .alert + 1
      window.rootViewController = UIHostingController(rootView: PrivacyCoverView())
      window.isHidden = true

      let center = NotificationCenter.default
      let key = ObjectIdentifier(scene)

      // Shown on the way out, before the snapshot; hidden only once the scene is in front again.
      for name in [UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification] {
        observers.append(
          center.addObserver(forName: name, object: scene, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
              guard let self, lock.coversWhenInactive else { return }
              self.window.isHidden = false
            }
          }
        )
      }

      observers.append(
        center.addObserver(forName: UIScene.didActivateNotification, object: scene, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated {
            self?.window.isHidden = true
          }
        }
      )

      observers.append(
        center.addObserver(forName: UIScene.didDisconnectNotification, object: scene, queue: .main) { _ in
          MainActor.assumeIsolated {
            PrivacyCoverController.controllers[key]?.tearDown()
            PrivacyCoverController.controllers[key] = nil
          }
        }
      )
    }

    private func tearDown() {
      observers.forEach(NotificationCenter.default.removeObserver)
      observers = []
      window.isHidden = true
    }
  }
#endif

/**
 Feeds the app's own activity to the lock machine: resigning active counts as going away (the
 switcher snapshot is taken on that transition, and a Mac app losing the front reports it), the
 background or a hidden Mac app counts as going away entirely, and becoming active is coming back.

 App-wide, not per window: the lock is one state for the whole app, and every window's gate reads
 it. Installed once, by the first window.
 */
@MainActor
enum ApplicationActivity {
  private static var observers: [NSObjectProtocol] = []

  static func follow(_ lock: AppLock) {
    guard observers.isEmpty else {
      return
    }

    #if os(iOS)
      let away = UIApplication.willResignActiveNotification
      let gone = UIApplication.didEnterBackgroundNotification
      let back = UIApplication.didBecomeActiveNotification
    #else
      let away = NSApplication.willResignActiveNotification
      let gone = NSApplication.didHideNotification
      let back = NSApplication.didBecomeActiveNotification
    #endif

    let center = NotificationCenter.default

    observers = [
      center.addObserver(forName: away, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { lock.appWentAway() }
      },
      center.addObserver(forName: gone, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { lock.appWentAway(entirely: true) }
      },
      center.addObserver(forName: back, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { lock.appCameBack() }
      }
    ]
  }
}
