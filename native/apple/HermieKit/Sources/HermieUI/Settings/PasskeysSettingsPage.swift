import HermieCore
import HermieGateway
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/**
 Settings → Gateways → Passkeys: one gateway's passkeys (plan `confirm-passkey.md`, P6, P7 and
 CP-10). Where they stand, in one sentence and with the reason in plain words; the passkeys of this
 account on the gateway (name, when it was added, when it was last used) with a way to remove each
 after a confirmation; "Add with a code" for a code from the gateway's operator (or from one's own
 passkey on another device); and "Create a code for another device" where the operator allows it.

 Everything it shows and does is `PasskeyModel`'s: the page only reads the model and calls its
 actions. Adding, creating a code and removing each open the system's passkey sheet, and the page
 tells what happened in plain words; the person dismissing that sheet is not an error.
 */
struct PasskeysSettingsPage: View {
  let model: PasskeyModel
  let gatewayName: String

  @State private var code = ""
  @State private var working = false
  @State private var failure: String?
  @State private var invite: PasskeyInvite?
  @State private var removing: PasskeyCredentialInfo?

  var body: some View {
    let state = PasskeysPageState.of(model)

    Form {
      noticesSection
      stateSection(state)

      if !model.credentials.isEmpty, state.canEnrol {
        credentialsSection
      }

      if state.canEnrol {
        addSection
      }

      if state == .enrolled {
        inviteSection
      }

      failureSection
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.Passkeys.title)
    .accessibilityIdentifier("hermie.passkeys.page")
    .task { await model.refresh() }
    .onDisappear { invite = nil }
    .confirmationDialog(
      NativeStrings.Passkeys.removeTitle,
      isPresented: removalPresented,
      titleVisibility: .visible,
      presenting: removing
    ) { credential in
      Button(NativeStrings.Passkeys.removeAction, role: .destructive) {
        remove(credential)
      }
      .accessibilityIdentifier("hermie.passkeys.remove.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { _ in
      Text(NativeStrings.Passkeys.removeMessage)
    }
  }

  // MARK: Sections

  @ViewBuilder private var noticesSection: some View {
    if !model.notices.isEmpty {
      Section {
        ForEach(model.notices) { notice in
          PasskeyNoticeRow(model: model, notice: notice)
        }
      }
    }
  }

  private func stateSection(_ state: PasskeysPageState) -> some View {
    let words = PasskeysText.state(state)

    return Section {
      Label {
        Text(words.text)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: words.symbol)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.passkeys.state")
    } header: {
      SettingsNote(NativeStrings.Passkeys.stateHeader(gatewayName))
    } footer: {
      SettingsNote(NativeStrings.Passkeys.stateFooter)
    }
  }

  private var credentialsSection: some View {
    Section {
      ForEach(Array(model.credentials.enumerated()), id: \.offset) { _, credential in
        PasskeyCredentialRow(credential: credential, busy: working) {
          removing = credential
        }
      }
    } header: {
      SettingsNote(NativeStrings.Passkeys.credentialsHeader)
    }
  }

  private var addSection: some View {
    Section {
      TextField(NativeStrings.Passkeys.codeField, text: $code)
        .autocorrectionDisabled()
        .privacySensitive()
        #if os(iOS)
          .textInputAutocapitalization(.characters)
        #endif
        .accessibilityIdentifier("hermie.passkeys.code")

      Button(NativeStrings.Passkeys.addAction) {
        enrol()
      }
      .disabled(working || code.trimmingCharacters(in: .whitespaces).isEmpty)
      .accessibilityIdentifier("hermie.passkeys.add")
    } header: {
      SettingsNote(NativeStrings.Passkeys.addHeader)
    } footer: {
      SettingsNote(NativeStrings.Passkeys.addFooter)
    }
  }

  @ViewBuilder private var inviteSection: some View {
    Section {
      if let invite {
        PasskeyInviteView(invite: invite) {
          self.invite = nil
        }
      } else if model.status?.userInvites == true {
        Button(NativeStrings.Passkeys.inviteAction) {
          mintInvite()
        }
        .disabled(working)
        .accessibilityIdentifier("hermie.passkeys.invite")
      }
    } header: {
      SettingsNote(NativeStrings.Passkeys.inviteHeader)
    } footer: {
      SettingsNote(model.status?.userInvites == true ? NativeStrings.Passkeys.inviteFooter : NativeStrings.Passkeys.invitesOff)
    }
  }

  @ViewBuilder private var failureSection: some View {
    if let failure {
      Section {
        Label {
          Text(failure)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(.orange)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.passkeys.failure")
      }
    }
  }

  // MARK: Actions

  private var removalPresented: Binding<Bool> {
    Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
  }

  private func enrol() {
    let typed = code

    run {
      _ = try await model.enrol(code: typed)
      code = ""
    }
  }

  private func mintInvite() {
    run {
      invite = try await model.mintInvite()
    }
  }

  private func remove(_ credential: PasskeyCredentialInfo) {
    guard let id = credential.id else { return }

    run {
      try await model.revoke(credentialID: id)
    }
  }

  /// One action at a time; what it throws is said in plain words, and a dismissed system sheet says
  /// nothing.
  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    guard !working else { return }
    working = true
    failure = nil

    Task {
      do {
        try await action()
      } catch let error as PasskeyActionError {
        failure = PasskeysText.failure(error)
      } catch {
        failure = NativeStrings.Passkeys.unreadable
      }

      working = false
    }
  }
}

/// One passkey of the account: its name as the gateway has it, when it was added and last used,
/// and the way to remove it.
struct PasskeyCredentialRow: View {
  let credential: PasskeyCredentialInfo
  let busy: Bool
  let remove: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        // The name is the passkey's own, set by the app that made it: plain text.
        Text(verbatim: credential.name ?? "")
          .font(.body)
          .fixedSize(horizontal: false, vertical: true)
        Text(Self.added(credential.createdAt))
          .font(.footnote)
        Text(Self.lastUsed(credential.lastUsedAt))
          .font(.footnote)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)

