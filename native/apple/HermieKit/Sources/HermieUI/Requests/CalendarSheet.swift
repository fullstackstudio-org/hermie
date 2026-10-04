import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for a `device.calendar` (`contract/requests/README.md` §11): the event or reminder the
/// agent suggests, shown as it would be saved (title, times, place and notes; the address as plain
/// text, never a link), and added only when the person says so.
///
/// On iPhone and iPad an event goes through the system's own edit sheet, prefilled: the answer is
/// `done` only when the person saves there, `skipped` when they cancel. Where the system has no such
/// sheet (the Mac, and a reminder anywhere) Add is the save, after the system's access question
/// (write-only for events), which this sheet says before it asks.
struct CalendarSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let request: DeviceCalendarRequest

  @State private var calendar: InteractiveCalendarModel
  @State private var armed = false

  init(
    model: InteractiveModel, prompt: InteractivePrompt, request: DeviceCalendarRequest,
    store: any DeviceCalendarStore = EventKitCalendarStore.shared
  ) {
    self.model = model
    self.prompt = prompt
    self.request = request
    #if os(iOS)
      let hasEventEditor = true
    #else
      let hasEventEditor = false
    #endif
    _calendar = State(
      initialValue: InteractiveCalendarModel(
        request: request, store: store, hasEventEditor: hasEventEditor, offersSkip: prompt.offersSkip))
  }

  private var item: CalendarItem { request.item }
  private var isEvent: Bool { request.kind == .event }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: isEvent ? "calendar.badge.plus" : "bell.badge",
      title: isEvent
        ? NativeStrings.Interactive.titleCalendarEvent(model.botName)
        : NativeStrings.Interactive.titleCalendarReminder(model.botName),
      busy: calendar.isBusy || model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        entry

        Text(note)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("calendar.note")

        status
      }
      .disabled(model.isSending)
    } actions: {
      VStack(spacing: 6) {
        InteractiveButtonRow {
          LaterButton(model: model)

          if prompt.offersSkip {
            SkipButton(model: model, armed: armed, disabled: calendar.isBusy || calendar.isSaved)
          }

          addButton
        }
        DeclineButton(model: model, armed: armed && !calendar.isBusy)
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    #if os(iOS)
      .sheet(
        isPresented: Binding(
          get: { calendar.isEditing },
          set: { presented in
            // Swiped away: not saved.
            if !presented, calendar.isEditing {
              finishEditing(saved: false)
            }
          })
      ) {
        EventEditor(item: item) { saved in
          finishEditing(saved: saved)
        }
        .ignoresSafeArea()
      }
    #endif
    // A system sheet is up, or the entry is being written: an approval waits rather than cutting it off.
    .onChange(of: calendar.isBusy) { _, busy in
      model.setWorking(busy)
    }
    .onDisappear {
      model.setWorking(false)
    }
  }

  // MARK: Pieces

  /// The item, as it would be saved.
  private var entry: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(isEvent ? NativeStrings.Interactive.Calendar.kindEvent : NativeStrings.Interactive.Calendar.kindReminder)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Text(verbatim: InteractivePrompt.line(item.title, limit: CalendarItem.titleLimit))
        .font(.title3.weight(.semibold))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("calendar.title")

      row(NativeStrings.Interactive.Calendar.when, Self.whenText(item, kind: request.kind), id: "when")

      if let place = item.location {
        row(NativeStrings.Interactive.Calendar.where, InteractivePrompt.line(place, limit: CalendarItem.locationLimit), id: "where")
      }

      if let url = item.url {
        // Plain text: never a link, never opened.
        row(NativeStrings.Interactive.Calendar.link, url, id: "link", monospaced: true)
      }

      if let alert = Self.alertText(item) {
        row(NativeStrings.Interactive.Calendar.alert, alert, id: "alert")
      }

      if let notes = item.notes {
        VStack(alignment: .leading, spacing: 4) {
          Text(NativeStrings.Interactive.Calendar.notes)
            .font(.caption)
            .foregroundStyle(.secondary)
          RequestTextBox(
            text: InteractivePrompt.text(notes, limit: CalendarItem.notesLimit), identifier: "calendar.notes")
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("calendar.entry")
  }

  private func row(_ label: String, _ value: String, id: String, monospaced: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(verbatim: value)
        .font(monospaced ? .callout.monospaced() : .body)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("calendar.\(id)")
    }
    .accessibilityElement(children: .combine)
  }

  /// What pressing Add does, said before it does it.
  private var note: String {
    switch calendar.route {
    case .systemEditor: NativeStrings.Interactive.Calendar.noteEditor
    case .directSave: isEvent ? NativeStrings.Interactive.Calendar.noteDirectEvent : NativeStrings.Interactive.Calendar.noteReminder
    }
  }

  @ViewBuilder private var status: some View {
    if calendar.phase == .saving {
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(NativeStrings.Interactive.Calendar.saving)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("calendar.saving")
    } else if calendar.isSaved {
      Label(NativeStrings.Interactive.Calendar.savedNotSent, systemImage: "checkmark.circle")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("calendar.savedNotSent")
    } else if calendar.phase == .failed {
      Label(NativeStrings.Interactive.Calendar.failed, systemImage: "exclamationmark.triangle")
        .font(.callout)
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("calendar.failed")
    } else if !prompt.offersSkip, didCancelEditor {
      Label(NativeStrings.Interactive.Calendar.notSaved, systemImage: "info.circle")
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("calendar.notSaved")
    }
  }

  @State private var didCancelEditor = false

  private var addButton: some View {
    Button {
      add()
    } label: {
      Text(
        model.hasFailed
          ? NativeStrings.Interactive.tryAgain
          : isEvent ? NativeStrings.Interactive.Calendar.addEvent : NativeStrings.Interactive.Calendar.addReminder
      )
      .font(.title3.weight(.semibold))
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || calendar.isBusy || model.isSending)
    .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "calendar.add")
  }

  private func add() {
    guard armed, !calendar.isBusy, !model.isSending else {
      return
    }

    let calendar = self.calendar
    let model = self.model
    didCancelEditor = false

    Task {
      if let step = await calendar.add() {
        await model.perform(step)
      }
    }
  }

  private func finishEditing(saved: Bool) {
    guard let step = calendar.editorFinished(saved: saved) else {
      didCancelEditor = !saved
      return
    }

    let model = self.model
    Task {
      await model.perform(step)
    }
  }

  // MARK: Words

  /// When, in the device's own time (the calendar shows it so), with the zone named for a timed item.
  static func whenText(_ item: CalendarItem, kind: CalendarKind) -> String {
    switch (item.start, item.end) {
    case (.day(let first)?, let last):
      let begin = localDay(first)

      if case .day(let end)? = last, end != first {
        return (begin..<localDay(end)).formatted(Date.IntervalFormatStyle(date: .abbreviated))
          + " · " + NativeStrings.Interactive.Calendar.allDay
      }

      return begin.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted))
        + " · " + NativeStrings.Interactive.Calendar.allDay
    case (.instant(let first)?, let last):
      let style = Date.FormatStyle(date: .abbreviated, time: .shortened).timeZone(.specificName(.short))
      let begin = first.date.formatted(style)

      if case .instant(let end)? = last {
        return begin + " – " + end.date.formatted(style)
      }

      return begin
    default:
      return kind == .event ? NativeStrings.Interactive.Calendar.noTimeEvent : NativeStrings.Interactive.Calendar.noTimeReminder
    }
  }

  /// "At the time", "30 minutes before"; nil without an alert.
  static func alertText(_ item: CalendarItem, locale: Locale = .current) -> String? {
    guard let minutes = item.alarmMinutes else {
      return nil
    }

    if minutes == 0 {
      return NativeStrings.Interactive.Calendar.alertAtStart
    }

    let formatter = DateComponentsFormatter()
    var calendar = Foundation.Calendar.current
    calendar.locale = locale
    formatter.calendar = calendar
    formatter.unitsStyle = .full
    formatter.allowedUnits = [.day, .hour, .minute]
    formatter.maximumUnitCount = 2
    let duration = formatter.string(from: TimeInterval(minutes) * 60) ?? "\(minutes)"
    return NativeStrings.Interactive.Calendar.alertBefore(duration)
  }

  private static func localDay(_ day: CalendarDay) -> Date {
    Foundation.Calendar.current.date(from: DateComponents(year: day.year, month: day.month, day: day.day)) ?? Date()
  }
}
