import Foundation

// The composer's reusable prompts (NX-13): the lines `/` offers after the commands, and putting a
// prompt's text in the field, through the form for its fields when it has any.
//
// A prompt is only ever TEXT FOR THE FIELD. Taking one never sends anything and never runs a
// command: the person reads what arrived and sends it themselves, like anything else they typed.

extension ComposerModel {
  // MARK: - In the list `/` opens

  /// The lines for the prompts a name being typed after the slash matches: titles that begin with
  /// it first, then titles that contain it, each group in the person's order. An empty query is every
  /// prompt of this chat.
  func promptSuggestions(matching query: String, limit: Int = 30) -> [SlashSuggestion] {
    let available = prompts?.available(for: bot) ?? []
    let wanted = query.trimmingCharacters(in: .whitespaces).lowercased()
    var scored: [(score: Int, order: Int, prompt: Prompt)] = []

    for (order, prompt) in available.enumerated() {
      let title = prompt.title.lowercased()

      if wanted.isEmpty {
        scored.append((0, order, prompt))
      } else if title.hasPrefix(wanted) {
        scored.append((0, order, prompt))
      } else if title.contains(wanted) {
        scored.append((1, order, prompt))
      }
    }

    scored.sort { $0.score != $1.score ? $0.score < $1.score : $0.order < $1.order }

    return scored.prefix(limit).map { _, _, prompt in
      SlashSuggestion(
        label: prompt.title,
        hint: prompt.fields.isEmpty ? nil : prompt.fields.map { "{\($0)}" }.joined(separator: " "),
        detail: Self.preview(of: prompt.text),
        kind: .prompt,
        insert: "",
        promptID: prompt.id
      )
    }
  }

  /// The first line of a prompt's text, short, for the list.
  static func preview(of text: String) -> String {
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""

    return String(line.trimmingCharacters(in: .whitespaces).prefix(80))
  }

  /// What this person calls the bot of this chat, for the prompt button's list.
  public var botDisplayName: String { session?.chatName(bot) ?? bot }

  // MARK: - Using one

  /// Use a prompt (a line of the list, or a row of the prompt button): with fields the form is
  /// asked for (`promptToFill`), without them the text goes into the field at once. Refused while a
  /// request has the composer (`held`), like typing.
  ///
  /// `fromSlashList` is a pick from the list `/` opens: the words of the slash line that found it are
  /// not part of the message and go when the prompt lands, and ONLY then. With a form that is when it
  /// is filled in; put away, the draft stays exactly as it was typed. A pick from the button leaves the
  /// draft alone.
  public func use(_ prompt: Prompt, fromSlashList: Bool = false) {
    guard !held else {
      return
    }

    let slashLine = fromSlashList && SlashStage(draft: draft) != nil ? draft : nil

    if prompt.fields.isEmpty {
      if slashLine != nil {
        putDraft("")
      }

      insertPromptText(prompt.filled(with: [:]))
    } else {
      pendingSlashLine = slashLine
      promptToFill = prompt

      // The list is behind the form: it stays shut until the person types again.
      if slashLine != nil {
        dismissSuggestions()
      }
    }
  }

  /// Use the prompt with this id (a line of the list).
  func usePrompt(id: String) {
    if let prompt = prompts?.prompt(id: id) {
      use(prompt, fromSlashList: true)
    }
  }

  /// The form was filled in: the prompt's text, with the values in, goes into the field.
  public func completePrompt(with values: [String: String]) {
    guard let prompt = promptToFill else {
      return
    }

    promptToFill = nil

    // The slash line that found it goes now, if it is still what the field holds.
    if let line = pendingSlashLine, draft == line {
      putDraft("")
    }

    pendingSlashLine = nil
    insertPromptText(prompt.filled(with: values))
  }

  /// The form was put away: nothing goes into the field, and the draft is as it was.
  public func cancelPrompt() {
    promptToFill = nil
    pendingSlashLine = nil
  }

  /// Put text in the field and give it the caret: an empty field takes it as it is, a field with words
  /// in it gets it on a new line after them (what was typed is never replaced). The field is set from
  /// outside, so the command list stays shut. False, and nothing changed, while a request has the
  /// composer or the text is only space.
  @discardableResult
  public func insertPromptText(_ text: String) -> Bool {
    guard !held, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return false
    }

    if trimmedDraft.isEmpty {
      putDraft(text)
    } else {
      putDraft(draft + (draft.hasSuffix("\n") ? "" : "\n") + text)
    }

    focusRequests += 1
    return true
  }
}
