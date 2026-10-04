import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for a `device.contact` (`contract/requests/README.md` §10): the person picks ONE contact
/// with the system's own picker, ticks which of the requested fields to share, sees exactly what
/// would be sent, and shares it. Only ticked fields go; a key nobody asked for never does.
///
/// The contact is held only while the sheet is up. The picker runs in its own process and hands over
/// the chosen contact alone, so the app asks for no access to the address book.
struct ContactSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt

  @State private var contact: InteractiveContactModel
  @State private var armed = false
  @State private var showPicker = false
  #if os(macOS)
    @State private var anchor = ContactPickerAnchor()
    @State private var macPicker = MacContactPicker()
  #endif

  init(model: InteractiveModel, prompt: InteractivePrompt, request: DeviceContactRequest) {
    self.model = model
    self.prompt = prompt
    _contact = State(initialValue: InteractiveContactModel(request: request))
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "person.crop.circle",
      title: NativeStrings.Interactive.titleContact(model.botName),
      busy: model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        if contact.hasChosen {
          chosen
          fieldBoxes
          preview
        } else {
          Text(NativeStrings.Interactive.Contact.pickerNote)
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("contact.pickerNote")
        }
      }
      .disabled(model.isSending)
    } actions: {
      VStack(spacing: 6) {
        InteractiveButtonRow {
          LaterButton(model: model)

          if prompt.offersSkip {
            SkipButton(model: model, armed: armed, onSkipped: { contact.wipe() })
          }

          mainButton
        }
        DeclineButton(model: model, armed: armed, onDeclined: { contact.wipe() })
      }
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    #if os(iOS)
      // A sheet, never a full-screen cover: a cover fires this sheet's `onDisappear`, which would throw
      // away the contact already chosen.
      .sheet(isPresented: $showPicker) {
        ContactPicker(
          requested: contact.request.fields,
          onPick: { snapshot in
            contact.choose(snapshot)
            showPicker = false
          },
          onCancel: { showPicker = false }
        )
        .ignoresSafeArea()
      }
      .onChange(of: showPicker) { _, showing in
        // The system's picker is up: an approval waits rather than cutting it off.
        model.setWorking(showing)
      }
    #endif
    .onChange(of: contact.hasChosen) { _, chosen in
      if chosen {
        let name = InteractivePrompt.line(contact.snapshot?.name, limit: InteractivePrompt.labelLimit)
        AccessibilityNotification.Announcement(
          NativeStrings.Interactive.Contact.chosen(name.isEmpty ? NativeStrings.Interactive.Contact.unnamed : name)
        ).post()
      }
    }
    .onDisappear {
      contact.wipe()
      model.setWorking(false)
    }
  }

  // MARK: Pieces

  /// Who was chosen, and the way to choose another.
  private var chosen: some View {
    VStack(alignment: .leading, spacing: 8) {
      let name = InteractivePrompt.line(contact.snapshot?.name, limit: InteractivePrompt.labelLimit)
      Label {
        Text(verbatim: NativeStrings.Interactive.Contact.chosen(name.isEmpty ? NativeStrings.Interactive.Contact.unnamed : name))
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "person.crop.circle.badge.checkmark")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
      .accessibilityIdentifier("contact.chosen")

      pickerButton(title: NativeStrings.Interactive.Contact.chooseAnother, prominent: false)
    }
  }

  /// One box per requested field the person can untick.
  private var fieldBoxes: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.Interactive.Contact.fieldsHeading)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)

      ForEach(contact.request.fields, id: \.self) { field in
        let available = contact.isAvailable(field)

        VStack(alignment: .leading, spacing: 2) {
          Toggle(
            NativeStrings.Interactive.Contact.field(field),
            isOn: Binding(
              get: { contact.isTicked(field) },
              set: { contact.set(field, ticked: $0) }
            )
          )
          .disabled(!available)
          .accessibilityIdentifier("contact.field.\(field.rawValue)")

          if !available {
            Text(NativeStrings.Interactive.Contact.notOnContact)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
  }

  /// Exactly what the answer would hold, as it would be sent.
  private var preview: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(NativeStrings.Interactive.Contact.previewHeading)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)

      if let shared = contact.shared, !shared.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Self.rows(of: shared), id: \.field) { row in
            VStack(alignment: .leading, spacing: 2) {
              Text(NativeStrings.Interactive.Contact.field(row.field))
                .font(.caption)
                .foregroundStyle(.secondary)
              ForEach(Array(row.values.enumerated()), id: \.offset) { _, value in
                Text(verbatim: value)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .accessibilityElement(children: .combine)
          }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: .rect(cornerRadius: 12))
        .accessibilityIdentifier("contact.preview")
      } else {
        Text(NativeStrings.Interactive.Contact.nothingTicked)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("contact.nothingTicked")
      }
    }
  }

  /// One field of the preview with the values that would be sent for it.
  struct Row: Equatable {
    let field: ContactField
    let values: [String]
  }

  /// The preview's rows, in the contract's order: what is in `shared`, and nothing else.
  static func rows(of shared: SharedContact) -> [Row] {
    var rows: [Row] = []

    for field in ContactField.knownCases {
      let values: [String] =
        switch field {
        case .name: shared.name.map { [$0] } ?? []
        case .phones: shared.phones
        case .emails: shared.emails
        case .postal: shared.postal
        case .birthday: shared.birthday.map { [$0] } ?? []
        case .organization: shared.organization.map { [$0] } ?? []
        case .unknown: []
        }

      if !values.isEmpty {
        rows.append(Row(field: field, values: values))
      }
    }

    return rows
  }

  /// Opens the system's contact picker.
  @ViewBuilder private func pickerButton(title: String, prominent: Bool) -> some View {
    let button = Button {
      openPicker()
    } label: {
      Label(title, systemImage: "person.crop.circle.badge.plus")
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .controlSize(.large)
    .disabled(!armed || model.isSending)
    .accessibilityIdentifier("contact.choose")
    #if os(macOS)
      .background(ContactPickerAnchorView(anchor: anchor))
    #endif

    if prominent {
      button.buttonStyle(.borderedProminent)
    } else {
      button.buttonStyle(.bordered)
    }
  }

  private func openPicker() {
    #if os(iOS)
      showPicker = true
    #else
      guard let view = anchor.view else {
        return
      }

      model.setWorking(true)
      let model = self.model
      macPicker.show(
        from: view,
        requested: contact.request.fields,
        onPick: { snapshot in contact.choose(snapshot) },
        onClose: { model.setWorking(false) }
      )
    #endif
  }

  @ViewBuilder private var mainButton: some View {
    if contact.hasChosen {
      Button {
        share()
      } label: {
        Text(model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.Contact.share)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending || !contact.canShare)
      .accessibilityHint(contact.canShare ? "" : NativeStrings.Interactive.Contact.nothingTicked)
      .accessibilityIdentifier(model.hasFailed ? "interactive.retry" : "contact.share")
    } else {
      Button {
        openPicker()
      } label: {
        Text(NativeStrings.Interactive.Contact.choose)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending)
      #if os(macOS)
        .background(ContactPickerAnchorView(anchor: anchor))
      #endif
      .accessibilityIdentifier("contact.choose")
    }
  }

  /// Share what is ticked, as previewed.
  private func share() {
    guard armed, !model.isSending, let answer = contact.answer else {
      return
    }

    let contact = self.contact
    let model = self.model

    Task {
      if await model.answer(answer) {
        contact.wipe()
      }
    }
  }
}
