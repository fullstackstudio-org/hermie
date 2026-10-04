import HermieCore
import SwiftUI

/**
 The cron editor, as a sheet over the list or the detail (`CronEditorSheet.tsx`): what it does (a name
 and the instructions), when (the schedule builder) and where it goes (the delivery target and, for a
 new cron, the profile).

 It never predicts when the cron will fire. It builds a schedule string, the gateway parses it, and the
 `next_run_at` that comes back is what the detail shows: any countdown computed here would be in the
 phone's timezone, and the scheduler runs in the gateway's.

 What is wrong is said once the reader tried to save (a half-typed field does not shout); the checks
 are `CronEditorDraft`'s, and the gateway makes them again and says what it refuses.
 */
struct CronEditorSheet: View {
  let model: CronsModel
  let session: GatewaySession
  let editing: CronJob?

  @State private var draft: CronEditorDraft
  @State private var touched = false
  @Environment(\.dismiss) private var dismiss

  init(model: CronsModel, session: GatewaySession, editing: CronJob?) {
    self.model = model
    self.session = session
    self.editing = editing
    _draft = State(initialValue: editing.map { CronEditorDraft(editing: $0) } ?? CronEditorDraft())
  }

  var body: some View {
    NavigationStack {
      Form {
        whatSection
        scheduleSection
        whereSection

        if let error = model.saveError {
          Section {
            Text(verbatim: Strings.Cron.Editor.saveFailed(reason: error))
              .foregroundStyle(.red)
              .accessibilityIdentifier("hermie.cron.editor.error")
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(editing == nil ? Strings.Cron.Editor.createTitle : Strings.Cron.Editor.editTitle)
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.Cron.Editor.cancel) { dismiss() }
            .disabled(model.saving)
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(model.saving ? Strings.Cron.Editor.saving : Strings.Cron.Editor.save) { save() }
            .disabled(model.saving)
            .accessibilityIdentifier("hermie.cron.editor.save")
        }
      }
      .onAppear { model.beginEditing() }
    }
    #if os(macOS)
      .frame(minWidth: 480, minHeight: 560)
    #endif
    .interactiveDismissDisabled(model.saving)
  }

  private func save() {
    touched = true

    guard draft.input != nil else {
      return
    }

    Task {
      if await model.save(draft) {
        dismiss()
      }
    }
  }

  // MARK: What

  private var whatSection: some View {
    Section(Strings.Cron.Editor.what) {
      TextField(Strings.Cron.Editor.name, text: $draft.name, prompt: Text(Strings.Cron.Editor.namePlaceholder))
        .accessibilityIdentifier("hermie.cron.editor.name")

      if touched, draft.problems.nameRequired {
        problem(Strings.Cron.Editor.nameRequired)
      }

      TextField(
        Strings.Cron.Editor.prompt, text: $draft.prompt, prompt: Text(Strings.Cron.Editor.promptPlaceholder),
        axis: .vertical
      )
      .lineLimit(4...10)
      .accessibilityIdentifier("hermie.cron.editor.prompt")

      if touched, draft.problems.promptRequired {
        problem(Strings.Cron.Editor.promptRequired)
      }
    }
  }

  // MARK: Schedule

