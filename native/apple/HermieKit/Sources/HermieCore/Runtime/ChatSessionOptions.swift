import Foundation
import HermieProtocol
import HermieTranscript

/// What the gateway last said about this chat's session, beyond YOLO mode: the options the
/// options menu switches (fast mode, reasoning effort, model) and how full the context window is.
/// All of it comes from `session.info` and the usage the gateway reports; nothing here is guessed.
public struct ChatSessionOptions: Sendable, Equatable {
  /// Fast mode is on for this session (`session.info.fast`).
  public var fast: Bool
  /// The reasoning effort in force, as the gateway spells it (`none`, `low`, ...); `nil` before the
  /// gateway has said.
  public var reasoningEffort: String?
  /// The model in force, as the gateway spells it.
  public var model: String?
  /// The provider that model comes from, when the gateway said.
  public var provider: String?
  /// How full the context window is, or `nil` when the gateway has not said (no ring, never a zero).
  public var contextUsage: ContextUsage?

  public init(
    fast: Bool = false,
    reasoningEffort: String? = nil,
    model: String? = nil,
    provider: String? = nil,
    contextUsage: ContextUsage? = nil
  ) {
    self.fast = fast
    self.reasoningEffort = reasoningEffort
    self.model = model
    self.provider = provider
    self.contextUsage = contextUsage
  }

  init(state: ChatState) {
    let info = state.info

    self.init(
      fast: info?.fast ?? false,
      reasoningEffort: Self.words(info?.reasoningEffort),
      model: Self.words(info?.model),
      provider: Self.words(info?.provider),
      contextUsage: chatContextUsage(state)
    )
  }

  private static func words(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// The three options a chat's options menu switches per session (`config.set` keys).
public enum ChatSessionOption: String, Sendable, Equatable, CaseIterable {
  case fast
  case reasoning
  case model
}

/// What switching one option did.
public enum ChatOptionOutcome: Sendable, Equatable {
  /// The gateway took it. A model switch can carry a warning of the gateway's to show.
  case applied(warning: String?)
  /// The gateway answered that the model costs more and wrote nothing. The words are the gateway's
  /// own (possibly absent); asking again with `confirmExpensive` is the reader's decision, never made
  /// for them.
  case needsConfirmation(message: String?)
  /// The gateway or the connection refused it; the words are for a line over the chat. The state is
  /// unchanged.
  case failed(String)
}

/// Why the gateway's model list could not be read, in words for the picker.
public struct ChatOptionFailure: Error, Sendable, Equatable {
  public var message: String

  public init(message: String) {
    self.message = message
  }
}

extension BotModelChoice {
  /// What `config.set` takes for this model: `provider/model`, as the web client sends it. A model id
  /// that already names its provider is not prefixed twice.
  public var sessionValue: String {
    model.contains("/") || provider.isEmpty ? model : "\(provider)/\(model)"
  }

  /// Whether the session's model (`session.info.model`, which a gateway may write with or without its
  /// provider) is this one.
  public func isCurrent(model current: String?, provider currentProvider: String?) -> Bool {
    guard let current, !current.isEmpty else { return false }

    if current == sessionValue || current == id {
      return true
    }

    if current == model {
      return currentProvider == nil || currentProvider == provider
    }

    return false
  }
}