      Button(NativeStrings.Passkeys.removeAction, systemImage: "trash", role: .destructive, action: remove)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .disabled(busy)
        .accessibilityIdentifier("hermie.passkeys.remove")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.passkeys.credential")
  }

  static func added(_ at: Double?) -> String {
    guard let at else { return NativeStrings.Passkeys.addedUnknown }
    return NativeStrings.Passkeys.added(Self.format(at))
  }

  static func lastUsed(_ at: Double?) -> String {
    guard let at else { return NativeStrings.Passkeys.neverUsed }
    return NativeStrings.Passkeys.lastUsed(Self.format(at))
  }

  private static func format(_ unix: Double) -> String {
    Date(timeIntervalSince1970: unix).formatted(date: .abbreviated, time: .shortened)
  }
}

/// A freshly made code for another device: shown once, with a copy button and when it expires. It
/// is dropped when the page goes away.
struct PasskeyInviteView: View {
  let invite: PasskeyInvite
  let hide: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: invite.code)
        .font(.title3.monospaced().weight(.semibold))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.passkeys.invite.code")

      if let expires = invite.expiresAt {
        Text(NativeStrings.Passkeys.inviteExpires(expires.formatted(date: .omitted, time: .shortened)))
          .font(.footnote)
          .accessibilityIdentifier("hermie.passkeys.invite.expires")
      }

      HStack(spacing: 16) {
        Button(NativeStrings.Passkeys.copyCode, systemImage: "doc.on.doc") {
          PasskeyCodeBoard.copy(invite)
        }
        .accessibilityIdentifier("hermie.passkeys.invite.copy")

        Button(NativeStrings.Passkeys.hideCode, systemImage: "eye.slash", action: hide)
          .accessibilityIdentifier("hermie.passkeys.invite.hide")
      }
      .buttonStyle(.borderless)
    }
    .accessibilityElement(children: .contain)
  }
}

/// The pasteboard for a code: it stays on this device and goes when the code expires.
@MainActor
enum PasskeyCodeBoard {
  static func copy(_ invite: PasskeyInvite) {
    #if os(iOS)
      var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]

      if let expires = invite.expiresAt {
        options[.expirationDate] = expires
      }

      UIPasteboard.general.setItems([["public.utf8-plain-text": invite.code]], options: options)
    #elseif os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(invite.code, forType: .string)
    #endif
  }
}