  private var scheduleSection: some View {
    Section {
      Picker(Strings.Cron.Schedule.mode, selection: $draft.schedule.mode) {
        Text(Strings.Cron.Schedule.Modes.interval).tag(CronScheduleMode.interval)
        Text(Strings.Cron.Schedule.Modes.daily).tag(CronScheduleMode.daily)
        Text(Strings.Cron.Schedule.Modes.cron).tag(CronScheduleMode.cron)
        Text(Strings.Cron.Schedule.Modes.once).tag(CronScheduleMode.once)
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("hermie.cron.editor.mode")

      switch draft.schedule.mode {
      case .interval: intervalFields
      case .daily: dailyFields
      case .cron: cronFields
      case .once: onceFields
      }

      switch CronSchedule.build(draft.schedule) {
      case .success(let schedule):
        Text(verbatim: Strings.Cron.Editor.preview(schedule: schedule))
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("hermie.cron.editor.preview")
      case .failure(let error):
        if touched {
          problem(CronText.error(error))
        }
      }
    } header: {
      Text(Strings.Cron.Editor.schedule)
    } footer: {
      Text(Strings.Cron.Editor.nextRunHint)
    }
  }

  private var intervalFields: some View {
    HStack {
      Text(Strings.Cron.Schedule.everyLabel)

      TextField("", text: $draft.schedule.intervalValue)
        .multilineTextAlignment(.trailing)
        #if os(iOS)
          .keyboardType(.numberPad)
        #endif
        .frame(maxWidth: 80)
        .accessibilityLabel(Strings.Cron.Schedule.everyLabel)
        .accessibilityIdentifier("hermie.cron.editor.intervalValue")

      Picker(Strings.Cron.Schedule.everyLabel, selection: $draft.schedule.intervalUnit) {
        Text(Strings.Cron.Schedule.Units.minutes).tag(CronIntervalUnit.minutes)
        Text(Strings.Cron.Schedule.Units.hours).tag(CronIntervalUnit.hours)
        Text(Strings.Cron.Schedule.Units.days).tag(CronIntervalUnit.days)
      }
      .labelsHidden()
    }
  }

  private var dailyFields: some View {
    Group {
      DatePicker(Strings.Cron.Schedule.time, selection: timeBinding, displayedComponents: .hourAndMinute)
        .accessibilityIdentifier("hermie.cron.editor.time")

      VStack(alignment: .leading, spacing: 8) {
        Text(Strings.Cron.Schedule.days)
          .font(.subheadline)

        weekdayRow

        Text(Strings.Cron.Schedule.daysHint)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }

  /// The time of day as the date picker holds it, written back as `HH:MM`.
  private var timeBinding: Binding<Date> {
    Binding(
      get: {
        let clock = CronSchedule.parseClock(draft.schedule.time) ?? (hour: 9, minute: 0)

        return Calendar.current.date(bySettingHour: clock.hour, minute: clock.minute, second: 0, of: .now) ?? .now
      },
      set: { date in
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        draft.schedule.time = String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0)
      }
    )
  }

  private var weekdayRow: some View {
    HStack(spacing: 6) {
      ForEach(0..<7, id: \.self) { day in
        let selected = draft.schedule.weekdays.contains(day)

        Button {
          if selected {
            draft.schedule.weekdays.removeAll { $0 == day }
          } else {
            draft.schedule.weekdays.append(day)
          }
        } label: {
          Text(Strings.Cron.Schedule.weekdayInitials[day])
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 36)
            .foregroundStyle(selected ? Color.white : Color.primary)
            .background(selected ? Color.accentColor : Color.secondary.opacity(0.15), in: .capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Strings.Cron.Schedule.weekdayNames[day])
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("hermie.cron.editor.weekday.\(day)")
      }
    }
  }

  private var cronFields: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField(
        Strings.Cron.Schedule.cronExpression, text: $draft.schedule.cronExpression,
        prompt: Text(Strings.Cron.Schedule.cronPlaceholder)
      )
      .font(.body.monospaced())
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
      .accessibilityIdentifier("hermie.cron.editor.cron")

      Text(Strings.Cron.Schedule.cronHint)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }

  private var onceFields: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField(
        Strings.Cron.Schedule.once, text: $draft.schedule.onceValue,
        prompt: Text(Strings.Cron.Schedule.oncePlaceholder)
      )
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
      .accessibilityIdentifier("hermie.cron.editor.once")

      Text(Strings.Cron.Schedule.onceHint)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }

  // MARK: Where

  private var whereSection: some View {
    Section(Strings.Cron.Editor.where) {
      Picker(Strings.Cron.Editor.deliver, selection: $draft.deliver) {
        ForEach(deliveryOptions) { target in
          Text(verbatim: target.name).tag(target.id)
        }
      }
      .accessibilityIdentifier("hermie.cron.editor.deliver")

      profileRow
    }
  }

  /// `local` is implicit on every gateway; a cron already delivering somewhere the gateway no longer
  /// lists keeps its target as an option, so opening the editor does not silently change it.
  private var deliveryOptions: [CronDeliveryTarget] {
    var options = model.targets

    if !options.contains(where: { $0.id == draft.deliver }) {
      options.append(CronDeliveryTarget(id: draft.deliver, name: draft.deliver))
    }

    return options
  }

  /// Which profile's cron store a NEW cron is written to. Create-only, and the hint says why rather than
  /// the control being missing without explanation: the profile is not a field on the cron, it is the
  /// scope the gateway ran the create under, so there is nothing an edit could change. A gateway that
  /// serves one bot gets no picker.
  @ViewBuilder private var profileRow: some View {
    let names = session.chatList.names

    if names.count > 1 {
      if editing != nil {
        LabeledContent(Strings.Cron.Editor.profile) {
          Text(verbatim: draft.profile.isEmpty ? Strings.Cron.Editor.profileDefault : draft.profile)
        }

        Text(Strings.Cron.Editor.profileLocked)
          .font(.footnote)
          .foregroundStyle(.secondary)
      } else {
        Picker(Strings.Cron.Editor.profile, selection: $draft.profile) {
          Text(Strings.Cron.Editor.profileDefault).tag("")

          ForEach(names, id: \.self) { name in
            Text(verbatim: session.chatList.rows[name]?.bot.displayName ?? name).tag(name)
          }
        }
        .accessibilityIdentifier("hermie.cron.editor.profile")

        Text(Strings.Cron.Editor.profileHint)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func problem(_ text: String) -> some View {
    Text(verbatim: text)
      .font(.footnote)
      .foregroundStyle(.red)
  }
}
