import Foundation
import HermieCore
import HermieProtocol

/// The app's own words for the interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`):
/// the sheets' chrome, buttons, notices and the per-field messages. Never what the agent says:
/// that is shown verbatim and marked as the agent's. The strings live in `Native.xcstrings`.
extension NativeStrings {
  enum Interactive {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    // MARK: The frame

    /// {bot} asks you to fill in a form
    static func titleForm(_ bot: String) -> String {
      String(
        localized: "native.interactive.title.form", defaultValue: "\(bot) asks you to fill in a form", table: "Native",
        bundle: .module)
    }
    /// {bot} asks you for a file
    static func titleFile(_ bot: String) -> String {
      String(
        localized: "native.interactive.title.file", defaultValue: "\(bot) asks you for a file", table: "Native",
        bundle: .module)
    }
    /// {bot} asks you to review a draft
    static func titleDraft(_ bot: String) -> String {
      String(
        localized: "native.interactive.title.draft", defaultValue: "\(bot) asks you to review a draft", table: "Native",
        bundle: .module)
    }
    /// {bot} asks you to review changes to a file
    static func titleDiff(_ bot: String) -> String {
      String(
        localized: "native.interactive.title.diff", defaultValue: "\(bot) asks you to review changes to a file",
        table: "Native", bundle: .module)
    }
    /// {bot} says
    static func says(_ bot: String) -> String {
      String(localized: "native.interactive.says", defaultValue: "\(bot) says", table: "Native", bundle: .module)
    }
    /// On behalf of {name}
    static func onBehalfOf(_ name: String) -> String {
      String(
        localized: "native.interactive.onBehalfOf", defaultValue: "On behalf of \(name)", table: "Native", bundle: .module)
    }
    /// Later
    static var later: String { string("native.interactive.later") }
    /// Skip
    static var skip: String { string("native.interactive.skip") }
    /// Send
    static var send: String { string("native.interactive.send") }
    /// Try again
    static var tryAgain: String { string("native.interactive.tryAgain") }
    /// Close
    static var close: String { string("native.interactive.close") }
    /// Don't share
    static var decline: String { string("native.interactive.decline") }
    /// Tells the bot you chose not to give this. It does not ask again at once.
    static var declineHint: String { string("native.interactive.declineHint") }
    /// Your earlier answer did not reach the gateway. Please answer again.
    static var earlierAnswerLost: String { string("native.interactive.earlierAnswerLost") }

    // MARK: Notices

    /// This was answered on another device. Nothing was sent from here.
    static var answeredElsewhere: String { string("native.interactive.notice.answeredElsewhere") }
    /// This device is not allowed to answer this request. Another device has to.
    static var notAllowed: String { string("native.interactive.notice.notAllowed") }
    /// Hermie could not show a request from {bot} and told it so.
    static func cannotShow(_ bot: String) -> String {
      String(
        localized: "native.interactive.notice.cannotShow",
        defaultValue: "Hermie could not show a request from \(bot) and told it so.", table: "Native", bundle: .module)
    }

    // MARK: Refusals

    /// This request cannot be skipped.
    static var refusalNotOptional: String { string("native.interactive.refusal.notOptional") }
    /// Too many files.
    static var refusalTooManyFiles: String { string("native.interactive.refusal.tooManyFiles") }
    /// The files are too large together.
    static var refusalFilesTooLarge: String { string("native.interactive.refusal.filesTooLarge") }
    /// The gateway did not accept one of the files.
    static var refusalFileRefused: String { string("native.interactive.refusal.fileRefused") }
    /// A file is not where the gateway expects it.
    static var refusalOutsideDir: String { string("native.interactive.refusal.outsideDir") }
    /// A file is larger than the gateway allows.
    static var refusalFileTooLarge: String { string("native.interactive.refusal.fileTooLarge") }
    /// The gateway could not read this answer.
    static var refusalBadShape: String { string("native.interactive.refusal.badShape") }
    /// Too many wrong answers: the request was withdrawn.
    static var refusalTooManyAttempts: String { string("native.interactive.refusal.tooManyAttempts") }
    /// The text holds characters that cannot be sent as they are.
    static var refusalNotVerbatim: String { string("native.interactive.refusal.notVerbatim") }
    /// This draft cannot be changed.
    static var refusalEdited: String { string("native.interactive.refusal.edited") }
    /// The gateway did not accept this answer.
    static var refusalOther: String { string("native.interactive.refusal.other") }

