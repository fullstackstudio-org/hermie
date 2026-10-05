import HermieCore
import SwiftUI

/**
 Add an item to a bot's vault: its kind, a label, the site, a login's identifier, and the secret fields.

 The value-handling rules are the secure prompt sheet's (`SecureInputSheetView`):

 - The secret lives in this sheet's form (`VaultAddForm`) and nowhere else: never stored, logged, copied or put
   in a draft. Save moves it out of the form before it is sent, so a refused add asks for it again.
 - The fields are masked where they hold a password, a key or card details, with no corrections, no capitals,
   nothing the keyboard learns from, and marked privacy-sensitive (`PlainEntry`). Only the login's password
   carries a content type (`.password`, with `.username` on the identifier), so the system's password manager
   can fill a login; nothing else is offered to it.
 - When the app is not in front, the sheet is covered (`PrivacyCoverView`), so the app switcher's snapshot and
   a shared screen never show it; when it goes to the background the secret fields are emptied; when the sheet
   goes, everything is.
 */
struct VaultAddSheet: View {
  let model: VaultModel
  let botName: String

  @State private var form = VaultAddForm()
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase

  var body: some View {
    NavigationStack {
      VaultAddFormView(model: model, form: form, botName: botName, save: save)
        .navigationTitle(NativeStrings.Vault.addTitle(botName))
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(Strings.App.Common.cancel) {
              form.clear()
              dismiss()
            }
            .disabled(model.adding)
            .accessibilityIdentifier("hermie.vault.add.cancel")
          }

          ToolbarItem(placement: .confirmationAction) {
            Button(NativeStrings.Vault.save, action: save)
              .disabled(!form.isComplete || model.adding)
              .accessibilityIdentifier("hermie.vault.add.save")
          }
        }
    }
    .vaultSecretRules(phase: phase, leftForeground: form.leftForeground, gone: form.clear)
    .interactiveDismissDisabled(model.adding)
    .onAppear { model.dismissAddFailure() }
    #if os(macOS)
      .frame(minWidth: 460, minHeight: 520)
    #endif
  }

  private func save() {
    guard form.isComplete, !model.adding else {
      return
    }

    Task {
      if await form.submit(to: model) {
        dismiss()
      }
    }
  }
}

/// The Add sheet's form, apart from its chrome, so a test can host it with a scene phase of its own.
struct VaultAddFormView: View {
  let model: VaultModel
  @Bindable var form: VaultAddForm
  let botName: String
  let save: () -> Void

  @FocusState private var focus: String?

