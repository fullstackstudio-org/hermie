#if os(macOS)
  import AppKit
  import SwiftUI

  /// Tells the transcript list about the reader's scroll wheel and trackpad over it (`ReaderWheel`).
  ///
  /// The Mac's SwiftUI scroll view reports a phase for a trackpad's gesture, but none for a mouse's
  /// notched wheel, and a geometry change in which the rows also changed size cannot say what moved
  /// the offset. The scroll wheel events themselves can: this watches them (a local monitor, which
  /// sees each event before the scroll view does and lets it through unchanged) and reports those
  /// over the list's own frame in its own window.
  struct ReaderWheelMonitor: NSViewRepresentable {
    /// The event, mapped, and its timestamp (seconds since the system started, as
    /// `ProcessInfo.systemUptime`).
    let onWheel: @MainActor (ReaderWheel.Input, Double) -> Void

    func makeNSView(context: Context) -> WheelView {
      let view = WheelView()
      view.onWheel = onWheel
      return view
    }

    func updateNSView(_ view: WheelView, context: Context) {
      view.onWheel = onWheel
    }

    static func dismantleNSView(_ view: WheelView, coordinator: ()) {
      view.stop()
    }

    /// The input a scroll wheel event is, by its phases.
    static func input(phase: NSEvent.Phase, momentumPhase: NSEvent.Phase) -> ReaderWheel.Input {
      if phase.isEmpty && momentumPhase.isEmpty {
        return .step
      }
      let ending: NSEvent.Phase = [.ended, .cancelled]
      if !momentumPhase.isEmpty {
        return momentumPhase.isDisjoint(with: ending) ? .moving : .ended
      }
      return phase.isDisjoint(with: ending) ? .moving : .ended
    }

    /// Draws nothing and takes no events; it only knows where the list is.
    final class WheelView: NSView {
      var onWheel: (@MainActor (ReaderWheel.Input, Double) -> Void)?
      private var monitor: Any?

      override func hitTest(_ point: NSPoint) -> NSView? { nil }

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
          stop()
        } else if monitor == nil {
          monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.received(event)
            return event
          }
        }
      }

      func stop() {
        if let monitor {
          NSEvent.removeMonitor(monitor)
        }
        monitor = nil
      }

      private func received(_ event: NSEvent) {
        guard let window, event.window === window, event.deltaY != 0 || !event.phase.isEmpty
          || !event.momentumPhase.isEmpty
        else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point) else { return }
        onWheel?(ReaderWheelMonitor.input(phase: event.phase, momentumPhase: event.momentumPhase), event.timestamp)
      }
    }
  }
#endif
