import HermieCore
import SwiftUI

/**
 Voice mode's call screen: black and nearly empty, because on a call the orb is the interface.

 - **The orb** (`VoiceOrb`, in the look chosen on the Voice screen) says where the call is: it swells
   with the reader's voice while listening, pulses with the bot's while it speaks, and swirls with a
   glow running round its rim while the bot works. A tap on it while the bot speaks cuts in; while
   listening it sends what was heard now.
 - **Two round buttons**: the microphone (mute) on the left, end on the right; a small settings glyph top
   right opens the Voice screen (the call pauses under it).
 - **A caption** under the orb (Settings › Voice can hide it): what is being heard, then what the bot
   says as it arrives.
 - **What waits** (confirm before sending) comes up as a card with Send, Edit and Discard; a pause or a
   failure as a line with Resume or Try again.

 Dark whatever the system's theme. VoiceOver hears every change of state announced.
 */
struct VoiceModeView: View {
  let call: VoiceModeModel
  let settings: VoiceSettings
  /// The bot's name, for VoiceOver.
  let botName: String
  let onEnd: () -> Void
  let onSettings: () -> Void

  @FocusState private var editing: Bool

  var body: some View {
    ZStack {
      Color.black
        .ignoresSafeArea()

      VStack(spacing: 0) {
        HStack {
          Spacer()
          Button(action: onSettings) {
            Image(systemName: "slider.horizontal.3")
              .font(.title3)
              .foregroundStyle(.white.opacity(0.7))
              .frame(width: 44, height: 44)
              .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(NativeStrings.VoiceMode.settings)
          .accessibilityIdentifier("hermie.voiceMode.settings")
        }
        .padding(.horizontal, 12)

        Spacer(minLength: 12)

        orb

        Text(VoiceModeView.status(call.phase))
          .font(.footnote.weight(.medium))
          .foregroundStyle(.white.opacity(0.55))
          .padding(.top, 28)
          .accessibilityHidden(true)

        if settings.voiceModeCaptions, let caption = VoiceModeView.caption(call) {
          Text(caption)
            .font(.callout)
            .foregroundStyle(.white.opacity(0.85))
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .truncationMode(.head)
            .padding(.horizontal, 28)
            .padding(.top, 10)
            .frame(maxWidth: 520)
            .accessibilityIdentifier("hermie.voiceMode.caption")
        }

        Spacer(minLength: 12)

        notice
          .padding(.horizontal, 20)
          .padding(.bottom, 16)

        controls
          .padding(.horizontal, 36)
          .padding(.bottom, 28)
      }
    }
    .environment(\.colorScheme, .dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Text(verbatim: "\(Strings.Chat.Voice.mode), \(botName)"))
    .accessibilityIdentifier("hermie.voiceMode")
    .onChange(of: call.phase) { _, phase in
      AccessibilityNotification.Announcement(VoiceModeView.status(phase)).post()
    }
    .sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: call.cues)
    .onKeyPress(.escape) {
      onEnd()
      return .handled
    }
  }

  // MARK: The orb

  private var orb: some View {
    let meters = call.meters
    let mode = call.orbMode

    return VoiceOrb(
      style: settings.voiceModeOrb, mode: mode, busy: call.busy,
      level: { mode == .speaking ? meters.output.level : meters.input.level }
    )
    .contentShape(.circle)
    .onTapGesture {
      switch call.phase {
      case .speaking: call.interrupt()
      case .listening: call.sendNow()
      default: break
      }
    }
    .accessibilityElement()
    .accessibilityLabel(VoiceModeView.status(call.phase))
    .accessibilityAddTraits(call.phase == .speaking || call.phase == .listening ? .isButton : [])
    .accessibilityHint(VoiceModeView.orbHint(call.phase))
    .accessibilityIdentifier("hermie.voiceMode.orb")
  }

  // MARK: What waits

  @ViewBuilder private var notice: some View {
    switch call.phase {
    case .confirming:
      confirmation
    case .paused(.interruption):
      noticeRow(NativeStrings.VoiceMode.pausedInterruption, action: NativeStrings.VoiceMode.resume) {
        call.resumeAfterInterruption()
      }
    case .failed(let failure):
      noticeRow(VoiceModeView.text(for: failure), action: NativeStrings.VoiceMode.tryAgain) {
        Task { await call.start() }
      }
    default:
      EmptyView()
    }
  }

