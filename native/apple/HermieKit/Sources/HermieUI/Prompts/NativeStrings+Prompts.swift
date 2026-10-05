import Foundation
import HermieCore

/// The reusable prompts' own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Prompts {
    /// Prompts (the Settings category, the bot settings row, the composer's button)
    static var title: String { String(localized: "native.prompts.title", table: "Native", bundle: .module) }
    /// Texts you use again and again, with fields to fill in. (under the Settings category)
    static var blurb: String { String(localized: "native.prompts.blurb", table: "Native", bundle: .module) }
    /// For every bot (header of the prompts every chat offers)
    static var global: String { String(localized: "native.prompts.global", table: "Native", bundle: .module) }
    /// For {bot} (header of one bot's own prompts)
    static func forBot(_ bot: String) -> String {
      String(localized: "native.prompts.forBot", defaultValue: "For \(bot)", table: "Native", bundle: .module)
    }
    /// Per bot (header of the list of bots)
    static var perBot: String { String(localized: "native.prompts.perBot", table: "Native", bundle: .module) }
    /// Add prompt
    static var add: String { String(localized: "native.prompts.add", table: "Native", bundle: .module) }
    /// New prompt (the editor's title)
    static var new: String { String(localized: "native.prompts.new", table: "Native", bundle: .module) }
    /// Edit prompt (the editor's title)
    static var edit: String { String(localized: "native.prompts.edit", table: "Native", bundle: .module) }
    /// Title (the field)
    static var fieldTitle: String { String(localized: "native.prompts.fieldTitle", table: "Native", bundle: .module) }
    /// Short name (the title field's placeholder)
    static var titlePlaceholder: String {
      String(localized: "native.prompts.titlePlaceholder", table: "Native", bundle: .module)
    }
    /// Prompt (the text field's label)
    static var fieldText: String { String(localized: "native.prompts.fieldText", table: "Native", bundle: .module) }
    /// Put {{name}} where something is filled in each time, for example {{topic}}. The same name twice is one field. (under the text)
    static var help: String { String(localized: "native.prompts.help", table: "Native", bundle: .module) }
    /// Fields: {names}
    static func fields(_ names: String) -> String {
      String(localized: "native.prompts.fields", defaultValue: "Fields: \(names)", table: "Native", bundle: .module)
    }
    /// Save
    static var save: String { String(localized: "native.prompts.save", table: "Native", bundle: .module) }
    /// Delete
    static var delete: String { String(localized: "native.prompts.delete", table: "Native", bundle: .module) }
    /// Delete this prompt?
    static var deleteConfirm: String {
      String(localized: "native.prompts.deleteConfirm", table: "Native", bundle: .module)
    }
    /// Move up
    static var moveUp: String { String(localized: "native.prompts.moveUp", table: "Native", bundle: .module) }
    /// Move down
    static var moveDown: String { String(localized: "native.prompts.moveDown", table: "Native", bundle: .module) }
    /// No prompts yet.
    static var none: String { String(localized: "native.prompts.none", table: "Native", bundle: .module) }
    /// Prompts follow you to your other devices on this gateway. (footer)
    static var syncNote: String { String(localized: "native.prompts.syncNote", table: "Native", bundle: .module) }
    /// Prompts can be added once the gateway has connected.
    static var notReady: String { String(localized: "native.prompts.notReady", table: "Native", bundle: .module) }
    /// You have reached the limit of {count} prompts.
    static func limit(_ count: Int) -> String {
      String(
        localized: "native.prompts.limit", defaultValue: "You have reached the limit of \(count) prompts.",
        table: "Native", bundle: .module)
    }
    /// Also offered here: {count} for every bot. (on a bot's page)
    static func alsoGlobal(_ count: Int) -> String {
      String(
        localized: "native.prompts.alsoGlobal", defaultValue: "Also offered here: \(count) for every bot.",
        table: "Native", bundle: .module)
    }
    /// Fill in the prompt (the form's title)
    static var fillTitle: String { String(localized: "native.prompts.fill.title", table: "Native", bundle: .module) }
    /// Insert (puts the filled-in prompt into the message field)
    static var insert: String { String(localized: "native.prompts.fill.insert", table: "Native", bundle: .module) }
    /// Preview
    static var preview: String { String(localized: "native.prompts.fill.preview", table: "Native", bundle: .module) }

    /// In the composer.
    enum Composer {
      /// Insert a prompt (the button's label and the picker's title)
      static var button: String { String(localized: "native.prompts.composer.button", table: "Native", bundle: .module) }
      /// Nothing is sent: the text goes into the message field. (the button's hint)
      static var hint: String { String(localized: "native.prompts.composer.hint", table: "Native", bundle: .module) }
      /// Prompts (header of the section in the list `/` opens)
      static var section: String { String(localized: "native.prompts.composer.section", table: "Native", bundle: .module) }
      /// Puts the prompt in the message field. (hint of a line in that list)
      static var insertHint: String {
        String(localized: "native.prompts.composer.insertHint", table: "Native", bundle: .module)
      }
      /// You have no prompts yet. Add some under Settings, Prompts, or in a bot's settings. (empty picker)
      static var empty: String { String(localized: "native.prompts.composer.empty", table: "Native", bundle: .module) }
    }
  }
}
