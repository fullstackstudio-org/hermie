import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for an `input.form`: one control per field, by its kind, with the gateway's own checks
/// run before the answer goes out and its refusals shown next to the field they name.
///
/// Everything the agent says (title, summary, labels, hints, option labels) is plain text,
/// cleaned and bounded, never Markdown. What is typed lives in `InteractiveFormModel`, the sheet's
/// own state: it goes only into the answer and is wiped when the answer went out, Skip was
/// answered, or the sheet goes. For 400 ms after the sheet comes up nothing can be sent.
struct FormSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt

  @State private var form: InteractiveFormModel
  @State private var armed = false
  @State private var scrollTarget: String?

  init(model: InteractiveModel, prompt: InteractivePrompt, params: InputFormParams) {
    self.model = model
    self.prompt = prompt
    _form = State(initialValue: InteractiveFormModel(params: params))
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "list.bullet.rectangle",
      title: NativeStrings.Interactive.titleForm(model.botName),
      busy: model.isSending
    ) {
      ScrollViewReader { proxy in
        VStack(alignment: .leading, spacing: 20) {
          ForEach(form.fields.compactMap(\.id), id: \.self) { id in
            FormFieldRow(form: form, id: id)
              .id(id)
          }

          if form.attempted, !form.isComplete {
            Label(NativeStrings.Interactive.Form.needAttention, systemImage: "exclamationmark.circle")
              .font(.callout)
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("form.needAttention")
          }

          if let reason = form.generalRefusal {
            Label(NativeStrings.Interactive.refusal(reason), systemImage: "exclamationmark.triangle")
              .font(.callout)
              .foregroundStyle(.red)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .disabled(model.isSending)
        .onChange(of: scrollTarget) { _, id in
          if let id {
            withAnimation { proxy.scrollTo(id, anchor: .top) }
            scrollTarget = nil
          }
        }
      }
    } actions: {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) {
          LaterButton(model: model)
          if prompt.offersSkip {
            SkipButton(model: model, armed: armed, onSkipped: { form.wipe() })
          }
          sendButton
        }
        VStack(spacing: 10) {
          sendButton
          if prompt.offersSkip {
            SkipButton(model: model, armed: armed, onSkipped: { form.wipe() })
          }
          LaterButton(model: model)
        }
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    .onChange(of: model.refusal) { _, reason in
      form.noteRefusal(reason)

      if let reason, let refusal = FormRefusal(reason: reason) {
        scrollTarget = refusal.fieldID
      }
    }
    .onDisappear {
      form.wipe()
    }
  }

  private var sendButton: some View {
    Button {
      send()
    } label: {
      Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.send)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || model.isSending)
    .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "interactive.send")
  }

  /// Send what is in the fields: checked first, and the problems shown when there are any.
  private func send() {
    guard armed, !model.isSending else {
      return
    }

    guard let values = form.submit() else {
      scrollTarget = form.firstProblemID
      AccessibilityNotification.Announcement(NativeStrings.Interactive.Form.needAttention).post()
      return
    }

    Task {
      if await model.answer(.form(values)) {
        form.wipe()
      }
    }
  }
}

// MARK: - One field

/// A field: its label (with the required mark), its control, its hint and bounds, and the problem
/// with it.
struct FormFieldRow: View {
  let form: InteractiveFormModel
  let id: String

