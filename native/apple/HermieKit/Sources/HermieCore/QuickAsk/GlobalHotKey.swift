import Foundation
import Observation

#if os(macOS)
  import Carbon.HIToolbox
#endif

/// Why the system would not give out a shortcut.
public enum GlobalHotKeyError: Error, Equatable, Sendable {
  /// Another app, or the system, already has this shortcut.
  case taken
  /// The system refused for another reason (its `OSStatus`).
  case failed(Int32)
}

/**
 Where a global shortcut is asked of the system. The Mac's is `CarbonHotKeyRegistrar`; a test hands
 in its own, so no test ever registers a real shortcut on the Mac it runs on.

 One shortcut at a time: registering another one lets go of the first.
 */
@MainActor
public protocol GlobalHotKeyRegistering: AnyObject {
  /// Ask for `shortcut`; `handler` runs, on the main actor, each time it is pressed anywhere.
  func register(_ shortcut: HotKeyShortcut, handler: @escaping @MainActor () -> Void) throws(GlobalHotKeyError)
  /// Give the shortcut back. Nothing happens when there is none.
  func unregister()
}

/// Where the global shortcut stands, for Settings.
public enum GlobalHotKeyStatus: Equatable, Sendable {
  /// None is chosen.
  case off
  /// Registered: pressing it anywhere opens the quick ask.
  case active(HotKeyShortcut)
  /// Chosen, and the system would not give it out.
  case unavailable(HotKeyShortcut, GlobalHotKeyError)
}

/**
 Keeps the system's global shortcut equal to the one in `QuickAskSettings`: `apply()` registers it,
 lets go of the old one when it changed, and says in `status` how that went.

 It never needs the Accessibility permission, which the registrar's API does not ask for.
 */
@MainActor
@Observable
public final class GlobalHotKeyController {
  public private(set) var status = GlobalHotKeyStatus.off

  @ObservationIgnored private let settings: QuickAskSettings
  @ObservationIgnored private let registrar: any GlobalHotKeyRegistering
  @ObservationIgnored private let onPress: @MainActor () -> Void
  /// What is registered now, so an unchanged shortcut is not registered twice.
  @ObservationIgnored private var registered: HotKeyShortcut?

  /// - Parameter onPress: what the shortcut does: the app opens the quick ask.
  public init(
    settings: QuickAskSettings, registrar: any GlobalHotKeyRegistering, onPress: @escaping @MainActor () -> Void
  ) {
    self.settings = settings
    self.registrar = registrar
    self.onPress = onPress
  }

  /// Make the system's shortcut the settings' one. Safe to call as often as wanted.
  public func apply() {
    guard let shortcut = settings.hotKey else {
      registrar.unregister()
      registered = nil
      status = .off
      return
    }

    // A shortcut the system refused is asked for again: the other app may have let go of it.
    if registered == shortcut, case .active = status {
      return
    }

    let press = onPress

    do {
      try registrar.register(shortcut, handler: { press() })
      registered = shortcut
      status = .active(shortcut)
    } catch {
      registered = nil
      status = .unavailable(shortcut, error)
    }
  }

  /// Let go of the shortcut for a while, without forgetting it: Settings does while it listens for a
  /// new one, so the keys pressed reach the field and not the shortcut that is registered now.
  /// `apply()` takes it back.
  public func suspend() {
    registrar.unregister()
    registered = nil
    status = .off
  }

  /// Choose another shortcut (or none) and register it. A shortcut `HotKeyShortcut.isValid` refuses
  /// changes nothing and answers false.
  @discardableResult
  public func choose(_ shortcut: HotKeyShortcut?) -> Bool {
    guard settings.setHotKey(shortcut) else {
      return false
    }

    apply()
    return true
  }
}

#if os(macOS)
  /**
   The Mac's registrar: Carbon's `RegisterEventHotKey`, which needs no permission (not Accessibility,
   not Input Monitoring) and works inside the sandbox. It is the API every launcher's hot key uses;
   nothing else in this app touches Carbon.
   */
  @MainActor
  public final class CarbonHotKeyRegistrar: GlobalHotKeyRegistering {
    /// 'HRMI': this app's hot keys, in Carbon's four-character code.
    private static let signature: OSType = 0x4852_4D49
    private static let hotKeyID: UInt32 = 1

    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var action: (@MainActor () -> Void)?

    public init() {}

    isolated deinit {
      unregister()

      if let handler {
        RemoveEventHandler(handler)
      }
    }

    public func register(_ shortcut: HotKeyShortcut, handler: @escaping @MainActor () -> Void) throws(GlobalHotKeyError) {
      unregister()
      try installHandler()

      var reference: EventHotKeyRef?
      let identifier = EventHotKeyID(signature: Self.signature, id: Self.hotKeyID)
      let status = RegisterEventHotKey(
        UInt32(shortcut.keyCode), shortcut.carbonModifiers, identifier, GetApplicationEventTarget(), 0, &reference)

      guard status == noErr, let reference else {
        throw status == OSStatus(eventHotKeyExistsErr) ? .taken : .failed(status)
      }

      hotKey = reference
      action = handler
    }

    public func unregister() {
      if let hotKey {
        UnregisterEventHotKey(hotKey)
      }

      hotKey = nil
      action = nil
    }

    /// The application's one handler for "a hot key was pressed", installed the first time.
    private func installHandler() throws(GlobalHotKeyError) {
      guard handler == nil else {
        return
      }

      var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
      var reference: EventHandlerRef?
      let status = InstallEventHandler(
        GetApplicationEventTarget(),
        { _, event, userData in
          guard let event, let userData else {
            return OSStatus(eventNotHandledErr)
          }

          var identifier = EventHotKeyID()
          let read = GetEventParameter(
            event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
            MemoryLayout<EventHotKeyID>.size, nil, &identifier)

          guard read == noErr, identifier.signature == CarbonHotKeyRegistrar.signature,
            identifier.id == CarbonHotKeyRegistrar.hotKeyID
          else {
            return OSStatus(eventNotHandledErr)
          }

          let registrar = Unmanaged<CarbonHotKeyRegistrar>.fromOpaque(userData).takeUnretainedValue()

          // Delivered on the main thread; hopped through the queue so nothing runs inside Carbon's call.
          DispatchQueue.main.async {
            MainActor.assumeIsolated { registrar.action?() }
          }

          return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &reference)

      guard status == noErr, let reference else {
        throw .failed(status)
      }

      handler = reference
    }
  }
#endif
