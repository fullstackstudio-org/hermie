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
  /// `device.scan`: a camera that can read codes (a capture device exists and no profile restricts it). The reader
  /// works from any camera (VisionKit's scanner where the device has it, a plain capture session where not), so a
  /// Mac with a camera offers it and one without does not.
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
  /// (`CLLocationManager.locationServicesEnabled`), the system contact picker (every device this
  /// app runs on has it) and EventKit with the calendar not restricted. A person who switches
  /// Location Services on later gets it with the next launch; until then a request is answered
  /// `location_unavailable` rather than offered.
  public static let system = DeviceAvailability(
    location: probeLocation(),
    contact: true,
    calendar: probeCalendar(),
    signature: true,
    scan: CameraDevices.isAvailable
  )

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
      // Asked on a queue of its own: the call can block, and it warns when made on the main thread.
      return DispatchQueue.global(qos: .userInitiated).sync { CLLocationManager.locationServicesEnabled() }
    #else
      return false
    #endif
  }

  private static func probeCalendar() -> Bool {
    #if canImport(EventKit)
      // `restricted`: a parental control or a profile forbids the app calendar access, so an entry
      // could never be saved. `denied` stays on the list: that is the person's to change, and it is
      // reported when they press Add.
      return EKEventStore.authorizationStatus(for: .event) != .restricted
    #else
      return false
    #endif
  }
}