  var body: some View {
    Form {
      Section {
        Picker(NativeStrings.Vault.kind, selection: $form.kind) {
          ForEach(VaultKind.allCases, id: \.self) { kind in
            Text(NativeStrings.Vault.kindName(kind)).tag(kind)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("hermie.vault.add.kind")

        TextField(NativeStrings.Vault.label, text: $form.label, prompt: Text(NativeStrings.Vault.labelPrompt))
          .accessibilityIdentifier("hermie.vault.add.label")

        TextField(NativeStrings.Vault.site, text: $form.site, prompt: Text(verbatim: "https://example.com"))
          .textContentType(.URL)
          #if os(iOS)
            .keyboardType(.URL)
          #endif
          .modifier(PlainEntry())
          .accessibilityIdentifier("hermie.vault.add.site")
      }

      if form.kind == .login {
        Section {
          Picker(NativeStrings.Vault.identifierType, selection: $form.identifierType) {
            ForEach(VaultIdentifierType.allCases, id: \.self) { type in
              Text(NativeStrings.Vault.identifierName(type)).tag(type)
            }
          }
          .accessibilityIdentifier("hermie.vault.add.identifierType")

          TextField(NativeStrings.Vault.identifierName(form.identifierType), text: $form.identifier)
            .textContentType(.username)
            #if os(iOS)
              .keyboardType(identifierKeyboard)
            #endif
            .modifier(PlainEntry())
            .accessibilityIdentifier("hermie.vault.add.identifier")
        }
      }

      Section {
        ForEach(form.fields) { field in
          secretField(field)
        }
      }
      .disabled(model.adding)

      Section {
        if model.adding {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text(NativeStrings.Vault.saving)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("hermie.vault.add.saving")
        } else if let failure = model.addFailure {
          CapabilityStatusRow(
            text: VaultWords.add(failure), symbol: "exclamationmark.triangle", identifier: "hermie.vault.add.failed")
        }

        // Who receives it is part of the decision: in view, full contrast.
        Text(NativeStrings.Vault.receiver(botName))
          .font(.footnote)
          .foregroundStyle(Color.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("hermie.vault.add.receiver")
      }
    }
    .formStyle(.grouped)
  }

  #if os(iOS)
    private var identifierKeyboard: UIKeyboardType {
      switch form.identifierType {
      case .email: .emailAddress
      case .phone: .phonePad
      case .username: .asciiCapable
      }
    }
  #endif

  /// One secret field: masked unless it is part of an address, never filled by anything but the person (and,
  /// for a login's password, the system's password manager).
  @ViewBuilder private func secretField(_ field: VaultSecretField) -> some View {
    let label = NativeStrings.Vault.fieldName(field.key)
    let text = Binding(get: { form.secret(field.key).revealed }, set: { form.setSecret(field.key, $0) })

    switch field.entry {
    case .password:
      SecureField(label, text: text)
        .textContentType(.password)
        .modifier(PlainEntry())
        .focused($focus, equals: field.key)
        .onSubmit(save)
        .accessibilityIdentifier("hermie.vault.add.secret.\(field.key)")
    case .masked:
      // No content type: the system must not offer to keep an authenticator key or card details.
      SecureField(label, text: text)
        .modifier(PlainEntry())
        .focused($focus, equals: field.key)
        .accessibilityIdentifier("hermie.vault.add.secret.\(field.key)")
    case .maskedNumber:
      SecureField(label, text: text)
        #if os(iOS)
          .keyboardType(.asciiCapableNumberPad)
        #endif
        .modifier(PlainEntry())
        .focused($focus, equals: field.key)
        .accessibilityIdentifier("hermie.vault.add.secret.\(field.key)")
    case .plain:
      TextField(label, text: text)
        .modifier(PlainEntry())
        .focused($focus, equals: field.key)
        .accessibilityIdentifier("hermie.vault.add.secret.\(field.key)")
    }
  }
}

/// Unlock one password manager on the gateway with its master password, under the same rules as the Add
/// sheet's secret fields. The field has no content type: the system must not offer to keep a master password
/// as a website's.
struct VaultUnlockSheet: View {
  let model: VaultModel
  let source: VaultSource

  @State private var form: VaultUnlockForm
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase

  init(model: VaultModel, source: VaultSource) {
    self.model = model
    self.source = source
    _form = State(initialValue: VaultUnlockForm(source: source))
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          SecureField(NativeStrings.Vault.masterPassword, text: $form.password.revealed)
            .modifier(PlainEntry())
            .onSubmit(unlock)
            .disabled(model.unlocking != nil)
            .accessibilityIdentifier("hermie.vault.unlock.field")
        } footer: {
          SettingsNote(NativeStrings.Vault.unlockReceiver(source.displayName))
        }

        if model.unlocking != nil {
          Section {
            HStack(spacing: 8) {
              ProgressView()
                .controlSize(.small)
              Text(NativeStrings.Vault.unlocking)
            }
            .accessibilityElement(children: .combine)
          }
        } else if let failure = model.unlockFailure {
          Section {
            CapabilityStatusRow(
              text: VaultWords.unlock(failure), symbol: "exclamationmark.triangle",
              identifier: "hermie.vault.unlock.failed")
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.Vault.unlockTitle(source.displayName))
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(Strings.App.Common.cancel) {
            form.clear()
            dismiss()
          }
          .disabled(model.unlocking != nil)
        }

        ToolbarItem(placement: .confirmationAction) {
          Button(NativeStrings.Vault.unlock, action: unlock)
            .disabled(form.password.isEmpty || model.unlocking != nil)
            .accessibilityIdentifier("hermie.vault.unlock.submit")
        }
      }
    }
    .vaultSecretRules(phase: phase, leftForeground: form.clear, gone: form.clear)
    .interactiveDismissDisabled(model.unlocking != nil)
    .onAppear { model.dismissUnlockFailure() }
    #if os(macOS)
      .frame(minWidth: 420, minHeight: 260)
    #endif
  }

  private func unlock() {
    guard !form.password.isEmpty, model.unlocking == nil else {
      return
    }

    Task {
      if await form.submit(to: model) {
        dismiss()
      }
    }
  }
}

extension View {
  /// The rules every Vault sheet that takes a secret follows: covered while the app is not in front (the app
  /// switcher's snapshot, a shared screen), the secret emptied when the app goes to the background, and
  /// everything emptied when the sheet goes.
  ///
  /// Only the background empties the fields, not every moment the app is not in front: unlocking the
  /// system's password manager to fill a login makes the app inactive for a moment, and that must not
  /// throw away what was typed.
  func vaultSecretRules(
    phase: ScenePhase, leftForeground: @escaping @MainActor () -> Void, gone: @escaping @MainActor () -> Void
  ) -> some View {
    modifier(VaultSecretRules(phase: phase, leftForeground: leftForeground, gone: gone))
  }
}

struct VaultSecretRules: ViewModifier {
  let phase: ScenePhase
  let leftForeground: @MainActor () -> Void
  let gone: @MainActor () -> Void

  func body(content: Content) -> some View {
    content
      .overlay {
        if phase != .active {
          PrivacyCoverView()
        }
      }
      .onChange(of: phase, initial: true) { _, now in
        if now == .background {
          leftForeground()
        }
      }
      .onDisappear { gone() }
  }
}