  var body: some View {
    if let field = form.field(id) {
      let label = InteractivePrompt.line(field.label, limit: InteractivePrompt.labelLimit)
      let problem = form.shownProblem(of: id)

      VStack(alignment: .leading, spacing: 6) {
        if !isToggle(field) {
          HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(verbatim: label)
              .font(.subheadline.weight(.semibold))
              .fixedSize(horizontal: false, vertical: true)
            if field.isRequired {
              Text(verbatim: "*")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.red)
            }
          }
          .accessibilityHidden(true)
        }

        control(field, label: label)

        if let hint = field.hint, !hint.isEmpty {
          Text(verbatim: InteractivePrompt.text(hint, limit: InteractivePrompt.labelLimit))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if let bounds = FormFieldText.bounds(field) {
          Text(verbatim: bounds)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if let problem {
          Label(
            FormFieldText.problem(problem, field: field, clock: form.clock(for: id)),
            systemImage: "exclamationmark.circle"
          )
          .font(.footnote)
          .foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("form.problem.\(id)")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .contain)
    }
  }

  private func isToggle(_ field: FormField) -> Bool {
    if case .toggle = field { true } else { false }
  }

  /// What VoiceOver says for the field: its label, and that it is required.
  private func spoken(_ field: FormField, _ label: String) -> String {
    field.isRequired ? "\(label), \(NativeStrings.Interactive.Form.required)" : label
  }

  @ViewBuilder private func control(_ field: FormField, label: String) -> some View {
    let spoken = spoken(field, label)

    switch field {
    case .text(let field):
      FormTextControl(form: form, id: id, field: field, spoken: spoken)
    case .number(let field):
      FormNumberControl(form: form, id: id, field: field, spoken: spoken)
    case .amount(let field):
      FormAmountControl(form: form, id: id, field: field, spoken: spoken)
    case .date(let field):
      FormDateControl(form: form, id: id, field: field, spoken: spoken)
    case .time(let field):
      FormTimeControl(form: form, id: id, field: field, spoken: spoken)
    case .datetime(let field):
      FormDateTimeControl(form: form, id: id, field: field, spoken: spoken)
    case .daterange(let field):
      FormDateRangeControl(form: form, id: id, field: field, spoken: spoken)
    case .choice(let field):
      if field.isMultiple {
        FormChoicesControl(form: form, id: id, field: field, spoken: spoken)
      } else {
        FormChoiceControl(form: form, id: id, field: field, spoken: spoken)
      }
    case .toggle:
      FormToggleControl(form: form, id: id, label: label, required: field.isRequired, spoken: spoken)
    case .unknown:
      EmptyView()
    }
  }
}

// MARK: - Text, number, amount

struct FormTextControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: TextFormField
  let spoken: String

  var body: some View {
    let binding = Binding<String>(
      get: {
        if case .text(let text)? = form.input(id) { text } else { "" }
      },
      set: { form.set(.text($0), for: id) }
    )

    VStack(alignment: .leading, spacing: 4) {
      Group {
        if field.isMultiline {
          TextField("", text: binding, axis: .vertical)
            .lineLimit(3...10)
        } else {
          TextField("", text: binding)
        }
      }
      .textFieldStyle(.roundedBorder)
      .modifier(TextKeyboard(input: field.input))
      .accessibilityLabel(spoken)
      .accessibilityIdentifier("form.field.\(id)")

      if let limit = field.maxLength {
        let count: Int = {
          if case .text(let text)? = form.input(id) { text.unicodeScalars.count } else { 0 }
        }()
        Text(NativeStrings.Interactive.Form.characters(count, of: limit))
          .font(.caption.monospacedDigit())
          .foregroundStyle(count > limit ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
          .accessibilityHidden(true)
      }
    }
  }
}

/// The keyboard for a text field's `input` hint. A hint, not a check.
private struct TextKeyboard: ViewModifier {
  let input: TextInputKind?

  func body(content: Content) -> some View {
    #if os(iOS)
      switch input {
      case .email?:
        content.keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      case .phone?:
        content.keyboardType(.phonePad).textContentType(.telephoneNumber).autocorrectionDisabled()
      case .url?:
        content.keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
      default:
        content
      }
    #else
      content
    #endif
  }
}

struct FormNumberControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: NumberFormField
  let spoken: String

  var body: some View {
    let binding = Binding<String>(
      get: {
        if case .number(let text)? = form.input(id) { text } else { "" }
      },
      set: { form.set(.number($0), for: id) }
    )

    TextField("", text: binding)
      .textFieldStyle(.roundedBorder)
      .modifier(DecimalKeyboard(whole: field.isInteger, signed: (field.min ?? 0) < 0))
      .accessibilityLabel(spoken)
      .accessibilityIdentifier("form.field.\(id)")
  }
}

