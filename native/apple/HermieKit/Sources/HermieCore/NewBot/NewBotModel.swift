import Foundation
import HermieGateway
import HermieProtocol
import Observation

/// What the New bot form asks the gateway session for besides the request itself: the roster, in two
/// steps that must not be one (`features/profiles/profiles-controller.ts`).
public struct NewBotRoster: Sendable {
  /// `BotRoster.refresh`: re-read `profiles.list`, so the new row exists with the display name and the
  /// model the gateway actually stored rather than the ones that were asked for.
  public var refresh: @Sendable () async throws -> [Bot]
  /// `BotRoster.resolveCanonical`: the ONE way a Bot Chat is found or made (ADR-0007). Minting a
  /// session here directly would be a second way to make a canonical chat, and two ways is how a
  /// chat gets forked.
  public var resolveCanonical: @Sendable (Bot) async throws -> CanonicalSession

  public init(
    refresh: @escaping @Sendable () async throws -> [Bot],
    resolveCanonical: @escaping @Sendable (Bot) async throws -> CanonicalSession
  ) {
    self.refresh = refresh
    self.resolveCanonical = resolveCanonical
  }
}

/// The form's answers, before they are turned into `profiles.create` params.
public struct NewBotDraft: Equatable, Sendable {
  /// The handle, already normalised (`ProfileName.check`).
  public var handle: String
  public var description: String
  public var model: BotModelChoice?
  /// A bot to copy `config.yaml` from, or nil for a fresh profile.
  public var cloneFrom: String?

  public init(handle: String, description: String = "", model: BotModelChoice? = nil, cloneFrom: String? = nil) {
    self.handle = handle
    self.description = description
    self.model = model
    self.cloneFrom = cloneFrom
  }

  /// The draft as `profiles.create` params, with the three rules that are invisible at the call site:
  ///
  /// - `model` and `provider` go together or not at all (`_pin_profile_model` only runs when it has
  ///   both), and `model` is the bare id as `model.options` lists it, as `profiles.configure` takes it.
  /// - `mirror_credentials` is left OUT: it defaults to true upstream, and a bare create without it
  ///   seeds a comment-only `.env` and no `auth.json`, which is a bot that cannot reach any provider.
  /// - `clone_from` is omitted, not sent as null, when there is nothing to clone.
  public var params: ProfilesCreateParams {
    var params = ProfilesCreateParams(name: handle)
    let text = description.trimmingCharacters(in: .whitespacesAndNewlines)

    if !text.isEmpty {
      params.profileDescription = text
    }

    if let cloneFrom, !cloneFrom.isEmpty {
      params.cloneFrom = cloneFrom
    }

    if let model, !model.model.isEmpty, !model.provider.isEmpty {
      params.model = model.model
      params.provider = model.provider
    }

    return params
  }
}

/**
 The New bot form: a handle, a description, optionally a model and a bot to copy the settings of,
 and the three steps that turn them into a chat to open (`ProfilesController` in the Expo app).

 `profiles.create` writes a profile directory and stops: it does not mint a conversation, so a new bot
 is a roster row with no `canonical_session`. Creating is therefore three steps, in this order:

 1. `profiles.create`, the only step that fails in a way the reader needs to read;
 2. refresh the roster. The gateway answers the name it STORED, the normalised handle, and the roster
    row carries what it actually stored;
 3. resolve the bot's canonical chat the ordinary way.

 When the first step worked and a later one did not, the bot exists: the model remembers that and a
 second `create()` carries on from the step that failed instead of asking the gateway for a name that
 is taken now.

 The handle is checked while it is typed (`ProfileName`), against the roster this device already holds.
 Everything the gateway sent back (its error words, the names on the roster) is untrusted text.
 */
@MainActor
@Observable
public final class NewBotModel {
  /// The models the gateway offers, read once. A gateway that will not list them leaves
  /// `.unavailable`, and the new bot inherits the launch profile's model.
  public enum ModelChoices: Equatable, Sendable {
    case idle
    case loading
    case loaded([BotModelChoice])
    case unavailable
  }

  /// A bot that was made, and the chat to open.
  public struct Created: Equatable, Sendable {
    /// The handle the gateway stored, which may differ from what was typed.
    public var name: String
    public var chat: CanonicalSession
    /// The gateway said it pinned nothing and inherited nothing: a bot with no provider behind it.
    public var withoutModel: Bool
  }