    /// The words for a reason the gateway refused an answer with (never the reason itself).
    static func refusal(_ reason: String) -> String {
      switch reason {
      case "bad_shape": refusalBadShape
      case "too_many_attempts": refusalTooManyAttempts
      case "not_optional": refusalNotOptional
      case "files:too_many": refusalTooManyFiles
      case "files:too_large": refusalFilesTooLarge
      case "text:not_verbatim": refusalNotVerbatim
      case "text:edited": refusalEdited
      case _ where reason.hasPrefix("file:") && reason.hasSuffix(":outside_dir"): refusalOutsideDir
      case _ where reason.hasPrefix("file:") && reason.hasSuffix(":too_large"): refusalFileTooLarge
      case _ where reason.hasPrefix("file:"): refusalFileRefused
      default: refusalOther
      }
    }

    // MARK: Form

    enum Form {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// required
      static var required: String { string("native.interactive.form.required") }
      /// Choose a date
      static var chooseDate: String { string("native.interactive.form.chooseDate") }
      /// Choose a time
      static var chooseTime: String { string("native.interactive.form.chooseTime") }
      /// Choose date and time
      static var chooseDateTime: String { string("native.interactive.form.chooseDateTime") }
      /// Choose dates
      static var chooseRange: String { string("native.interactive.form.chooseRange") }
      /// Clear
      static var clear: String { string("native.interactive.form.clear") }
      /// From
      static var from: String { string("native.interactive.form.from") }
      /// To
      static var to: String { string("native.interactive.form.to") }
      /// Choose…
      static var choose: String { string("native.interactive.form.choose") }
      /// None
      static var none: String { string("native.interactive.form.none") }
      /// In time zone {zone}
      static func inZone(_ zone: String) -> String {
        String(
          localized: "native.interactive.form.inZone", defaultValue: "In time zone \(zone)", table: "Native",
          bundle: .module)
      }
      /// {count} of {max} characters
      static func characters(_ count: Int, of limit: Int) -> String {
        String(
          localized: "native.interactive.form.characters", defaultValue: "\(count) of \(limit) characters",
          table: "Native", bundle: .module)
      }
      /// Between {min} and {max}
      static func between(_ min: String, _ max: String) -> String {
        String(
          localized: "native.interactive.form.between", defaultValue: "Between \(min) and \(max)", table: "Native",
          bundle: .module)
      }
      /// At least {min}
      static func atLeast(_ min: String) -> String {
        String(
          localized: "native.interactive.form.atLeast", defaultValue: "At least \(min)", table: "Native", bundle: .module)
      }
      /// At most {max}
      static func atMost(_ max: String) -> String {
        String(
          localized: "native.interactive.form.atMost", defaultValue: "At most \(max)", table: "Native", bundle: .module)
      }
      /// {currency}, whole amounts
      static func wholeAmounts(_ currency: String) -> String {
        String(
          localized: "native.interactive.form.wholeAmounts", defaultValue: "\(currency), whole amounts", table: "Native",
          bundle: .module)
      }
      /// {currency}, up to {decimals} decimals
      static func decimals(_ currency: String, _ decimals: Int) -> String {
        String(
          localized: "native.interactive.form.decimals", defaultValue: "\(currency), up to \(decimals) decimals",
          table: "Native", bundle: .module)
      }
      /// Some fields need your attention.
      static var needAttention: String { string("native.interactive.form.needAttention") }

