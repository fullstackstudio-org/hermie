import Contacts
import ContactsUI
import HermieCore
import HermieProtocol
import SwiftUI

#if os(iOS)
  import EventKit
  import EventKitUI
  import UIKit

  /// The system's contact picker, for ONE contact: it runs in its own process and hands over only the
  /// contact the person taps, so the app asks for no access to the address book. Shown in a sheet.
  struct ContactPicker: UIViewControllerRepresentable {
    /// What the agent asked for: nothing else is copied out of the chosen contact.
    let requested: [ContactField]
    let onPick: (ContactSnapshot) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> CNContactPickerViewController {
      let picker = CNContactPickerViewController()
      picker.delegate = context.coordinator
      // A tap on a contact returns that contact, rather than drilling into one of its properties.
      picker.predicateForSelectionOfContact = NSPredicate(value: true)
      return picker
    }

    func updateUIViewController(_ picker: CNContactPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency CNContactPickerDelegate {
      let parent: ContactPicker

      init(_ parent: ContactPicker) {
        self.parent = parent
      }

      func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
        parent.onPick(ContactSnapshot(contact, requested: parent.requested))
      }

      func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
        parent.onCancel()
      }
    }
  }

  /// The system's own sheet for adding an event, prefilled: the person looks at it, changes what
  /// they like and saves, or cancels. Nothing is written before they save there, and `onFinished` says
  /// whether they did. It needs no calendar permission of ours (the sheet runs in its own process).
  struct EventEditor: UIViewControllerRepresentable {
    let item: CalendarItem
    let onFinished: (Bool) -> Void

    func makeUIViewController(context: Context) -> EKEventEditViewController {
      let store = EKEventStore()
      let controller = EKEventEditViewController()
      controller.eventStore = store
      controller.event = item.makeEvent(in: store)
      controller.editViewDelegate = context.coordinator
      return controller
    }

    func updateUIViewController(_ controller: EKEventEditViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
      Coordinator(self)
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency EKEventEditViewDelegate {
      let parent: EventEditor

      init(_ parent: EventEditor) {
        self.parent = parent
      }

      func eventEditViewController(
        _ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction
      ) {
        parent.onFinished(action == .saved)
      }
    }
  }
#endif

#if os(macOS)
  import AppKit

  /// Where the Mac's contact picker (a popover) hangs from.
  @MainActor
  final class ContactPickerAnchor {
    weak var view: NSView?
  }

  struct ContactPickerAnchorView: NSViewRepresentable {
    let anchor: ContactPickerAnchor

    func makeNSView(context: Context) -> NSView {
      let view = NSView()
      anchor.view = view
      return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
  }

  /// The Mac's contact picker (`CNContactPicker`): a popover that hands over the one contact the person
  /// clicks, in its own process, so the app asks for no access to the address book.
  @MainActor
  final class MacContactPicker: NSObject, @preconcurrency CNContactPickerDelegate {
    private let picker = CNContactPicker()
    private var onPick: ((ContactSnapshot) -> Void)?
    private var onClose: (() -> Void)?

    private var requested: [ContactField] = []

    func show(
      from view: NSView, requested: [ContactField], onPick: @escaping (ContactSnapshot) -> Void,
      onClose: @escaping () -> Void
    ) {
      self.requested = requested
      self.onPick = onPick
      self.onClose = onClose
      picker.delegate = self
      picker.showRelative(to: view.bounds, of: view, preferredEdge: .minY)
    }

    func contactPicker(_ picker: CNContactPicker, didSelect contact: CNContact) {
      onPick?(ContactSnapshot(contact, requested: requested))
    }

    func contactPickerDidClose(_ picker: CNContactPicker) {
      onClose?()
      onPick = nil
      onClose = nil
    }
  }
#endif