  private var confirmation: some View {
    VStack(spacing: 14) {
      Text(NativeStrings.VoiceMode.confirmTitle)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white.opacity(0.6))

      if call.editing {
        TextField(
          NativeStrings.VoiceMode.edit, text: Binding(get: { call.pending }, set: { call.pending = $0 }), axis: .vertical
        )
        .textFieldStyle(.plain)
        .font(.body)
        .foregroundStyle(.white)
        .lineLimit(1...5)
        .focused($editing)
        .onAppear { editing = true }
        .onSubmit { call.confirmSend() }
        .accessibilityIdentifier("hermie.voiceMode.editField")
      } else {
        Text(call.pending)
          .font(.body)
          .foregroundStyle(.white)
          .multilineTextAlignment(.center)
          .lineLimit(5)
      }

      HStack(spacing: 10) {
        pill(NativeStrings.VoiceMode.discard, prominent: false, id: "discard") { call.discard() }
        if !call.editing {
          pill(NativeStrings.VoiceMode.edit, prominent: false, id: "edit") { call.edit() }
        }
        pill(NativeStrings.VoiceMode.send, prominent: true, id: "send") { call.confirmSend() }
      }
    }
    .padding(18)
    .frame(maxWidth: 480)
    .background(.white.opacity(0.08), in: .rect(cornerRadius: 22))
  }

  private func noticeRow(_ text: String, action: String, perform: @escaping () -> Void) -> some View {
    VStack(spacing: 12) {
      Text(text)
        .font(.callout)
        .foregroundStyle(.white.opacity(0.8))
        .multilineTextAlignment(.center)
      pill(action, prominent: true, id: "retry", perform: perform)
    }
    .frame(maxWidth: 480)
  }

  private func pill(_ title: String, prominent: Bool, id: String, perform: @escaping () -> Void) -> some View {
    Button(action: perform) {
      Text(title)
        .font(.callout.weight(.semibold))
        .foregroundStyle(prominent ? .black : .white)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(prominent ? AnyShapeStyle(.white) : AnyShapeStyle(.white.opacity(0.14)), in: .capsule)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("hermie.voiceMode.\(id)")
  }

  // MARK: The buttons

  private var controls: some View {
    HStack {
      roundButton(
        systemImage: call.muted ? "mic.slash.fill" : "mic.fill",
        label: call.muted ? NativeStrings.VoiceMode.unmute : NativeStrings.VoiceMode.mute,
        tint: call.muted ? .white : .white.opacity(0.14),
        foreground: call.muted ? .black : .white,
        id: "mute"
      ) {
        call.toggleMute()
      }

      Spacer()

      if call.phase == .listening, !call.heard.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Button {
          call.sendNow()
        } label: {
          Label(NativeStrings.VoiceMode.sendNow, systemImage: "arrow.up")
            .font(.callout.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.white.opacity(0.14), in: .capsule)
        }
        .buttonStyle(.plain)
        .transition(.opacity)
        .accessibilityIdentifier("hermie.voiceMode.sendNow")

        Spacer()
      }

      roundButton(
        systemImage: "xmark", label: NativeStrings.VoiceMode.end, tint: Color(red: 0.95, green: 0.25, blue: 0.25),
        foreground: .white, id: "end", perform: onEnd)
    }
    .animation(.easeInOut(duration: 0.2), value: call.phase == .listening && !call.heard.isEmpty)
  }

  private func roundButton(
    systemImage: String, label: String, tint: Color, foreground: Color, id: String, perform: @escaping () -> Void
  ) -> some View {
    Button(action: perform) {
      Image(systemName: systemImage)
        .font(.title2.weight(.semibold))
        .foregroundStyle(foreground)
        .frame(width: 64, height: 64)
        .background(tint, in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier("hermie.voiceMode.\(id)")
  }

  // MARK: Words

  /// The state, as the status line shows it and VoiceOver says it.
  static func status(_ phase: VoiceModePhase) -> String {
    switch phase {
    case .off: Strings.Chat.Voice.mode
    case .starting: NativeStrings.VoiceMode.starting
    case .listening: Strings.Chat.Voice.modeListening
    case .confirming: NativeStrings.VoiceMode.confirmTitle
    case .sending: Strings.Chat.Voice.modeSending
    case .thinking: Strings.Chat.Voice.modeThinking
    case .speaking: Strings.Chat.Voice.modeSpeaking
    case .muted: NativeStrings.VoiceMode.muted
    case .paused(.request): NativeStrings.VoiceMode.pausedRequest
    case .paused(.background): NativeStrings.VoiceMode.paused
    case .paused(.interruption): NativeStrings.VoiceMode.pausedInterruption
    case .failed(let failure): text(for: failure)
    }
  }

  static func orbHint(_ phase: VoiceModePhase) -> String {
    switch phase {
    case .speaking: Strings.Chat.Voice.modeInterrupt
    case .listening: NativeStrings.VoiceMode.sendNow
    default: ""
    }
  }

  static func text(for failure: VoiceModeFailure) -> String {
    switch failure {
    case .recognition(.permission): NativeStrings.VoiceMode.failedPermission
    case .recognition(.unavailable): NativeStrings.VoiceMode.failedUnavailable
    case .recognition: NativeStrings.VoiceMode.failedOther
    case .audio: NativeStrings.VoiceMode.failedAudio
    case .notSent: NativeStrings.VoiceMode.failedNotSent
    }
  }

  /// The caption under the orb: what is heard while listening, what the bot says while it speaks or
  /// works, what was sent until then.
  static func caption(_ call: VoiceModeModel) -> String? {
    let text: String

    switch call.phase {
    case .listening: text = call.heard
    case .speaking, .thinking: text = call.reply.isEmpty ? call.heard : call.reply
    case .sending: text = call.heard
    default: return nil
    }

    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