      /// This is required.
      static var problemMissing: String { string("native.interactive.form.problem.missing") }
      /// That is not in the right format.
      static var problemFormat: String { string("native.interactive.form.problem.format") }
      /// Too long: at most {max} characters.
      static func problemTooLong(_ limit: Int) -> String {
        String(
          localized: "native.interactive.form.problem.tooLong", defaultValue: "Too long: at most \(limit) characters.",
          table: "Native", bundle: .module)
      }
      /// Must be at least {min}.
      static func problemBelowMin(_ min: String) -> String {
        String(
          localized: "native.interactive.form.problem.belowMin", defaultValue: "Must be at least \(min).",
          table: "Native", bundle: .module)
      }
      /// Must be at most {max}.
      static func problemAboveMax(_ max: String) -> String {
        String(
          localized: "native.interactive.form.problem.aboveMax", defaultValue: "Must be at most \(max).",
          table: "Native", bundle: .module)
      }
      /// Must be on or after {date}.
      static func problemBefore(_ min: String) -> String {
        String(
          localized: "native.interactive.form.problem.before", defaultValue: "Must be on or after \(min).",
          table: "Native", bundle: .module)
      }
      /// Must be on or before {date}.
      static func problemAfter(_ max: String) -> String {
        String(
          localized: "native.interactive.form.problem.after", defaultValue: "Must be on or before \(max).",
          table: "Native", bundle: .module)
      }
      /// Enter a whole number.
      static var problemNotInteger: String { string("native.interactive.form.problem.notInteger") }
      /// Must go up in steps of {step} from {base}.
      static func problemStep(_ step: String, _ base: String) -> String {
        String(
          localized: "native.interactive.form.problem.step", defaultValue: "Must go up in steps of \(step) from \(base).",
          table: "Native", bundle: .module)
      }
      /// The end is before the start.
      static var problemOrder: String { string("native.interactive.form.problem.order") }
      /// Choose at least {count}.
      static func problemTooFew(_ count: Int) -> String {
        String(
          localized: "native.interactive.form.problem.tooFew", defaultValue: "Choose at least \(count).",
          table: "Native", bundle: .module)
      }
      /// Choose at most {count}.
      static func problemTooMany(_ count: Int) -> String {
        String(
          localized: "native.interactive.form.problem.tooMany", defaultValue: "Choose at most \(count).",
          table: "Native", bundle: .module)
      }
      /// The gateway did not accept this value.
      static var problemOther: String { string("native.interactive.form.problem.other") }
    }

    // MARK: File