struct FormAmountControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: AmountFormField
  let spoken: String

  var body: some View {
    let binding = Binding<String>(
      get: {
        if case .amount(let text)? = form.input(id) { text } else { "" }
      },
      set: { form.set(.amount($0), for: id) }
    )
    let currency = (field.currency ?? "").uppercased()
    let decimals = FormAmount.minorUnit(of: field.currency)

    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(verbatim: currency)
          .font(.body.monospaced())
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
        TextField("", text: binding)
          .textFieldStyle(.roundedBorder)
          .modifier(DecimalKeyboard(whole: decimals == 0, signed: (field.min.flatMap(FormAmount.decimal) ?? 0) < 0))
          .accessibilityLabel("\(spoken), \(Self.currencyName(currency))")
          .accessibilityIdentifier("form.field.\(id)")
      }

      Text(decimals == 0 ? NativeStrings.Interactive.Form.wholeAmounts(currency) : NativeStrings.Interactive.Form.decimals(currency, decimals))
        .font(.footnote)
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
    }
  }

  /// "Euro" for EUR, in the person's language; the code when the system has no name.
  static func currencyName(_ code: String) -> String {
    Locale.current.localizedString(forCurrencyCode: code) ?? code
  }
}

/// The keypad for a number: digits only for a whole number, with the point (and a minus when the
/// field allows negatives) otherwise.
private struct DecimalKeyboard: ViewModifier {
  let whole: Bool
  let signed: Bool

  func body(content: Content) -> some View {
    #if os(iOS)
      if signed {
        content.keyboardType(.numbersAndPunctuation)
      } else {
        content.keyboardType(whole ? .numberPad : .decimalPad)
      }
    #else
      content
    #endif
  }
}

// MARK: - Dates and times

/// An empty date or time: one button to give it a value. Once it has one, the picker and Clear.
private struct FormChooseRow<Picker: View>: View {
  let isSet: Bool
  let chooseTitle: String
  let canClear: Bool
  let choose: () -> Void
  let clear: () -> Void
  @ViewBuilder var picker: Picker

  var body: some View {
    if isSet {
      HStack(spacing: 12) {
        picker
        Spacer(minLength: 0)
        if canClear {
          Button(NativeStrings.Interactive.Form.clear, action: clear)
            .buttonStyle(.borderless)
        }
      }
    } else {
      Button(chooseTitle, action: choose)
        .buttonStyle(.bordered)
    }
  }
}

/// The zone a date, time or datetime is in, when the field names one: said once under the control.
private struct FormZoneNote: View {
  let clock: FormClock
  let named: String?