  public enum Failure: Equatable, Sendable {
    /// The gateway (or the connection) refused.
    case request(BotSettingsFailure)
    /// The gateway made the bot and did not list it.
    case notListed(String)
  }

  public var handleText = ""
  public var displayName = ""
  public var botDescription = ""
  public var cloneFrom: String?
  public var model: BotModelChoice?

  public private(set) var modelChoices = ModelChoices.idle
  public private(set) var creating = false
  public private(set) var failure: Failure?
  public private(set) var created: Created?

  /// The bots that exist, for the clone picker and for the collision check.
  public let existing: [String]

  @ObservationIgnored private let gateway: BotSettingsGateway
  @ObservationIgnored private let roster: NewBotRoster
  @ObservationIgnored private let setLabel: @MainActor (_ name: String, _ label: String) -> Void
  /// The profile the gateway made, kept so a retry does not ask for it again.
  @ObservationIgnored private var made: ProfilesCreateResult?

  /// - Parameters:
  ///   - existing: the handles on the roster now.
  ///   - setLabel: where the person's own name for the bot goes (`ChatArrangementModel.setLabel`); it is
  ///     the reader's own `ui_meta`, not something `profiles.create` takes.
  public init(
    gateway: BotSettingsGateway,
    roster: NewBotRoster,
    existing: [String],
    setLabel: @escaping @MainActor (_ name: String, _ label: String) -> Void = { _, _ in }
  ) {
    self.gateway = gateway
    self.roster = roster
    self.existing = existing
    self.setLabel = setLabel
  }

  /// The handle as typed, judged.
  public var verdict: ProfileName.Verdict {
    ProfileName.check(handleText, taken: existing)
  }

  public var canCreate: Bool {
    verdict.isValid && !creating && created == nil
  }

  /// The bots that can be cloned from: every one on the roster, in its order.
  public var cloneable: [String] { existing }

  // MARK: - Models

  /// `model.options` with `explicit_only`, which keeps the list to providers this gateway is configured
  /// for (`include_unconfigured` would offer models the new bot could never reach). A failure is not an
  /// error the reader needs: without the picker the bot inherits the launch profile's model.
  public func loadModelChoices() async {
    switch modelChoices {
    case .loading, .loaded: return
    case .idle, .unavailable: break
    }

    modelChoices = .loading

    do {
      let reply = try await gateway.request(RPC.ModelOptions.name, ["explicit_only": .bool(true)])

      guard let options = ModelOptionsResult(jsonValue: reply) else {
        modelChoices = .unavailable
        return
      }

      let choices = BotModelChoice.choices(options)
      modelChoices = choices.isEmpty ? .unavailable : .loaded(choices)
    } catch {
      modelChoices = .unavailable
    }
  }

  // MARK: - Creating

  /// Make the bot and resolve its chat. Every failure is kept in `failure`: there is no half-made bot
  /// worth showing when the create fails, and when the later steps fail the bot exists and `create()`
  /// can be pressed again to carry on.
  @discardableResult
  public func create() async -> Created? {
    guard canCreate else {
      return created
    }

    let verdict = self.verdict

    creating = true
    failure = nil

    defer { creating = false }

    do {
      if made == nil {
        let draft = NewBotDraft(handle: verdict.handle, description: botDescription, model: model, cloneFrom: cloneFrom)
        let reply = try await gateway.request(RPC.ProfilesCreate.name, draft.params.json)

        made = ProfilesCreateResult(jsonValue: reply) ?? ProfilesCreateResult(json: [:])
      }

      guard let made else {
        return nil
      }

      // The name the gateway STORED; looking anything up by what was typed would miss.
      let name = made.name.flatMap { $0.isEmpty ? nil : $0 } ?? verdict.handle
      let bots = try await roster.refresh()

      guard let bot = bots.first(where: { $0.name == name }) else {
        failure = .notListed(name)
        return nil
      }

      let chat = try await roster.resolveCanonical(bot)
      let result = Created(
        name: name,
        chat: chat,
        // `model_set` is the explicit pin, `mirrored.model_inherited` the launch profile's. Neither
        // means the bot has nowhere to send a message.
        withoutModel: made.modelSet != true && made.mirrored?.modelInherited != true
      )

      let label = displayName.trimmingCharacters(in: .whitespacesAndNewlines)

      if !label.isEmpty {
        setLabel(name, label)
      }

      created = result

      return result
    } catch {
      failure = .request(BotSettingsFailure.classify(error))
      return nil
    }
  }
}