    enum File {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// Scan a document
      static var scan: String { string("native.interactive.file.scan") }
      /// One file
      static var oneFile: String { string("native.interactive.file.oneFile") }
      /// Up to {count} files
      static func upToFiles(_ count: Int) -> String {
        String(
          localized: "native.interactive.file.upToFiles", defaultValue: "Up to \(count) files", table: "Native",
          bundle: .module)
      }
      /// {size} per file
      static func perFile(_ size: String) -> String {
        String(
          localized: "native.interactive.file.perFile", defaultValue: "\(size) per file", table: "Native", bundle: .module)
      }
      /// {size} in total
      static func inTotal(_ size: String) -> String {
        String(
          localized: "native.interactive.file.inTotal", defaultValue: "\(size) in total", table: "Native", bundle: .module)
      }
      /// Camera details and location are removed from photos before they are sent.
      static var stripNote: String { string("native.interactive.file.stripNote") }
      /// No file chosen yet.
      static var noFiles: String { string("native.interactive.file.noFiles") }
      /// Upload and send
      static var uploadAndSend: String { string("native.interactive.file.uploadAndSend") }
      /// Cancel upload
      static var cancelUpload: String { string("native.interactive.file.cancelUpload") }
      /// The upload did not work.
      static var uploadFailed: String { string("native.interactive.file.uploadFailed") }
      /// Give up
      static var giveUp: String { string("native.interactive.file.giveUp") }
      /// Giving up tells the bot that the file could not be sent.
      static var giveUpNote: String { string("native.interactive.file.giveUpNote") }
      /// Your files are uploaded.
      static var uploaded: String { string("native.interactive.file.uploaded") }
      /// Choose other files
      static var changeFiles: String { string("native.interactive.file.changeFiles") }
      /// You can add at most {count} files.
      static func rejectTooMany(_ count: Int) -> String {
        String(
          localized: "native.interactive.file.rejectTooMany", defaultValue: "You can add at most \(count) files.",
          table: "Native", bundle: .module)
      }
      /// {name} is larger than {size}.
      static func rejectTooLarge(_ name: String, _ size: String) -> String {
        String(
          localized: "native.interactive.file.rejectTooLarge", defaultValue: "\(name) is larger than \(size).",
          table: "Native", bundle: .module)
      }
      /// The files together may not be larger than {size}.
      static func rejectTotal(_ size: String) -> String {
        String(
          localized: "native.interactive.file.rejectTotal",
          defaultValue: "The files together may not be larger than \(size).", table: "Native", bundle: .module)
      }
      /// {name} could not be read.
      static func rejectUnreadable(_ name: String) -> String {
        String(
          localized: "native.interactive.file.rejectUnreadable", defaultValue: "\(name) could not be read.",
          table: "Native", bundle: .module)
      }
    }

    // MARK: Draft

