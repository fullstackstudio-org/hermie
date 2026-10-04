import Foundation
import HermieProtocol

#if canImport(CoreLocation)
  import CoreLocation
#endif
#if canImport(EventKit)
  import EventKit
#endif

/// Which of the device requests (`device.location`, `device.contact`, `device.calendar`) this
/// device can show at all: the list a connection announces as `requests`
/// (`InteractiveCapabilities.deviceMethods(availability:)`).
///
/// "At all" means the device could show the request to somebody who agrees: Location Services are
/// on, the system contact picker exists, the calendar is not locked down by a restriction. A request
/// this device announced and cannot serve right now (no fix, permission refused) is answered
/// `4041 cannot_show` from its sheet, not hidden from the bot up front: the person's permission
/// choices are theirs to make when they press Share, and are not read when a session starts.
public struct DeviceAvailability: Sendable, Equatable {
  /// `device.location`.
  public var location: Bool
  /// `device.contact`.
  public var contact: Bool
  /// `device.calendar`.
  public var calendar: Bool
  /// `input.signature`: the pad needs only a screen and a finger, a pen or a pointer.
  public var signature: Bool
  /// `device.scan`: a camera that can read codes (a capture device exists and no profile restricts it) AND a reader
  /// that exists here: VisionKit's scanner where the device has it, the capture session's barcode types where it
  /// offers them, and otherwise Vision on the frames (`CodeReaders`). A Mac with a camera offers it and one without
  /// does not.
  public var scan: Bool

  public init(
    location: Bool = false, contact: Bool = false, calendar: Bool = false, signature: Bool = false, scan: Bool = false
  ) {
    self.location = location
    self.contact = contact
    self.calendar = calendar
    self.signature = signature
    self.scan = scan
  }

  /// Nothing: the device announces none of the device requests (a test of the base list).
  public static let none = DeviceAvailability()

  /// What this device offers, read from the system once per process: Location Services on
  /// (`CLLocationManager.locationServicesEnabled`), the system contact picker (iPhone and iPad; see
  /// `contactPickerOffered`), and EventKit with the calendar and reminders not restricted. A person who
  /// switches Location Services on later gets it with the next launch; until then a request is answered
  /// `location_unavailable` rather than offered.
  ///
  /// The first read can be slow (`locationServicesEnabled` can block): `warmUp()` makes it off the main
  /// thread, early in the launch.
  public static let system = DeviceAvailability(
    location: probeLocation(),
    contact: contactPickerOffered(onMac: Self.isMac),
    calendar: probeCalendar(),
    signature: true,
    scan: scanOffered(camera: CameraDevices.isAvailable, reader: CodeReaders.isAvailable)
  )

  /// Read `system` on a background thread now, so the main thread does not wait for it when the first session
  /// announces its requests.
  public static func warmUp() {
    Task.detached(priority: .utility) {
      _ = DeviceAvailability.system
    }
  }

  #if os(macOS)
    private static let isMac = true
  #else
    private static let isMac = false
  #endif

  /// `device.contact` on the Mac is not offered. `CNContactPicker` runs in its own process, but nothing in this
  /// repository can show that a sandboxed app WITHOUT the address book entitlement is handed the details of the
  /// contact the person picks (it is a popover; no test can click it), and the alternative, the entitlement and the
  /// system's "access all your contacts" question, is more than one shared contact deserves. Until a Mac has
  /// proven it, the bot is told this device cannot show it up front rather than failing on the sheet. The sheet's
  /// Mac code stays in place for the day it is verified (flip `macContactPickerVerified`).
  static let macContactPickerVerified = false

  static func contactPickerOffered(onMac: Bool, macVerified: Bool = macContactPickerVerified) -> Bool {
    !onMac || macVerified
  }

  /// A camera that hands over frames AND a reader for them: the capture session's own barcode types where the
  /// device has them, Vision on the frames where not (the Mac).
  static func scanOffered(camera: Bool, reader: Bool) -> Bool {
    camera && reader
  }

  /// Whether `method` is one of the device requests this value covers; a method that is not a device
  /// request is always `true` (it does not depend on the device).
  public func offers(_ method: String) -> Bool {
    switch method {
    case ServerRequestBody.Method.deviceLocation: location
    case ServerRequestBody.Method.deviceContact: contact
    case ServerRequestBody.Method.deviceCalendar: calendar
    case ServerRequestBody.Method.inputSignature: signature
    case ServerRequestBody.Method.deviceScan: scan
    default: true
    }
  }

  private static func probeLocation() -> Bool {
    #if canImport(CoreLocation)
      // The call can block, and the system warns when it is made on the main thread. `warmUp()` reads
      // this off the main thread; a first read that does land on it hops to a queue of its own.
      if Thread.isMainThread {
        return DispatchQueue.global(qos: .userInitiated).sync { CLLocationManager.locationServicesEnabled() }
      }

      return CLLocationManager.locationServicesEnabled()
    #else
      return false
    #endif
  }

  private static func probeCalendar() -> Bool {
    #if canImport(EventKit)
      return calendarOffered(
        event: EKEventStore.authorizationStatus(for: .event),
        reminder: EKEventStore.authorizationStatus(for: .reminder),
        onMac: isMac,
        hasDefaultEventCalendar: { EKEventStore().defaultCalendarForNewEvents != nil })
    #else
      return false
    #endif
  }

  #if canImport(EventKit)
    /// `restricted` for events AND for reminders: a parental control or a profile forbids the app both, so no
    /// entry could ever be saved (the method serves the two kinds, and which one comes is not known when the
    /// list is announced; one that is restricted alone is answered `permission_denied` from the sheet). `denied`
    /// stays on the list: that is the person's to change, and it is reported when they press Add.
    ///
    /// On the Mac, where the system has no edit sheet and Add saves the entry itself, a write-only grant
    /// (or a full one) with no default calendar to put it in means an event could never be saved, so it is
    /// not offered. Before anything was granted that cannot be known, and the sheet answers `4041` if it
    /// turns out so (`CalendarSaveOutcome.noCalendar`).
    static func calendarOffered(
      event: EKAuthorizationStatus, reminder: EKAuthorizationStatus, onMac: Bool,
      hasDefaultEventCalendar: () -> Bool
    ) -> Bool {
      if event == .restricted, reminder == .restricted {
        return false
      }

      if onMac, event == .writeOnly || event == .fullAccess {
        return hasDefaultEventCalendar()
      }

      return true
    }
  #endif
}
