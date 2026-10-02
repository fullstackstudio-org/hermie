#if DEBUG
  import Darwin
  import QuartzCore
  import SwiftUI

  #if os(iOS)
    import UIKit
  #elseif os(macOS)
    import AppKit
  #endif

  /// A frame-pacing meter on the display link: how late frames were, as a hitch
  /// time ratio in milliseconds per second — the unit `XCTHitchMetric` and
  /// Instruments report.
  ///
  /// A frame counts as late when the gap since the previous one is more than
  /// one and a half frame durations; its lateness is the gap minus one frame.
  /// It sees the main thread missing frames (a long layout, a long body), which
  /// is what a list implementation decides; it does not see the render server
  /// dropping a frame the app committed in time, which `XCTHitchMetric` does.
  @MainActor
  public final class HitchMeter: NSObject {
    public private(set) var frames = 0
    public private(set) var hitchedFrames = 0
    public private(set) var hitchTime: CFTimeInterval = 0
    public private(set) var duration: CFTimeInterval = 0
    public private(set) var longestFrame: CFTimeInterval = 0

    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var lastExpected: CFTimeInterval = 1.0 / 60

    /// Milliseconds of hitch per second of measuring.
    public var ratio: Double {
      duration > 0 ? hitchTime * 1000 / duration : 0
    }

    public var summary: String {
      String(
        format: "%.2f ms/s over %.1f s (%d frames, %d late, longest %.1f ms)",
        ratio, duration, frames, hitchedFrames, longestFrame * 1000)
    }

    public func start() {
      stop()
      frames = 0
      hitchedFrames = 0
      hitchTime = 0
      duration = 0
      longestFrame = 0
      last = nil
      #if os(iOS)
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
      #elseif os(macOS)
        guard let screen = NSScreen.main else { return }
        let link = screen.displayLink(target: self, selector: #selector(tick(_:)))
      #endif
      link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
      link.add(to: .main, forMode: .common)
      self.link = link
    }

    public func stop() {
      link?.invalidate()
      link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
      let now = link.timestamp
      let expected = max(link.targetTimestamp - link.timestamp, 1.0 / 240)
      defer {
        last = now
        lastExpected = expected
      }
      guard let last else { return }
      let gap = now - last
      frames += 1
      duration += gap
      longestFrame = max(longestFrame, gap)
      if gap > lastExpected * 1.5 {
        hitchedFrames += 1
        hitchTime += gap - lastExpected
      }
    }
  }

  /// The process's physical footprint, the number Xcode's memory gauge and
  /// jetsam use.
  public enum MemoryFootprint {
    public static func current() -> UInt64 {
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
      let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), raw, &count)
        }
      }
      return result == KERN_SUCCESS ? info.phys_footprint : 0
    }

    public static func megabytes(_ bytes: UInt64) -> String {
      String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }
  }
#endif
