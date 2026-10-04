import HermieCore
import HermieProtocol
import SwiftUI

/// The sheet for an `input.signature`: the statement the person signs, shown in FULL and verbatim above the pad
/// with the signer's name and the time, a pad to draw on, and Sign and send.
///
/// Nothing is made or sent until the person presses Sign: then the PNG and the SVG are written from the strokes,
/// uploaded, and the answer carries the two references, the time and the SHA-256 of the statement as it was shown.
/// The statement is the request's own string (a statement this app cannot show exactly as it is is not shown at all,
/// `SignatureRequest.read`), so the hash is of what is on the sheet.
struct SignatureSheetView: View {
  let model: InteractiveModel
  let prompt: InteractivePrompt
  let request: SignatureRequest

  @State private var signature: InteractiveSignatureModel
  @State private var armed = false
  @State private var sending: Task<Void, Never>?

  init(model: InteractiveModel, prompt: InteractivePrompt, request: SignatureRequest) {
    self.model = model
    self.prompt = prompt
    self.request = request
    _signature = State(initialValue: InteractiveSignatureModel(request: request))
  }

  private typealias Words = NativeStrings.DeviceRequests.Signature

  private var inkBinding: Binding<SignatureInk> {
    Binding(get: { signature.ink }, set: { signature.setInk($0) })
  }

  var body: some View {
    InteractiveSheetFrame(
      model: model,
      prompt: prompt,
      icon: "signature",
      title: Words.title(model.botName),
      busy: signature.isBusy || model.isSending
    ) {
      VStack(alignment: .leading, spacing: 16) {
        statement
        pad
        status
        Text(Words.note)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("signature.note")
      }
      .disabled(model.isSending)
    } actions: {
      actions
    }
    .modifier(InteractiveTapGuard(armed: $armed, id: prompt.id))
    // An approval waits for the files to be made and sent rather than cutting them off.
    .onChange(of: signature.isBusy) { _, busy in
      model.setWorking(busy)
    }
    .onDisappear {
      sending?.cancel()
      signature.discard()
      model.setWorking(false)
    }
  }

  // MARK: Pieces

  /// What is signed: the request's statement exactly as it came (never cleaned, trimmed or cut), who signs and when.
  private var statement: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(Words.statement)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)

      Text(verbatim: request.statement)
        .font(.body)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .accessibilityIdentifier("signature.statement")

      Divider()

      VStack(alignment: .leading, spacing: 2) {
        if let name = request.signerName {
          Text(Words.signer(name))
            .font(.subheadline.weight(.semibold))
            .accessibilityIdentifier("signature.signer")
        }

        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text(verbatim: "\(Words.time): \(context.date.formatted(date: .abbreviated, time: .standard))")
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("signature.time")
      }
    }
    .padding(12)
    .background(.background.secondary, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
  }

  private var pad: some View {
    VStack(alignment: .leading, spacing: 8) {
      SignaturePad(ink: inkBinding, isLocked: signature.isBusy || model.isSending)

      HStack(spacing: 12) {
        Button {
          signature.clear()
        } label: {
          Label(Words.clear, systemImage: "trash")
        }
        .disabled(signature.ink.isEmpty || signature.isBusy)
        .accessibilityIdentifier("signature.clear")

        Button {
          var next = signature.ink
          next.undo()
          signature.setInk(next)
        } label: {
          Label(Words.undo, systemImage: "arrow.uturn.backward")
        }
        .disabled(signature.ink.isEmpty || signature.isBusy)
        .accessibilityIdentifier("signature.undo")

        Spacer(minLength: 0)
      }
      .buttonStyle(.borderless)
      .font(.callout)

      if !signature.ink.isSignature {
        Text(Words.empty)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("signature.empty")
      }
    }
  }

  @ViewBuilder private var status: some View {
    switch signature.phase {
    case .preparing:
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text(Words.preparing)
          .font(.callout)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("signature.preparing")
    case .uploading:
      VStack(alignment: .leading, spacing: 6) {
        ProgressView(value: signature.progress)
        Text(NativeStrings.Composer.Attach.uploading(percent: Int((signature.progress * 100).rounded())))
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("signature.progress")
    case .failed(let failure):
      failureView(failure)
    case .drawing, .uploaded:
      EmptyView()
    }
  }

  private func failureView(_ failure: InteractiveSignatureModel.Failure) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      switch failure {
      case .files:
        Label(Words.failedFiles, systemImage: "exclamationmark.triangle")
      case .tooLarge:
        Label(Words.tooLarge, systemImage: "exclamationmark.triangle")
      case .upload(let problem):
        Label(NativeStrings.Interactive.File.uploadFailed, systemImage: "exclamationmark.triangle")
        Text(verbatim: problem.message)
          .font(.callout)
          .fixedSize(horizontal: false, vertical: true)
        Text(NativeStrings.Interactive.File.giveUpNote)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .font(.callout.weight(.semibold))
    .foregroundStyle(.red)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("signature.failed")
  }

  // MARK: Actions

  @ViewBuilder private var actions: some View {
    if signature.phase == .uploading {
      Button {
        signature.cancelUpload()
      } label: {
        Text(NativeStrings.Interactive.File.cancelUpload)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .accessibilityIdentifier("signature.cancel")
    } else {
      VStack(spacing: 6) {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) { buttons(mainLast: true) }
          VStack(spacing: 10) { buttons(mainLast: false) }
        }

        DeclineButton(model: model, armed: armed, onDeclined: { signature.discard() })
      }
    }
  }

  @ViewBuilder private func buttons(mainLast: Bool) -> some View {
    if !mainLast {
      mainButton
    }

    LaterButton(model: model)

    if prompt.offersSkip {
      SkipButton(model: model, armed: armed, onSkipped: { signature.discard() })
    }

    if mainLast {
      mainButton
    }
  }

  private var mainButton: some View {
    Button {
      sign()
    } label: {
      Text(model.hasFailed || signature.phase == .uploaded ? NativeStrings.Interactive.tryAgain : Words.sign)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!armed || model.isSending || !signature.canSign)
    .accessibilityIdentifier("signature.sign")
  }

  /// Make the files, upload them, then answer with the references (or just answer again when they are already
  /// on the gateway).
  private func sign() {
    guard armed, !model.isSending, signature.canSign else {
      return
    }

    let signature = self.signature
    let model = self.model

    sending = Task {
      guard let answer = await signature.sign(through: model.uploader) else {
        return
      }

      if await model.answer(answer) {
        signature.discard()
      }
    }
  }
}