    enum Draft {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// Mail
      static var kindMail: String { string("native.interactive.draft.kind.mail") }
      /// Post
      static var kindPost: String { string("native.interactive.draft.kind.post") }
      /// Message
      static var kindMessage: String { string("native.interactive.draft.kind.message") }
      /// Document
      static var kindDocument: String { string("native.interactive.draft.kind.document") }
      /// Draft
      static var kindOther: String { string("native.interactive.draft.kind.other") }
      /// Subject
      static var subject: String { string("native.interactive.draft.subject") }
      /// Recipients
      static var recipients: String { string("native.interactive.draft.recipients") }
      /// Draft text
      static var textLabel: String { string("native.interactive.draft.textLabel") }
      /// Approve
      static var approve: String { string("native.interactive.draft.approve") }
      /// Approve with changes
      static var approveWithChanges: String { string("native.interactive.draft.approveWithChanges") }
      /// Reject…
      static var reject: String { string("native.interactive.draft.reject") }
      /// Reject draft
      static var rejectConfirm: String { string("native.interactive.draft.rejectConfirm") }
      /// Back
      static var back: String { string("native.interactive.draft.back") }
      /// A word for {bot} (optional)
      static func comment(_ bot: String) -> String {
        String(
          localized: "native.interactive.draft.comment", defaultValue: "A word for \(bot) (optional)", table: "Native",
          bundle: .module)
      }
      /// Edited
      static var edited: String { string("native.interactive.draft.edited") }
      /// Undo my changes
      static var revert: String { string("native.interactive.draft.revert") }
      /// This draft cannot be changed. You can approve or reject it.
      static var notEditable: String { string("native.interactive.draft.notEditable") }
      /// The text cannot be sent as it is:
      static var hiddenWarning: String { string("native.interactive.draft.hiddenWarning") }
      /// Nothing is left of the text once whitespace at the ends is removed.
      static var problemEmpty: String { string("native.interactive.draft.problem.empty") }
      /// Characters that do not show as themselves (invisible, direction, special spaces, tabs).
      static var problemCharacters: String { string("native.interactive.draft.problem.characters") }
      /// More than {limit} combining marks on one character.
      static func problemMarks(_ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.problem.marks",
          defaultValue: "More than \(limit) combining marks on one character.", table: "Native", bundle: .module)
      }
      /// From line {line} there are more than {limit} blank lines in a row.
      static func problemBlankLines(_ line: Int, _ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.problem.blankLines",
          defaultValue: "From line \(line) there are more than \(limit) blank lines in a row.", table: "Native",
          bundle: .module)
      }
      /// Line {line} is longer than {limit} characters.
      static func problemLineTooLong(_ line: Int, _ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.problem.lineTooLong",
          defaultValue: "Line \(line) is longer than \(limit) characters.", table: "Native", bundle: .module)
      }
      /// Line {line} is indented by more than {limit} spaces.
      static func problemIndent(_ line: Int, _ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.problem.indent",
          defaultValue: "Line \(line) is indented by more than \(limit) spaces.", table: "Native", bundle: .module)
      }
      /// Line {line} has more than {limit} spaces in a row.
      static func problemSpaceRun(_ line: Int, _ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.problem.spaceRun",
          defaultValue: "Line \(line) has more than \(limit) spaces in a row.", table: "Native", bundle: .module)
      }
      /// Correct the text yourself: nothing is changed for you.
      static var correctNote: String { string("native.interactive.draft.correctNote") }
      /// Lines are not wrapped; scroll sideways for a long line.
      static var noWrapHint: String { string("native.interactive.draft.noWrapHint") }
      /// Invisible characters are shown as codes in brackets.
      static var hiddenLegend: String { string("native.interactive.draft.hiddenLegend") }
      /// The text is longer than {max} characters.
      static func tooLong(_ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.tooLong", defaultValue: "The text is longer than \(limit) characters.",
          table: "Native", bundle: .module)
      }
      /// The comment is longer than {max} characters.
      static func commentTooLong(_ limit: Int) -> String {
        String(
          localized: "native.interactive.draft.commentTooLong",
          defaultValue: "The comment is longer than \(limit) characters.", table: "Native", bundle: .module)
      }

      static func kind(_ kind: DraftKind?) -> String {
        switch kind {
        case .mail?: kindMail
        case .post?: kindPost
        case .message?: kindMessage
        case .document?: kindDocument
        default: kindOther
        }
      }
    }

    // MARK: Diff

    enum Diff {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// Changes to a file
      static var kindModify: String { string("native.interactive.diff.kind.modify") }
      /// New file
      static var kindNew: String { string("native.interactive.diff.kind.new") }
      /// Delete file
      static var kindDelete: String { string("native.interactive.diff.kind.delete") }
      /// Renamed file
      static var kindRename: String { string("native.interactive.diff.kind.rename") }
      /// Renamed from
      static var renamedFrom: String { string("native.interactive.diff.renamedFrom") }
      /// Renamed to
      static var renamedTo: String { string("native.interactive.diff.renamedTo") }
      /// Start of the file
      static var anchorStart: String { string("native.interactive.diff.anchor.start") }
      /// End of the file
      static var anchorEnd: String { string("native.interactive.diff.anchor.end") }
      /// Whole file
      static var anchorBoth: String { string("native.interactive.diff.anchor.both") }
      /// Change {number} of {total}
      static func hunkTitle(_ number: Int, of total: Int) -> String {
        String(
          localized: "native.interactive.diff.hunk.title", defaultValue: "Change \(number) of \(total)",
          table: "Native", bundle: .module)
      }
      /// {added} added, {removed} removed
      static func hunkStats(added: Int, removed: Int) -> String {
        String(
          localized: "native.interactive.diff.hunk.stats", defaultValue: "\(added) added, \(removed) removed",
          table: "Native", bundle: .module)
      }
      /// Approve
      static var approve: String { string("native.interactive.diff.hunk.approve") }
      /// Reject
      static var reject: String { string("native.interactive.diff.hunk.reject") }
      /// Approve change {number}
      static func approveHunk(_ number: Int) -> String {
        String(
          localized: "native.interactive.diff.hunk.approveLabel", defaultValue: "Approve change \(number)",
          table: "Native", bundle: .module)
      }
      /// Reject change {number}
      static func rejectHunk(_ number: Int) -> String {
        String(
          localized: "native.interactive.diff.hunk.rejectLabel", defaultValue: "Reject change \(number)",
          table: "Native", bundle: .module)
      }
      /// Approve all
      static var approveAll: String { string("native.interactive.diff.approveAll") }
      /// Reject all
      static var rejectAll: String { string("native.interactive.diff.rejectAll") }
      /// Decided: {decided} of {total}
      static func progress(decided: Int, total: Int) -> String {
        String(
          localized: "native.interactive.diff.progress", defaultValue: "Decided: \(decided) of \(total)",
          table: "Native", bundle: .module)
      }
      /// {approved} approved, {rejected} rejected
      static func tally(approved: Int, rejected: Int) -> String {
        String(
          localized: "native.interactive.diff.tally", defaultValue: "\(approved) approved, \(rejected) rejected",
          table: "Native", bundle: .module)
      }
      /// Send decisions
      static var send: String { string("native.interactive.diff.send") }
      /// Decide every change to send.
      static var decideEveryHunk: String { string("native.interactive.diff.decideEveryHunk") }
      /// A change that is not marked as the start or the end of the file shows the agent's line numbers…
      static var agentsLineNumbers: String { string("native.interactive.diff.agentsLineNumbers") }
      /// Some lines are wider than the view. Scroll sideways to read them.
      static var overflowNote: String { string("native.interactive.diff.overflowNote") }
      /// Added
      static var lineAdded: String { string("native.interactive.diff.line.added") }
      /// Removed
      static var lineRemoved: String { string("native.interactive.diff.line.removed") }
      /// Unchanged
      static var lineUnchanged: String { string("native.interactive.diff.line.unchanged") }
      /// empty line
      static var lineEmpty: String { string("native.interactive.diff.line.empty") }
      /// tab
      static var tabWord: String { string("native.interactive.diff.line.tab") }
      /// No newline at end of file
      static var noNewline: String { string("native.interactive.diff.line.noNewline") }
    }

    // MARK: The transcript's card

    enum Card {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// Form
      static var form: String { string("native.interactive.card.form") }
      /// File
      static var file: String { string("native.interactive.card.file") }
      /// Draft review
      static var draft: String { string("native.interactive.card.draft") }
      /// Change review
      static var diff: String { string("native.interactive.card.diff") }
      /// Approved changes: {approved} of {total}
      static func diffApproved(_ approved: Int, of total: Int) -> String {
        String(
          localized: "native.interactive.card.diffApproved", defaultValue: "Approved changes: \(approved) of \(total)",
          table: "Native", bundle: .module)
      }
      /// Waiting for your answer
      static var open: String { string("native.interactive.card.open") }
      /// Answered
      static var answered: String { string("native.interactive.card.answered") }
      /// Skipped
      static var skipped: String { string("native.interactive.card.skipped") }
      /// Files sent: {count}
      static func files(_ count: Int) -> String {
        String(
          localized: "native.interactive.card.files", defaultValue: "Files sent: \(count)", table: "Native",
          bundle: .module)
      }
      /// Approved
      static var approved: String { string("native.interactive.card.approved") }
      /// Approved with changes
      static var approvedEdited: String { string("native.interactive.card.approvedEdited") }
      /// Rejected
      static var rejected: String { string("native.interactive.card.rejected") }
      /// Timed out
      static var timedOut: String { string("native.interactive.card.timedOut") }
      /// Ended without an answer
      static var ended: String { string("native.interactive.card.ended") }
      /// Answered on another device
      static var answeredElsewhere: String { string("native.interactive.card.answeredElsewhere") }
      /// Open
      static var openAction: String { string("native.interactive.card.openAction") }
    }
  }
}
