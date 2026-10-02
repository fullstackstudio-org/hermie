import Foundation
import HermieProtocol

// The keys reconciliation pairs items on (the second half of `rows-to-items.ts`).

/// The comparison form of a piece of message text.
///
/// Reconciliation pairs a live item with the row that persisted it, and text is
/// the only thing the two have in common — `prompt.submit` answers with a status,
/// never a row id. So every difference that is not a difference in what the
/// message SAYS has to be normalised away here: the blank lines of a
/// multi-paragraph prompt, `\r\n` against `\n`, whatever the composer or the
/// gateway trimmed off the ends, and the Unicode form, because a keyboard that
/// writes `e` + U+0301 and one that writes U+00E9 wrote the same word.
///
/// `text.replace(/\s+/gu, ' ').trim().normalize('NFC')`, written as one pass over
/// the code units: every run of JavaScript whitespace becomes one space, and the
/// trim then only has a single space to take off either end.
public func normalizeMatchText(_ text: String) -> String {
  var units: [UInt16] = []
  units.reserveCapacity(text.utf16.count)
  var inRun = false

  for unit in text.utf16 {
    if JS.isWhitespace(unit) {
      if !inRun {
        units.append(0x20)
        inRun = true
      }
    } else {
      units.append(unit)
      inRun = false
    }
  }

  if units.last == 0x20 { units.removeLast() }
  if units.first == 0x20 { units.removeFirst() }

  let collapsed = String(decoding: units, as: UTF16.self)

  // ASCII is its own NFC; skip Foundation's normaliser for the common case.
  if units.allSatisfy({ $0 < 0x80 }) {
    return collapsed
  }

  return collapsed.precomposedStringWithCanonicalMapping
}

/// The name at the end of an attachment reference.
///
/// `@file:"/srv/work/uploads/hermie/2026-09-20/8setj4h3-ui.xml"` → `8setj4h3-ui.xml`.
///
/// The path is the half of a reference two descriptions of one send can disagree
/// about, and it is not always anybody's fault: an image goes over
/// `image.attach_bytes`, so the GATEWAY decides where it lands and writes
/// `@image:<its path>` into the row, while the client only ever knew the name it
/// handed over. The name is what both always have, so the name is what pairing
/// compares — and, in the chat kit, what the chip shows.
public func attachmentRefName(_ reference: String) -> String {
  let raw = RowPatterns.refQuotes.replaceAll(
    in: RowPatterns.attachmentScheme.replaceFirst(in: reference, with: ""),
    with: ""
  )
  let last = RowPatterns.pathSeparator.split(raw).last ?? ""

  return last.isEmpty ? raw : last
}

/// `file` or `image`: a picture of a diagram is not the diagram's source.
private func attachmentRefKind(_ reference: String) -> String {
  RowPatterns.attachmentScheme.exec(reference)?[1] ?? "file"
}

/// The comparison form of what a turn carries.
///
/// Sorted, because the set is what identifies the send and the order the two
/// sides happen to list it in is not: a file's reference is in the prompt where
/// the composer put it, and an image's is appended by the gateway afterwards.
/// Empty for a turn that carries nothing, which is the signal that text alone
/// decides.
public func attachmentsMatchKey(_ references: [String]?) -> String {
  guard let references, !references.isEmpty else {
    return ""
  }

  let keys = JS.unique(references.map { "\(attachmentRefKind($0)):\(attachmentRefName($0))" })

  // A unit separator rather than a comma: a file name may contain one.
  // `.sort()` with no comparator orders by UTF-16 code unit.
  return keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.joined(separator: "\u{1F}")
}

