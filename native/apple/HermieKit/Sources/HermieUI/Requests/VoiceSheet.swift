import HermieCore
import HermieProtocol
import SwiftUI
import UniformTypeIdentifiers

/// The sheet for an `input.file` that asks for a recording (`accept: audio`, `capture: audio`): Record, a level and a
/// clock while it runs, Stop, then the recording to play back, its transcript (made on this device, when the device
/// can) and Upload and send. Nothing leaves the device until the person presses that.
///
/// The microphone is not opened, and the system's prompt is not shown, until Record is pressed. The person can
/// also pick an existing recording from Files; it goes as it is, and the sheet says it may carry details of its own.
/// No microphone, or a refused permission, is said here, and the person may tell the bot they cannot (`4041`).
struct VoiceSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let params: InputFileParams

  @State private var voice: InteractiveVoiceModel
  @State private var armed = false
  @State private var showFiles = false
  @State private var sending: Task<Void, Never>?
  @Environment(\.scenePhase) private var scenePhase

  init(model: InteractiveModel, prompt: InteractivePrompt, params: InputFileParams) {
    self.model = model
    self.prompt = prompt
    self.params = params
    _voice = State(initialValue: InteractiveVoiceModel(params: params))
  }

  private typealias Words = NativeStrings.DeviceRequests.Voice

  /// Something is going on that must not be cut off: recording, writing the file, uploading.
  private var busy: Bool {
    voice.phase == .recording || voice.phase == .preparing || voice.files.phase == .uploading || model.isSending
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "waveform",
      title: Words.title(model.botName),
      busy: busy
    ) {
      VStack(alignment: .leading, spacing: 16) {
        content

        if let notice = voice.notice {
          Label(noticeText(notice), systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("voice.notice")
        }

        if let rejection = voice.files.rejection {
          Label(rejectionText(rejection), systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("voice.rejection")
        }

        upload
      }
      .disabled(model.isSending)
    } actions: {
      actions
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    .fileImporter(isPresented: $showFiles, allowedContentTypes: [.audio], allowsMultipleSelection: false) { result in
      if case .success(let urls) = result {
        let voice = self.voice
        Task { await voice.pick(urls) }
      }
    }
    // An approval waits for a recording or an upload to finish rather than cutting it off.
    .onChange(of: busy) { _, working in
      model.setWorking(working)
    }
    // The recording stops, and is kept, when the app leaves the front.
    .onChange(of: scenePhase) { _, phase in
      if phase != .active {
        voice.stopRecording()
      }
    }
    .onDisappear {
      sending?.cancel()
      voice.discard()
      model.setWorking(false)
    }
  }

  // MARK: Pieces

  @ViewBuilder private var content: some View {
    switch voice.phase {
    case .ready:
      VStack(alignment: .leading, spacing: 12) {
        Text(Words.intro)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("voice.intro")
        chooseFile
      }
    case .asking, .preparing:
      ProgressView()
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("voice.working")
    case .recording:
      recording
    case .recorded:
      recorded
    case .unavailable(let reason):
      unavailable(reason)
    }
  }

  private var chooseFile: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        showFiles = true
      } label: {
        Label(Words.chooseFile, systemImage: "folder")
      }
      .buttonStyle(.borderless)
      .disabled(!armed || !voice.canRecord)
      .accessibilityIdentifier("voice.chooseFile")

      Text(Words.pickedNote)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var recording: some View {
    VStack(spacing: 14) {
      Label(Words.recording, systemImage: "record.circle")
        .font(.headline)
        .foregroundStyle(.red)
        .accessibilityIdentifier("voice.recording")

      Text(verbatim: Self.clock(voice.elapsed))
        .font(.system(size: 44, weight: .semibold, design: .rounded).monospacedDigit())
        .accessibilityLabel(Words.noteLength(Self.spoken(voice.elapsed)))
        .accessibilityIdentifier("voice.elapsed")

      LevelMeter(levels: voice.levels)
        .frame(height: 48)
        .accessibilityElement()
        .accessibilityLabel(Words.level)
    }
    .frame(maxWidth: .infinity)
  }

  private var recorded: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Button {
          voice.togglePlayback()
        } label: {
          Image(systemName: voice.isPlaying ? "pause.circle.fill" : "play.circle.fill")
            .font(.system(size: 44))
            .accessibilityLabel(voice.isPlaying ? Words.pause : Words.play)
        }
        .buttonStyle(.borderless)
        .disabled(voice.files.phase == .uploading)
        .accessibilityIdentifier("voice.play")

        VStack(alignment: .leading, spacing: 4) {
          ProgressView(value: min(voice.position, max(voice.duration ?? 0, 0.001)), total: max(voice.duration ?? 1, 0.001))
          Text(verbatim: voice.duration.map(Self.clock) ?? "")
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Words.noteLength(Self.spoken(voice.duration ?? 0)))
      }
      .padding(12)
      .background(.background.secondary, in: .rect(cornerRadius: 12))

      transcriptView

      Label(voice.wasPicked ? Words.pickedNote : Words.recordedNote, systemImage: voice.wasPicked ? "info.circle" : "location.slash")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("voice.metadata")
    }
  }

  @ViewBuilder private var transcriptView: some View {
    switch voice.transcript {
    case .working:
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(Words.transcribing)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("voice.transcribing")
    case .ready(let text):
      VStack(alignment: .leading, spacing: 8) {
        Text(Words.transcriptLabel)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        // The machine's words, as plain text: never Markdown.
        RequestTextBox(text: text, identifier: "voice.transcript")
        Toggle(Words.sendTranscript, isOn: Binding(get: { voice.includesTranscript }, set: { voice.includesTranscript = $0 }))
          .accessibilityIdentifier("voice.includeTranscript")
        Text(Words.transcriptNote)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    case .empty:
      Text(Words.transcriptEmpty)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("voice.transcriptEmpty")
    case .unavailable:
      Text(Words.transcriptNone)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("voice.transcriptNone")
    }
  }

  private func unavailable(_ reason: InteractiveVoiceModel.Unavailable) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(reason == .denied ? Words.denied : Words.noMicrophone, systemImage: "mic.slash")
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("voice.unavailable")

      if reason == .denied {
        Button(NativeStrings.DeviceRequests.openSettings) {
          SystemSettings.open(.microphone)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("voice.openSettings")
      }

      chooseFile
    }
  }

  @ViewBuilder private var upload: some View {
    switch voice.files.phase {
    case .uploading:
      VStack(alignment: .leading, spacing: 6) {
        ProgressView(value: voice.files.progress)
        Text(NativeStrings.Composer.Attach.uploading(percent: Int((voice.files.progress * 100).rounded())))
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("voice.progress")
    case .failed:
      VStack(alignment: .leading, spacing: 6) {
        Label(NativeStrings.Interactive.File.uploadFailed, systemImage: "exclamationmark.triangle")
          .font(.callout.weight(.semibold))
          .foregroundStyle(.red)
        if let failure = voice.files.failure {
          Text(verbatim: failure.message)
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(NativeStrings.Interactive.File.giveUpNote)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("voice.failed")
    case .uploaded:
      Label(NativeStrings.Interactive.File.uploaded, systemImage: "checkmark.circle")
        .foregroundStyle(.green)
        .accessibilityIdentifier("voice.uploaded")
    case .choosing:
      EmptyView()
    }
  }

  // MARK: Actions

  @ViewBuilder private var actions: some View {
    if voice.files.phase == .uploading {
      Button {
        voice.cancelUpload()
      } label: {
        Text(NativeStrings.Interactive.File.cancelUpload)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .accessibilityIdentifier("voice.cancel")
    } else if voice.phase == .recording {
      Button {
        voice.stopRecording()
      } label: {
        Label(Words.stop, systemImage: "stop.fill")
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(.red)
      .controlSize(.large)
      .accessibilityIdentifier("voice.stop")
    } else {
      VStack(spacing: 6) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) { buttons(mainLast: true) }
          VStack(spacing: 10) { buttons(mainLast: false) }
        }

        if case .unavailable(let reason) = voice.phase {
          Button {
            Task { await model.cannotShow(reason: reason.reason, notify: true) }
          } label: {
            Text(Words.cannot)
              .font(.callout)
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderless)
          .foregroundStyle(.secondary)
          .disabled(!armed || model.isSending)
          .accessibilityHint(Words.cannotHint)
          .accessibilityIdentifier("voice.cannot")
        }

        DeclineButton(model: model, armed: armed, onDeclined: { voice.discard() })
      }
    }
  }

  @ViewBuilder private func buttons(mainLast: Bool) -> some View {
    if !mainLast {
      mainButton
    }

    LaterButton(model: model)

    if voice.phase == .recorded, voice.files.phase != .uploading {
      Button {
        voice.startOver()
      } label: {
        Text(Words.recordAgain)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .disabled(model.isSending)
      .accessibilityIdentifier("voice.recordAgain")
    } else if prompt.offersSkip {
      SkipButton(model: model, armed: armed, onSkipped: { voice.discard() })
    }

    if mainLast {
      mainButton
    }
  }

  /// Record before there is a note; Upload and send once there is one.
  @ViewBuilder private var mainButton: some View {
    if voice.phase == .recorded {
      Button {
        send()
      } label: {
        Text(sendTitle)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending || !voice.canSend)
      .accessibilityIdentifier("voice.send")
    } else {
      Button {
        Task { await voice.record() }
      } label: {
        Label(Words.record, systemImage: "mic.fill")
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(!armed || model.isSending || !voice.canRecord)
      .accessibilityIdentifier("voice.record")
    }
  }

  private var sendTitle: String {
    switch voice.files.phase {
    case .uploaded: model.hasFailed ? NativeStrings.Interactive.tryAgain : NativeStrings.Interactive.send
    case .failed: NativeStrings.Interactive.tryAgain
    default: NativeStrings.Interactive.File.uploadAndSend
    }
  }

  private func send() {
    guard armed, !model.isSending, voice.canSend else {
      return
    }

    let voice = self.voice
    let model = self.model

    sending = Task {
      guard let answer = await voice.send(through: model.uploader) else {
        return
      }

      if await model.answer(answer) {
        voice.discard()
      }
    }
  }

  // MARK: Words

  private func noticeText(_ notice: InteractiveVoiceModel.Notice) -> String {
    switch notice {
    case .tooShort: Words.tooShort
    case .recordingFailed: Words.recordingFailed
    case .microphoneBusy: Words.microphoneBusy
    case .unreadable: Words.unreadable
    }
  }

  private func rejectionText(_ rejection: InteractiveFileModel.Rejection) -> String {
    typealias FileWords = NativeStrings.Interactive.File

    switch rejection {
    case .tooMany(let limit): return FileWords.rejectTooMany(limit)
    case .tooLarge(let name, let limit):
      return FileWords.rejectTooLarge(InteractivePrompt.line(name, limit: InteractivePrompt.labelLimit), AttachmentFormat.limit(limit))
    case .totalTooLarge(let limit): return FileWords.rejectTotal(AttachmentFormat.limit(limit))
    case .unreadable(let name):
      return FileWords.rejectUnreadable(InteractivePrompt.line(name, limit: InteractivePrompt.labelLimit))
    }
  }

  /// `0:42`, `12:05`: the length of a note.
  static func clock(_ seconds: Double) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    return String(format: "%d:%02d", whole / 60, whole % 60)
  }

  /// A length VoiceOver reads well: "1 minute, 5 seconds".
  static func spoken(_ seconds: Double) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    let style = Duration.UnitsFormatStyle(allowedUnits: [.minutes, .seconds], width: .wide)
    return Duration.seconds(whole).formatted(style)
  }
}

/// The last few sound levels as bars, newest on the right.
private struct LevelMeter: View {
  let levels: [Double]

  var body: some View {
    GeometryReader { proxy in
      HStack(alignment: .center, spacing: 3) {
        ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
          Capsule()
            .fill(Color.red.opacity(0.8))
            .frame(width: 4, height: max(4, proxy.size.height * level))
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    }
    .animation(.linear(duration: 0.1), value: levels)
  }
}
