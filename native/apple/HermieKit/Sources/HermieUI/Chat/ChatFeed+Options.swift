import Foundation
import HermieCore
import HermieTranscript

/// The gateway's model list, as the picker draws it.
enum ModelListState: Equatable {
  case idle
  case loading
  case loaded([BotModelChoice])
  case failed(String)
}

/// A model the gateway answered is expensive: nothing was written, and the alert asks the reader.
struct PendingModelSwitch: Equatable {
  var choice: BotModelChoice
  /// The gateway's own words, when it sent any.
  var message: String?
}

/// The line over the chat about an option or an export.
enum ChatOptionNotice: Equatable {
  /// The gateway or the connection refused a switch; the reason is theirs.
  case failed(String)
  /// The switch went through, with a warning of the gateway's.
  case warning(String)
  /// The file could not be written.
  case exportFailed
}

/// The per-chat options beyond YOLO mode: fast mode, reasoning effort, the model, the context
/// meter, and the export. State comes from the session's info (`ChatModel.options`); every switch
/// asks the gateway and the chat follows what it says. Hidden by the menu while the chat is not
/// attached (`optionsAvailable`).
extension ChatFeed {
  /// The snapshot's options and attachment, set only when they change, and the one `session.usage`
  /// call for a chat resumed with no usage to show.
  func applyOptions(_ snapshot: ChatSnapshot) {
    if sessionOptions != snapshot.options {
      sessionOptions = snapshot.options
    }

    if optionsAvailable != snapshot.attached {
      optionsAvailable = snapshot.attached
    }

    if !snapshot.attached {
      usageAsked = false
    } else if snapshot.options.contextUsage == nil, !usageAsked {
      usageAsked = true
      let model = self.model

      Task { await model.refreshUsage() }
    }
  }

  // MARK: Fast mode and reasoning effort

  func setFast(_ enabled: Bool) {
    guard enabled != sessionOptions.fast else {
      return
    }

    let model = self.model

    Task {
      noted(await model.setFast(enabled))
    }
  }

  func setReasoningEffort(_ effort: String) {
    guard effort != sessionOptions.reasoningEffort else {
      return
    }

    let model = self.model

    Task {
      noted(await model.setReasoningEffort(effort))
    }
  }

  // MARK: Model

  /// Open the model list, and read the gateway's models when they are not here yet.
  func openModelPicker() {
    showingModelPicker = true
    loadModels()
  }

  /// Read the gateway's models (again, after a failure). Reading them twice at once is one read.
  func loadModels() {
    switch modelList {
    case .loading, .loaded: return
    case .idle, .failed: break
    }

    modelList = .loading
    let model = self.model

    Task {
      switch await model.modelChoices() {
      case .success(let choices): modelList = .loaded(choices)
      case .failure(let failure): modelList = .failed(failure.message)
      }
    }
  }

  /// The reader chose a model in the list. The list goes; a model the gateway calls expensive then
  /// asks (`pendingModel`) before anything is written.
  func chooseModel(_ choice: BotModelChoice) {
    showingModelPicker = false

    guard !choice.isCurrent(model: sessionOptions.model, provider: sessionOptions.provider) else {
      return
    }

    switchModel(choice, confirmed: false)
  }

  /// The alert about an expensive model was confirmed: the one place a switch goes out with
  /// `confirm_expensive_model`. Takes what the alert showed, so it never depends on whether the
  /// alert's dismissal has already cleared `pendingModel`.
  func confirmModel(_ pending: PendingModelSwitch) {
    pendingModel = nil
    switchModel(pending.choice, confirmed: true)
  }

  func cancelPendingModel() {
    pendingModel = nil
  }

  private func switchModel(_ choice: BotModelChoice, confirmed: Bool) {
    let model = self.model

    Task {
      noted(await model.setModel(choice, confirmExpensive: confirmed), choice: choice)
    }
  }

  /// What a switch did, for the line over the chat and the alert.
  func noted(_ outcome: ChatOptionOutcome, choice: BotModelChoice? = nil) {
    switch outcome {
    case .applied(let warning):
      optionNotice = warning.map(ChatOptionNotice.warning)
    case .needsConfirmation(let message):
      optionNotice = nil

      if let choice {
        pendingModel = PendingModelSwitch(choice: choice, message: message)
      }
    case .failed(let reason):
      optionNotice = .failed(reason)
    }
  }

  // MARK: Export

  /// Write the conversation out: everything loaded, at the reader's verbosity. The exporter (the
  /// system's save sheet) takes it from here.
  func export(_ format: TranscriptFileFormat, now: Date = Date()) {
    exportFile = TranscriptFile.make(
      items: model.items.map(\.item),
      botName: session.chatName(chat.bot),
      selfName: Strings.Chat.Export.`self`,
      format: format,
      now: now
    )
    exporting = true
  }

  /// The exporter finished. A reader who cancelled it is not told of a failure.
  func exportFinished(_ result: Result<URL, any Error>) {
    exporting = false
    exportFile = nil

    if case .failure(let error) = result, (error as? CocoaError)?.code != .userCancelled {
      optionNotice = .exportFailed
    }
  }
}