  var body: some View {
    if let named, !named.isEmpty {
      Text(NativeStrings.Interactive.Form.inZone(clock.zone.localizedName(for: .standard, locale: .current) ?? clock.zone.identifier))
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

private enum PickerBounds {
  static let earliest = Date(timeIntervalSince1970: -2_208_988_800)
  static let latest = Date(timeIntervalSince1970: 7_258_118_400)

  /// The range a picker allows; open ends are far away, and bounds that contradict each other are
  /// not applied (the gateway never sends them).
  static func range(_ min: Date?, _ max: Date?) -> ClosedRange<Date> {
    let low = min ?? earliest
    let high = max ?? latest
    return low <= high ? low...high : earliest...latest
  }
}

private extension View {
  /// A picker in the field's zone, on the person's own calendar.
  func inZone(_ zone: TimeZone) -> some View {
    var calendar = Calendar.current
    calendar.timeZone = zone
    return environment(\.timeZone, zone).environment(\.calendar, calendar)
  }
}

struct FormDateControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: DateFormField
  let spoken: String

  var body: some View {
    let clock = form.clock(for: id)
    let chosen: String? = {
      if case .date(let day)? = form.input(id) { day } else { nil }
    }()

    VStack(alignment: .leading, spacing: 4) {
      FormChooseRow(
        isSet: chosen != nil,
        chooseTitle: NativeStrings.Interactive.Form.chooseDate,
        canClear: !(form.field(id)?.isRequired ?? false),
        choose: { form.choose(id) },
        clear: { form.clear(id) }
      ) {
        DatePicker(
          spoken,
          selection: Binding(
            get: { chosen.flatMap(clock.date(day:)) ?? Date() },
            set: { form.set(.date(clock.day(of: $0)), for: id) }),
          in: PickerBounds.range(field.min.flatMap(clock.date(day:)), field.max.flatMap(clock.date(day:))),
          displayedComponents: .date
        )
        .labelsHidden()
        .inZone(clock.zone)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("form.field.\(id)")
      }
      FormZoneNote(clock: clock, named: field.tz)
    }
  }
}

struct FormTimeControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: TimeFormField
  let spoken: String

  var body: some View {
    let clock = form.clock(for: id)
    let chosen: String? = {
      if case .time(let time)? = form.input(id) { time } else { nil }
    }()

    VStack(alignment: .leading, spacing: 4) {
      FormChooseRow(
        isSet: chosen != nil,
        chooseTitle: NativeStrings.Interactive.Form.chooseTime,
        canClear: !(form.field(id)?.isRequired ?? false),
        choose: { form.choose(id) },
        clear: { form.clear(id) }
      ) {
        DatePicker(
          spoken,
          selection: Binding(
            get: { chosen.flatMap { clock.date(time: $0, on: Date()) } ?? Date() },
            set: { form.set(.time(clock.time(of: $0)), for: id) }),
          displayedComponents: .hourAndMinute
        )
        .labelsHidden()
        .inZone(clock.zone)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("form.field.\(id)")
      }
      FormZoneNote(clock: clock, named: field.tz)
    }
  }
}

struct FormDateTimeControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: DateTimeFormField
  let spoken: String

