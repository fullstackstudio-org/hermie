import Foundation
import HermieStore
import Testing

@testable import HermieCore

/// The microphone on a real composer: dictated words go into its draft and nowhere else, and anything
/// that changes the draft from outside, or covers the composer, ends the session.
@Suite(.timeLimit(.minutes(1))) @MainActor struct ComposerDictationTests {
  private func make() throws -> (composer: ComposerModel, engine: FakeRecogniser, model: DictationModel, shutdown: () async -> Void) {
    let keyValues = try KeyValueStore(store: SQLiteStore(.inMemory))
    let harness = SessionHarness(keyValues: keyValues)
    let composer = ComposerModel(
      chat: harness.session.chat(Fixture.profile),
      gatewayID: "g1",
      session: harness.session,
      drafts: keyValues,
      debounce: .zero
    )
    let engine = FakeRecogniser()
    let model = composer.enableDictation(engine: engine, settings: VoiceSettings())
    return (composer, engine, model, { await harness.session.shutdown() })
  }

  @Test func dictatedWordsGoIntoTheDraftAfterWhatWasTyped() async throws {
    let (composer, engine, model, shutdown) = try make()
    composer.draft = "Remind me to"

    await model.start()
    engine.hear("call")
    engine.hear("call the plumber")

    #expect(composer.draft == "Remind me to call the plumber")
    #expect(model.isListening, "writing the field is not a change from outside")
    #expect(composer.dictation === model)
    await shutdown()
  }

  @Test func dictatedWordsNeverOpenTheCommandList() async throws {
    let (composer, engine, model, shutdown) = try make()

    await model.start()
    engine.hear("/new")

    #expect(composer.draft == "/new")
    #expect(!composer.suggestionsOpen, "only typing opens the list")
    await shutdown()
  }

  @Test func typingWhileListeningEndsTheSessionAndKeepsWhatWasWritten() async throws {
    let (composer, engine, model, shutdown) = try make()

    await model.start()
    engine.hear("hello there")
    composer.draft = "hello there, friend"

    #expect(!model.isActive)
    #expect(engine.aborts == 1)
    #expect(composer.draft == "hello there, friend", "a result that came after would have overwritten it")
    await shutdown()
  }

  @Test func sendingTheDraftEndsTheSessionSoItsLastResultCannotPutTheSentenceBack() async throws {
    let (composer, engine, model, shutdown) = try make()

    await model.start()
    engine.hear("ship it")
    composer.draft = ""

    #expect(!model.isActive)
    engine.hearFinal("ship it now")
    #expect(composer.draft.isEmpty)
    await shutdown()
  }

  @Test func aRequestOverTheComposerEndsTheSessionAndRefusesWhatIsStillSaid() async throws {
    let (composer, engine, model, shutdown) = try make()

    await model.start()
    engine.hear("my password is")
    let events = engine.keepEvents()

    composer.held = true
    #expect(!model.isActive)

    events?.onPartial("my password is hunter2")
    #expect(composer.draft == "my password is", "nothing is written while a request has the composer")

    // And nothing starts while it does: the field is off, and so is the microphone's way into it.
    await model.start()
    #expect(!model.isActive)
    #expect(engine.starts.count == 1, "the microphone is not opened for a field that is off")
    #expect(composer.draft == "my password is")
    await shutdown()
  }
}
