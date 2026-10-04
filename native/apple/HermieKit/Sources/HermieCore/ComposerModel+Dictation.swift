import Foundation

extension ComposerModel {
  /**
   Give the composer a microphone. Dictated words go into the field as the recogniser hears them
   (`DictationModel`), and nowhere else: nothing is sent by the microphone, and nothing is written while
   a request has the composer (`held`), where a field may be read as the answer to a secure prompt.

   Returns the model so the screen can hand it to the views. Called once per screen.
   */
  @discardableResult
  public func enableDictation(engine: any DictationEngine, settings: VoiceSettings) -> DictationModel {
    let model = DictationModel(
      engine: engine,
      language: { settings.dictationLanguage },
      field: DictationField(
        read: { [weak self] in self?.draft ?? "" },
        write: { [weak self] text in self?.writeDictated(text) }
      )
    )

    model.blocked = { [weak self] in self?.held ?? true }
    dictation = model
    return model
  }

  /// The field as dictation sets it: not typing (no completion list opens), not a change from outside
  /// (which would end the very session that is writing).
  private func writeDictated(_ text: String) {
    guard !held else {
      return
    }

    dictationWriting = true
    putDraft(text)
    dictationWriting = false
  }
}