/// The row to the Passkeys page in Settings → Gateways: the live gateway's, when this build has
/// passkeys. Only the live gateway has a session, so only its passkeys can be read and changed.
struct PasskeysGatewaySection: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let model = live?.session?.passkeys, let id = live?.gatewayID, let entry = launch.gateways.entry(id: id) {
      Section {
        NavigationLink {
          PasskeysSettingsPage(model: model, gatewayName: entry.name)
        } label: {
          LabeledContent(NativeStrings.Passkeys.title) {
            Text(verbatim: entry.name)
          }
        }
        .accessibilityIdentifier("hermie.settings.passkeys")
      }
    }
  }
}

extension NativeStrings {
  enum Passkeys {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Passkeys
    static var title: String { string("native.passkeys.title") }
    /// Passkeys on {gateway}
    static func stateHeader(_ gateway: String) -> String {
      String(localized: "native.passkeys.stateHeader", defaultValue: "Passkeys on \(gateway)", table: "Native", bundle: .module)
    }
    /// A passkey lets you confirm what a bot asks…
    static var stateFooter: String { string("native.passkeys.stateFooter") }
    /// Checking this gateway…
    static var loading: String { string("native.passkeys.state.loading") }
    /// This version of Hermie has no passkey support…
    static var notConfigured: String { string("native.passkeys.state.notConfigured") }
    /// This gateway does not offer passkeys.
    static var notOffered: String { string("native.passkeys.state.notOffered") }
    /// This gateway does not list the address Hermie uses…
    static var originNotListed: String { string("native.passkeys.state.originNotListed") }
    /// Too many attempts. Try again in {n} seconds.
    static func rateLimited(seconds: Int) -> String {
      String(
        localized: "native.passkeys.state.rateLimited", defaultValue: "Too many attempts. Try again in \(seconds) seconds.",
        table: "Native", bundle: .module)
    }
    /// Too many attempts. Try again in a moment.
    static var rateLimitedSoon: String { string("native.passkeys.state.rateLimitedSoon") }
    /// Hermie could not read the passkey settings from this gateway.
    static var unreadable: String { string("native.passkeys.state.unreadable") }
    /// Passkeys are turned off on this gateway.
    static var disabled: String { string("native.passkeys.state.disabled") }
    /// The operator of this gateway has not set an address for passkeys.
    static var noBaseURL: String { string("native.passkeys.state.noBaseURL") }
    /// This gateway is only reachable on a private address…
    static var privateOrigin: String { string("native.passkeys.state.privateOrigin") }
    /// Passkeys need a signed-in account…
    static var noIdentity: String { string("native.passkeys.state.noIdentity") }
    /// This gateway does not accept the passkey identity this version of Hermie uses.
    static var rpNotAccepted: String { string("native.passkeys.state.rpNotAccepted") }
    /// No passkey for this gateway yet…
    static var notEnrolled: String { string("native.passkeys.state.notEnrolled") }
    /// Passkey confirmation is on for this gateway.
    static var enrolled: String { string("native.passkeys.state.enrolled") }
    /// Passkeys of your account
    static var credentialsHeader: String { string("native.passkeys.credentials.header") }
    /// Added {date}
    static func added(_ date: String) -> String {
      String(localized: "native.passkeys.added", defaultValue: "Added \(date)", table: "Native", bundle: .module)
    }
    /// Added at an unknown time
    static var addedUnknown: String { string("native.passkeys.addedUnknown") }
    /// Last used {date}
    static func lastUsed(_ date: String) -> String {
      String(localized: "native.passkeys.lastUsed", defaultValue: "Last used \(date)", table: "Native", bundle: .module)
    }
    /// Never used
    static var neverUsed: String { string("native.passkeys.neverUsed") }
    /// Remove passkey
    static var removeAction: String { string("native.passkeys.remove.action") }
    /// Remove this passkey?
    static var removeTitle: String { string("native.passkeys.remove.title") }
    /// You will be asked for a passkey…
    static var removeMessage: String { string("native.passkeys.remove.message") }
    /// Add with a code
    static var addHeader: String { string("native.passkeys.add.header") }
    /// Code from the gateway's operator
    static var codeField: String { string("native.passkeys.add.field") }
    /// Add passkey
    static var addAction: String { string("native.passkeys.add.action") }
    /// The operator of this gateway gives you a one-time code…
    static var addFooter: String { string("native.passkeys.add.footer") }
    /// Create a code for another device
    static var inviteHeader: String { string("native.passkeys.invite.header") }
    /// Create a code
    static var inviteAction: String { string("native.passkeys.invite.action") }
    /// Use it on the other device or in a browser…
    static var inviteFooter: String { string("native.passkeys.invite.footer") }
    /// The operator of this gateway has turned off creating codes here.
    static var invitesOff: String { string("native.passkeys.invite.off") }
    /// Expires at {time}
    static func inviteExpires(_ time: String) -> String {
      String(localized: "native.passkeys.invite.expires", defaultValue: "Expires at \(time)", table: "Native", bundle: .module)
    }
    /// Copy code
    static var copyCode: String { string("native.passkeys.invite.copy") }
    /// Hide code
    static var hideCode: String { string("native.passkeys.invite.hide") }
    /// That code does not look right…
    static var invalidCode: String { string("native.passkeys.failure.invalidCode") }
    /// That code is not valid, has expired or was already used.
    static var codeNotValid: String { string("native.passkeys.failure.codeNotValid") }
    /// No passkey of yours for this gateway is available…
    static var noPasskeyHere: String { string("native.passkeys.failure.noPasskey") }
    /// See the notice above…
    static var seeNotice: String { string("native.passkeys.failure.seeNotice") }
    /// The gateway's answer was not what Hermie expected.
    static var badAnswer: String { string("native.passkeys.failure.badAnswer") }
    /// Another passkey prompt is open…
    static var promptBusy: String { string("native.passkeys.failure.promptBusy") }
    /// This device cannot use passkeys right now…
    static var cannotUsePasskeys: String { string("native.passkeys.failure.cannotUse") }
    /// The passkey prompt did not finish…
    static var promptFailed: String { string("native.passkeys.failure.promptFailed") }
    /// This passkey is already on this gateway.
    static var alreadyEnrolled: String { string("native.passkeys.failure.alreadyEnrolled") }
    /// Too slow…
    static var tooSlow: String { string("native.passkeys.failure.tooSlow") }
    /// The gateway refused…
    static var refused: String { string("native.passkeys.failure.refused") }