/// A row matcher used by reconciliation: the text two transports agree on.
public func normalizedItemText(_ item: TranscriptItem) -> String {
  let text: String

  switch item {
  case .user(let user): text = user.text
  case .assistant(let assistant): text = assistant.text
  case .botDmIn(let inbound): text = inbound.text
  case .notice(let notice):
    // The BODY, and the title only when there is no body.
    //
    // A notice's title is whatever the surface decided to call it, and the
    // two descriptions of one row do not have to agree on that: the gateway
    // ships its own (`display_metadata.display_text`) on the persisted row,
    // and a live projection reading the same text off `inflight` cannot know
    // it. What they always agree on is what the notice SAYS, so that is the
    // key. A notice with no body keeps the title as its only identity.
    if let body = notice.body, !JS.trim(body).isEmpty {
      text = body
    } else {
      text = notice.title
    }
  case .status(let status): text = status.text
  // Both transports parse the same header into the same name and body,
  // so this is the key that pairs a live cron card with its persisted
  // row instead of letting the row land as a second card.
  case .cronDelivery(let cron): text = "\(cron.jobName)\n\(cron.body)"
  /*
    The message that was dispatched.

    A dispatch used to have no text key at all, so the ONLY thing
    that could pair the live row with the persisted one was the tool
    id — and a gateway that re-keys a call on the way to its
    database, or drops the id from the history projection (where
    `rows-to-items` falls back to `row-<index>`), leaves the two with
    no id in common. The reader then had the same errand twice, and
    the copies MOVED apart: only one of them has a row id, so
    `inRowOrder` sorts the other by whatever row happens to be above
    it, and that changes as the turn goes on.

    The target is not in here but in `itemMatchKey`, for the reason
    the attachments are: it has to be able to disagree on its own.
  */
  case .botDmOut(let outbound): text = outbound.message
  default: text = ""
  }

  return normalizeMatchText(text)
}

/// What an item carries besides its text (the second line of `itemMatchKey`).
private func carriedKey(_ item: TranscriptItem) -> String {
  switch item {
  case .user(let user):
    return attachmentsMatchKey(user.attachments)
  // The teammate a dispatch went to. Two errands worded the same way but
  // sent to two different bots are two rows, and a key made of the message
  // alone would have called them one.
  case .botDmOut(let outbound):
    return outbound.targetHandle.isEmpty ? JS.lower(outbound.target) : outbound.targetHandle
  default:
    return ""
  }
}

/// Everything about an item that two descriptions of it have to agree on: what it
/// says, and what it carries.
///
/// Text alone was enough until a turn arrived with no text. A send whose whole
/// body is a `@file:` reference projects to the empty string — the directive is
/// plumbing, so the projection lifts it out — and then the attachments are the
/// only thing left that identifies it. They also have to be ABLE to disagree:
/// two file-only sends carrying different files are two turns, and a key made of
/// text alone would have called them one.
public func itemMatchKey(_ item: TranscriptItem) -> String {
  "\(normalizedItemText(item))\n\(carriedKey(item))"
}

/// Whether an item says or carries enough to be paired on at all.
public func isMatchable(_ item: TranscriptItem) -> Bool {
  if !normalizedItemText(item).isEmpty {
    return true
  }

  guard case .user(let user) = item else {
    return false
  }

  return !attachmentsMatchKey(user.attachments).isEmpty
}

/// `isMatchable(item) ? matchKeyOf(item) : undefined` (`reconcile.ts`), the text
/// normalised once rather than once per question.
///
/// The last-resort pairing key: the kind, the text, and the attachments. The
/// attachments are in it because a send can have no text to pair on at all — a
/// turn whose whole body was a `@file:` reference projects to the empty string,
/// and the file is then the only thing identifying it.
func matchKeyIfMatchable(_ item: TranscriptItem) -> String? {
  let text = normalizedItemText(item)
  let carried = carriedKey(item)

  // `carried` is non-empty without text only for a user's attachments or a
  // dispatch's target; only the first makes an item matchable.
  guard !text.isEmpty || (item.asUser != nil && !carried.isEmpty) else {
    return nil
  }

  return "\(item.kind.rawValue)\n\(text)\n\(carried)"
}
