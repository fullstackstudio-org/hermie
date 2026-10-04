import Foundation
import HermieStore
import Testing

@testable import HermieCore

/// Dictation as a state machine over a fake recogniser: where the words go, and what happens when the
/// recogniser says no. No microphone, no audio, no speech framework.
@Suite(.timeLimit(.minutes(1))) @MainActor struct DictationTests {
  /// A field the test can read, and a model over it.
  private final class Field {
    var text: String
    init(_ text: String = "") { self.text = text }
  }

  private func make(
    _ engine: FakeRecogniser = FakeRecogniser(), field: Field = Field(), language: String = VoiceSettings.automatic
  ) -> (model: DictationModel, engine: FakeRecogniser, field: Field) {
    let model = DictationModel(
      engine: engine,
      language: { language },
      field: DictationField(read: { field.text }, write: { field.text = $0 })
    )
    return (model, engine, field)
  }

  // MARK: Where the words go

  @Test func anAnchorAddsAFreshTranscriptAfterWhatWasThere() {
    #expect(DictationAnchor(base: "").applying("hello") == "hello")
    #expect(DictationAnchor(base: "I said").applying("hello") == "I said hello")
    #expect(DictationAnchor(base: "I said ").applying("hello") == "I said hello", "no second space")
    #expect(DictationAnchor(base: "line\n").applying("next") == "line\nnext")
    #expect(DictationAnchor(base: "keep").applying("   ") == "keep", "nothing heard is the draft as it was")
  }

  @Test func partialResultsReplaceTheirOwnLastGuessInsteadOfAppendingToIt() async {
    let (model, engine, field) = make(field: Field("Dear team,"))

    await model.start()
    engine.hear("recognise")
    #expect(field.text == "Dear team, recognise")
    engine.hear("recognise their")
    #expect(field.text == "Dear team, recognise their")
    engine.hearFinal("recognise there work")
    #expect(field.text == "Dear team, recognise there work")
    engine.end()

    #expect(model.phase == .idle)
    #expect(field.text == "Dear team, recognise there work")
  }

  @Test func theSessionStartsWithTheLanguageTheReaderChose() async {
    let (auto, autoEngine, _) = make()
    await auto.start()
    #expect(autoEngine.starts == [nil], "the device's own language is no tag at all")

    let (dutch, dutchEngine, _) = make(language: "nl-NL")
    await dutch.start()
    #expect(dutchEngine.starts == ["nl-NL"])
  }

  // MARK: Permission

  @Test func theMicrophoneIsNotOpenedUntilThePermissionIsGranted() async {
    let engine = FakeRecogniser()
    engine.permission = .denied
    let (model, _, field) = make(engine)

    await model.start()

    #expect(engine.permissionAsks == 1)
    #expect(engine.starts.isEmpty)
    #expect(model.phase == .failed(.permission))
    #expect(field.text.isEmpty)
  }

  @Test func aDeviceWithNoRecogniserIsSaidToBeUnavailable() async {
    let engine = FakeRecogniser()
    engine.isAvailable = false
    let (model, _, _) = make(engine)

    #expect(!model.isAvailable)
    await model.start()
    #expect(model.phase == .failed(.unavailable))
    #expect(engine.permissionAsks == 0, "no prompt for a feature the device does not have")
  }

  @Test func permissionAnsweredUnavailableIsUnavailableToo() async {
    let engine = FakeRecogniser()
    engine.permission = .unavailable
    let (model, _, _) = make(engine)

    await model.start()
    #expect(model.phase == .failed(.unavailable))
    #expect(engine.starts.isEmpty)
  }

  @Test func aTapWhileThePromptIsUpCancelsAndTheLateAnswerStartsNothing() async {
    let engine = FakeRecogniser()
    engine.holdsPermission = true
    let (model, _, _) = make(engine)

    let starting = Task { await model.start() }
    await Task.yield()
    while engine.permissionAsks == 0 { await Task.yield() }

    #expect(model.phase == .starting)
    await model.toggle()
    #expect(model.phase == .idle)

    engine.answerPermission()
    await starting.value

    #expect(engine.starts.isEmpty, "a session that began after its cancel would listen with no one asking")
    #expect(model.phase == .idle)
  }

  // MARK: Ending

  @Test func aSecondTapStopsAndTheFinalResultStillLands() async {
    let (model, engine, field) = make()

    await model.toggle()
    #expect(model.isListening)
    engine.hear("send the report")

    await model.toggle()
    #expect(engine.stops == 1)
    #expect(model.isListening, "still waiting for the final result")

    engine.hearFinal("send the report today")
    engine.end()
    #expect(field.text == "send the report today")
    #expect(model.phase == .idle)
  }

  @Test func aSessionThatHeardNothingSaysSoAndLeavesTheDraftAlone() async {
    let (model, engine, field) = make(field: Field("typed before"))

    await model.start()
    model.stop()
    engine.end()

    #expect(model.phase == .failed(.noSpeech))
    #expect(field.text == "typed before")
  }

  @Test func theRecognisersFailuresAreKeptForTheReaderToSee() async {
    let (model, engine, _) = make()

    await model.start()
    engine.fail(.failed)
    engine.end()
    #expect(model.failure == .failed)

    model.clearFailure()
    #expect(model.phase == .idle)

    // The next tap tries again.
    await model.toggle()
    #expect(model.isListening)
    #expect(engine.starts.count == 2)
  }

  @Test func whatIsSaidAfterACancelBelongsToNoOne() async {
    let (model, engine, field) = make(field: Field("keep"))

    await model.start()
    engine.hear("first")
    let stale = engine.keepEvents()

    model.cancel()
    #expect(engine.aborts == 1)
    #expect(model.phase == .idle)
    #expect(field.text == "keep first", "what was already written stays")

    // A recogniser can report for a session that has been replaced; a new one is running now.
    await model.start()
    stale?.onPartial("from the old session")
    stale?.onEnd()
    #expect(field.text == "keep first")
    #expect(model.isListening, "the old end does not end the new session")

    engine.hear("second")
    #expect(field.text == "keep first second", "anchored to the draft as it stood when the new session began")
  }

  @Test func theAppLeavingTheFrontClosesTheMicrophone() async {
    let (model, engine, _) = make()

    await model.start()
    model.sceneChanged(active: true)
    #expect(model.isListening)

    model.sceneChanged(active: false)
    #expect(engine.aborts == 1)
    #expect(model.phase == .idle)
  }

  @Test func theLanguageSaysWhetherItCanBeRecognisedHere() {
    let engine = FakeRecogniser()
    let (model, _, _) = make(engine)

    #expect(model.processing == .onDevice)
    engine.onDevice = .unavailable
    #expect(model.processing == .unavailable)
  }
}