  var body: some View {
    let clock = form.clock(for: id)
    let chosen: Date? = {
      if case .datetime(let instant)? = form.input(id) { instant } else { nil }
    }()

    VStack(alignment: .leading, spacing: 4) {
      FormChooseRow(
        isSet: chosen != nil,
        chooseTitle: NativeStrings.Interactive.Form.chooseDateTime,
        canClear: !(form.field(id)?.isRequired ?? false),
        choose: { form.choose(id) },
        clear: { form.clear(id) }
      ) {
        DatePicker(
          spoken,
          selection: Binding(
            get: { chosen ?? Date() },
            set: { form.set(.datetime($0), for: id) }),
          in: PickerBounds.range(field.min.flatMap(FormInstant.parse), field.max.flatMap(FormInstant.parse)),
          displayedComponents: [.date, .hourAndMinute]
        )
        .labelsHidden()
        .inZone(clock.zone)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("form.field.\(id)")
      }
      // The answer is in a zone: the field's, or this device's. Said always, since a time with no
      // zone is half an answer.
      Text(
        NativeStrings.Interactive.Form.inZone(
          clock.zone.localizedName(for: .standard, locale: .current) ?? clock.zone.identifier)
      )
      .font(.footnote)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct FormDateRangeControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: DateRangeFormField
  let spoken: String

  var body: some View {
    let clock = form.clock(for: id)
    let ends: (start: String?, end: String?) = {
      if case .range(let start, let end)? = form.input(id) { (start, end) } else { (nil, nil) }
    }()
    let bounds = PickerBounds.range(field.min.flatMap(clock.date(day:)), field.max.flatMap(clock.date(day:)))

    VStack(alignment: .leading, spacing: 8) {
      FormChooseRow(
        isSet: ends.start != nil || ends.end != nil,
        chooseTitle: NativeStrings.Interactive.Form.chooseRange,
        canClear: !(form.field(id)?.isRequired ?? false),
        choose: { form.choose(id) },
        clear: { form.clear(id) }
      ) {
        VStack(alignment: .leading, spacing: 8) {
          DatePicker(
            NativeStrings.Interactive.Form.from,
            selection: Binding(
              get: { ends.start.flatMap(clock.date(day:)) ?? Date() },
              set: { picked in
                let start = clock.day(of: picked)
                let end = (ends.end ?? start) < start ? start : (ends.end ?? start)
                form.set(.range(start: start, end: end), for: id)
              }),
            in: bounds,
            displayedComponents: .date
          )
          .inZone(clock.zone)
          .accessibilityLabel("\(spoken), \(NativeStrings.Interactive.Form.from)")
          .accessibilityIdentifier("form.field.\(id).start")

          DatePicker(
            NativeStrings.Interactive.Form.to,
            selection: Binding(
              get: { ends.end.flatMap(clock.date(day:)) ?? Date() },
              set: { picked in
                let end = clock.day(of: picked)
                let start = (ends.start ?? end) > end ? end : (ends.start ?? end)
                form.set(.range(start: start, end: end), for: id)
              }),
            in: bounds,
            displayedComponents: .date
          )
          .inZone(clock.zone)
          .accessibilityLabel("\(spoken), \(NativeStrings.Interactive.Form.to)")
          .accessibilityIdentifier("form.field.\(id).end")
        }
      }
      FormZoneNote(clock: clock, named: field.tz)
    }
  }
}

// MARK: - Choices and toggles

struct FormChoiceControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: ChoiceFormField
  let spoken: String

  var body: some View {
    let binding = Binding<String?>(
      get: {
        if case .choice(let value)? = form.input(id) { value } else { nil }
      },
      set: { form.set(.choice($0), for: id) }
    )

    Picker(spoken, selection: binding) {
      Text(field.isRequired ? NativeStrings.Interactive.Form.choose : NativeStrings.Interactive.Form.none)
        .tag(String?.none)
      ForEach(Array((field.options ?? []).enumerated()), id: \.offset) { _, option in
        Text(verbatim: InteractivePrompt.line(option.label ?? option.value, limit: InteractivePrompt.labelLimit))
          .tag(Optional(option.value ?? ""))
      }
    }
    .pickerStyle(.menu)
    .labelsHidden()
    .accessibilityLabel(spoken)
    .accessibilityIdentifier("form.field.\(id)")
  }
}

struct FormChoicesControl: View {
  let form: InteractiveFormModel
  let id: String
  let field: ChoiceFormField
  let spoken: String

  var body: some View {
    let chosen: [String] = {
      if case .choices(let values)? = form.input(id) { values } else { [] }
    }()
    let full = field.maxSelected.map { chosen.count >= $0 } ?? false

    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array((field.options ?? []).enumerated()), id: \.offset) { _, option in
        let value = option.value ?? ""
        let selected = chosen.contains(value)

        Button {
          form.toggle(option: value, in: id)
        } label: {
          HStack(spacing: 10) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(selected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
              .accessibilityHidden(true)
            Text(verbatim: InteractivePrompt.line(option.label ?? value, limit: InteractivePrompt.labelLimit))
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .contentShape(.rect)
          .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .opacity(full && !selected ? 0.5 : 1)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(InteractivePrompt.line(option.label ?? value, limit: InteractivePrompt.labelLimit))
        .accessibilityHint(spoken)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("form.field.\(id)")
  }
}

struct FormToggleControl: View {
  let form: InteractiveFormModel
  let id: String
  let label: String
  let required: Bool
  let spoken: String

  var body: some View {
    let binding = Binding<Bool>(
      get: {
        if case .toggle(let on)? = form.input(id) { on } else { false }
      },
      set: { form.set(.toggle($0), for: id) }
    )

    Toggle(isOn: binding) {
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(verbatim: label)
          .font(.subheadline.weight(.semibold))
          .fixedSize(horizontal: false, vertical: true)
        if required {
          Text(verbatim: "*")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.red)
        }
      }
    }
    .accessibilityLabel(spoken)
    .accessibilityIdentifier("form.field.\(id)")
  }
}

// MARK: - Words for a field

/// The app's words about a field: its bounds, and what is wrong with it.
enum FormFieldText {
  /// "Between 1 and 12", for the fields that have numeric bounds; nil for the rest.
  static func bounds(_ field: FormField) -> String? {
    switch field {
    case .number(let field):
      return range(field.min.map(FormDecimalText.text), field.max.map(FormDecimalText.text))
    case .amount(let field):
      return range(field.min, field.max)
    default:
      return nil
    }
  }