    enum Notice {
      /// Passkey confirmations are off: this gateway no longer identifies itself…
      static var gatewayIDMismatch: String { string("native.passkeys.notice.gatewayIDMismatch") }
      /// Passkey confirmations are off: this gateway presents an identity that belongs to another gateway.
      static var gatewayIDConflict: String { string("native.passkeys.notice.gatewayIDConflict") }
      /// This gateway presents the same identity as "{name}"…
      static func sameGateway(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.sameGateway",
          defaultValue:
            "This gateway presents the same passkey identity as \u{201C}\(name)\u{201D}, which you added already. If it is the same gateway under another address, link them. Until then its passkey confirmations are off.",
          table: "Native", bundle: .module)
      }
      /// Same gateway as {name}
      static func sameGatewayAction(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.sameGatewayAction", defaultValue: "Same gateway as \(name)", table: "Native",
          bundle: .module)
      }
      /// Hermie could not read the passkey records it keeps for this gateway…
      static var pinUnreadable: String { string("native.passkeys.notice.pinUnreadable") }
      /// This gateway asked for a confirmation in a version this app does not know…
      static var unsupportedVersion: String { string("native.passkeys.notice.unsupportedVersion") }
      /// A confirmation arrived that this device has no passkey for…
      static var noCredentialForApp: String { string("native.passkeys.notice.noCredentialForApp") }
      /// A confirmation arrived that this app could not read…
      static var malformedRequest: String { string("native.passkeys.notice.malformedRequest") }
      /// A passkey was added to your account on this gateway: {name}
      static func added(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.added",
          defaultValue: "A passkey was added to your account on this gateway without this device: \(name)",
          table: "Native", bundle: .module)
      }
      /// A passkey was removed from your account on this gateway: {name}
      static func revoked(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.revoked",
          defaultValue: "A passkey was removed from your account on this gateway without this device: \(name)",
          table: "Native", bundle: .module)
      }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }
  }
}
