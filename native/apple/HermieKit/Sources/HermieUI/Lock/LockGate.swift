import HermieCore
import SwiftUI

/**
 The gate every window's content sits behind. Nothing below it is rendered while the app is locked.

 `content` is not hidden, blurred or covered while the plate is up: it is not built. That is the
 whole guarantee, and a stronger one than an overlay can make, since an overlay leaves a live chat
 list one layer away and in whatever snapshot the system takes. Sheets presented from inside the
 content go with it.

 Before the preference has been read the gate draws an empty field in the window's background
 colour: drawing the app would flash chats at the person who asked for a lock, drawing the plate
 would flash a lock screen at everybody who did not.
 */
public struct LockGate<Content: View>: View {
  /// What the gate is drawing.
  public enum Face: String, Sendable {
    case pending
    case plate
    case content
  }

  @Environment(AppLaunch.self) private var launch
  @Environment(\.scenePhase) private var phase

  private let content: () -> Content

  public init(@ViewBuilder content: @escaping () -> Content) {
    self.content = content
  }

  /// The gate's whole decision, as a function a test can call.
  public static func face(for lock: AppLock) -> Face {
    guard lock.ready else {
      return .pending
    }

    return lock.machine.locked ? .plate : .content
  }

  public var body: some View {
    let face = Self.face(for: launch.lock)

    Group {
      switch face {
      case .pending:
        PendingField()
      case .plate:
        LockPlate(lock: launch.lock)
      case .content:
        content()
      }
    }
    .task(id: AutoPrompt(face: face, active: phase == .active)) {
      // The plate went up on its own (a cold start, a return after the grace period): ask once, in
      // the first window that is in front, without waiting for a tap.
      guard face == .plate, phase == .active, launch.lock.consumeAutoPrompt() else {
        return
      }

      await launch.lock.unlock(reason: Strings.App.Lock.prompt)
    }
    #if DEBUG
      .onChange(of: face, initial: true) { _, next in
        LaunchTrace.shared.record(next.rawValue)
      }
    #endif
  }

  private struct AutoPrompt: Hashable {
    let face: Face
    let active: Bool
  }
}

/// The frame before the preference is known: the window's own background and nothing else.
struct PendingField: View {
  var body: some View {
    Rectangle()
      .fill(.background)
      .ignoresSafeArea()
      .accessibilityHidden(true)
  }
}

/**
 What a locked Hermie looks like: the app's name, one button, and nothing else. It takes nothing
 about the app's contents, so it cannot give any away.
 */
struct LockPlate: View {
  let lock: AppLock

  var body: some View {
    VStack(spacing: 20) {
      Image(systemName: "lock.fill")
        .font(.largeTitle)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)

      Text(Strings.App.App.name)
        .font(.title.bold())
        .accessibilityAddTraits(.isHeader)

      Text(lock.enrolment == DeviceEnrolment.none ? Strings.App.Lock.stranded : Strings.App.Lock.plateBody)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      Button {
        Task { await lock.unlock(reason: Strings.App.Lock.prompt) }
      } label: {
        Text(Strings.App.Lock.unlock)
          .frame(minWidth: 120)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .keyboardShortcut(.defaultAction)
      .disabled(lock.prompting)
      .accessibilityIdentifier("hermie.lock.unlock")
    }
    .padding(32)
    .frame(maxWidth: 420)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(.background)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.lock.plate")
    .task {
      await lock.checkEnrolment()
    }
  }
}

#if DEBUG
  /// What the gates drew, in order, for the first-frame UI test (`-HermieLaunchTrace`).
  @MainActor
  @Observable
  final class LaunchTrace {
    static let shared = LaunchTrace()

    private(set) var entries: [String] = []

    func record(_ entry: String) {
      if entries.last != entry {
        entries.append(entry)
      }
    }

    var text: String {
      entries.joined(separator: ">")
    }
  }
#endif