  private static func range(_ min: String?, _ max: String?) -> String? {
    switch (min, max) {
    case (let min?, let max?): NativeStrings.Interactive.Form.between(min, max)
    case (let min?, nil): NativeStrings.Interactive.Form.atLeast(min)
    case (nil, let max?): NativeStrings.Interactive.Form.atMost(max)
    case (nil, nil): nil
    }
  }

  /// A calendar day as the person reads it, in the field's zone.
  static func day(_ text: String, clock: FormClock) -> String {
    clock.date(day: text)?.formatted(Date.FormatStyle(date: .long, time: .omitted, timeZone: clock.zone)) ?? text
  }

  /// An instant as the person reads it, in the field's zone.
  static func instant(_ text: String, clock: FormClock) -> String {
    FormInstant.parse(text)?.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: clock.zone))
      ?? text
  }

  /// What is wrong with a field, in a sentence. Never the gateway's reason string.
  static func problem(_ problem: FormProblem, field: FormField, clock: FormClock) -> String {
    typealias Words = NativeStrings.Interactive.Form

    switch problem {
    case .missing:
      return Words.problemMissing
    case .format, .type:
      return Words.problemFormat
    case .tooLong:
      if case .text(let text) = field {
        return Words.problemTooLong(text.effectiveMaxLength)
      }

      return Words.problemFormat
    case .belowMin:
      switch field {
      case .number(let field): return field.min.map { Words.problemBelowMin(FormDecimalText.text($0)) } ?? Words.problemOther
      case .amount(let field): return field.min.map { Words.problemBelowMin("\($0) \(field.currency ?? "")") } ?? Words.problemOther
      case .date(let field): return field.min.map { Words.problemBefore(day($0, clock: clock)) } ?? Words.problemOther
      case .time(let field): return field.min.map(Words.problemBefore) ?? Words.problemOther
      case .datetime(let field): return field.min.map { Words.problemBefore(instant($0, clock: clock)) } ?? Words.problemOther
      case .daterange(let field): return field.min.map { Words.problemBefore(day($0, clock: clock)) } ?? Words.problemOther
      default: return Words.problemOther
      }
    case .aboveMax:
      switch field {
      case .number(let field): return field.max.map { Words.problemAboveMax(FormDecimalText.text($0)) } ?? Words.problemOther
      case .amount(let field): return field.max.map { Words.problemAboveMax("\($0) \(field.currency ?? "")") } ?? Words.problemOther
      case .date(let field): return field.max.map { Words.problemAfter(day($0, clock: clock)) } ?? Words.problemOther
      case .time(let field): return field.max.map(Words.problemAfter) ?? Words.problemOther
      case .datetime(let field): return field.max.map { Words.problemAfter(instant($0, clock: clock)) } ?? Words.problemOther
      case .daterange(let field): return field.max.map { Words.problemAfter(day($0, clock: clock)) } ?? Words.problemOther
      default: return Words.problemOther
      }
    case .notInteger:
      return Words.problemNotInteger
    case .step:
      if case .number(let field) = field, let step = field.step {
        return Words.problemStep(FormDecimalText.text(step), FormDecimalText.text(field.min ?? 0))
      }

      return Words.problemOther
    case .order:
      return Words.problemOrder
    case .tooFew:
      if case .choice(let field) = field, let least = field.minSelected {
        return Words.problemTooFew(least)
      }

      return Words.problemOther
    case .tooMany:
      if case .choice(let field) = field, let most = field.maxSelected {
        return Words.problemTooMany(most)
      }

      return Words.problemOther
    case .zone, .offset, .duplicate, .notAnOption, .other:
      return Words.problemOther
    }
  }
}
