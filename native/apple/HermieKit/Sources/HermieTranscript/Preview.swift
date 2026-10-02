import HermieProtocol

// The one line a chat-list row shows under the bot's name (`preview.ts`)
// =====================================================================
//
// There are two sources for it and they are not equally good:
//
//  - the TRANSCRIPT, when this client has one for that bot — cached from a
//    previous run, or live because the chat is attached. It is the full item
//    model, so "the last thing somebody said" is a question it can actually
//    answer;
//  - the gateway's own `canonical_session.preview` string, which is the raw text
//    of the last row and nothing else. No kind, no author, no metadata.
//
// The second is why a row read `[System: The active model for th…`. The gateway
// had written a model-switch marker on the `user` role, that row was the newest,
// and its text went into the preview verbatim — forty characters of a wrapper
// addressed to the model, in the place where the reader looks for what the
// conversation is about.
//
// So: prefer the transcript, and take the last REAL message from it — a bubble
// the owner typed, a reply the bot gave, a teammate's DM, a cron report. A
// notice is not a message and is walked past. When only the gateway's string is
// available, run it through the same recognisers the transcript uses and, if it
// turns out to be scaffolding, show the scaffolding's own words with the wrapper
// taken off — marked `system: true`, so the row can draw it in a quieter style
// than speech rather than pretending somebody said it.
//
// What is deliberately NOT done here: showing the row as empty when the only
// thing in the chat is scaffolding. A chat whose last row is a model switch has
// had something happen in it, and a blank line says less than the switch does.

public struct ChatPreview: Sendable, Hashable {
  /// The words to show. Never carries a `[System: …]` or other wrapper.
  public var text: String
  /// A teammate bot said it; the row prefixes their handle the way the DM bubble
  /// does. Absent for everything else, the owner's own turns included.
  public var fromHandle: String?
  /// Somebody else's turn in the group chat: the resolved name to lead the row
  /// with (HERM-83, D6). Absent for the reader's own turns, an unattributed
  /// row, anywhere the caller has not said is the group chat, and every kind
  /// but `user` — the same gate `TranscriptContext`/`UserBubble` draw a name
  /// from, restated here because a chat-list row has no bubble to ask.
  public var senderName: String?
  /// The words are the machine's scaffolding rather than anybody speaking. A row
  /// may draw them more quietly; it must not attribute them.
  public var system: Bool

  public init(text: String, fromHandle: String? = nil, senderName: String? = nil, system: Bool) {
    self.text = text
    self.fromHandle = fromHandle
    self.senderName = senderName
    self.system = system
  }

  public var jsonValue: JSONValue {
    var object: JSONObject = ["text": .string(text), "system": .bool(system)]
    if let fromHandle { object["fromHandle"] = .string(fromHandle) }
    if let senderName { object["senderName"] = .string(senderName) }
    return .object(object)
  }
}

/// What a caller has to hand over before a `user` row can be attributed here.
///
/// The engine holds `MessageAuthor` but not who is reading or how a name gets
/// sanitised — both are the app's own state (`ChatRuntime`'s identity, the chat
/// kit's `fallbackSenderName`) — so, exactly like `TranscriptContext.groupChat`
/// / `ownAuthorId` / `resolveSenderName`, they arrive as options rather than
/// being read from anywhere global. Every field absent is the safe default:
/// every `user` row previews exactly as it did before `author` existed.
public struct ChatPreviewOptions {
  /// D6 gate 1: only the canonical GROUP chat leads a row with a sender.
  public var groupChat: Bool?
  /// The reader's own identity — D3's own/foreign gate, against `author.id`.
  public var ownAuthorID: String?
  /// Names a foreign author — D4's rungs 2 and 3, or rung 1 when the host has
  /// one. This package cannot sanitise a name itself; a caller with nothing to
  /// resolve leaves every row unattributed rather than showing a raw id.
  public var resolveSenderName: ((MessageAuthor) -> String)?

  public init(
    groupChat: Bool? = nil,
    ownAuthorID: String? = nil,
    resolveSenderName: ((MessageAuthor) -> String)? = nil
  ) {
    self.groupChat = groupChat
    self.ownAuthorID = ownAuthorID
    self.resolveSenderName = resolveSenderName
  }
}

/// The newest item in a chat that a reader would call a message.
///
/// The same four kinds the transcript draws as speech or as a report somebody
/// asked for: the owner's turn, the bot's reply, an inbound teammate DM, a cron
/// delivery's body. Deliberately NOT the same predicate as `countsAsMessage` in
/// `Unread.swift` — that one answers "is this unread mail", which the owner's own
/// turn is not, while a preview showing what the owner last said is exactly right
/// and is what every messenger does.
///
/// Read backwards: the answer is nearly always the last row, and a chat can be
/// thousands of them.
public func previewFromChat(_ state: ChatState?, _ options: ChatPreviewOptions = ChatPreviewOptions()) -> ChatPreview? {
  guard let state else {
    return nil
  }

  for id in state.order.reversed() {
    if let found = previewOfItem(state.items[id], options) {
      return found
    }
  }

  return nil
}

/// The sender to lead a `user` row's preview with, or `nil`.
///
/// `nil` for every case D6/D3 already rule out elsewhere: not the group chat,
/// the reader's own identity not known, no author on the row, the row's own
/// author, or a caller with no resolver at all.
private func attributedSenderName(_ author: MessageAuthor?, _ options: ChatPreviewOptions) -> String? {
  guard options.groupChat == true, let ownAuthorID = options.ownAuthorID, !ownAuthorID.isEmpty,
    let resolveSenderName = options.resolveSenderName, let author
  else {
    return nil
  }

  if JS.same(author.id, ownAuthorID) {
    return nil
  }

  let name = resolveSenderName(author)
  return name.isEmpty ? nil : name
}

private func previewOfItem(_ item: TranscriptItem?, _ options: ChatPreviewOptions) -> ChatPreview? {
  guard let item else {
    return nil
  }

  switch item {
  case .user(let user):
    // A placeholder for a turn whose author is not known yet says nothing, and
    // neither does a bubble that carried only an attachment.
    if user.unknownAuthor == true {
      return nil
    }

    guard var found = previewText(user.text) else { return nil }
    found.senderName = attributedSenderName(user.author, options)
    return found

  case .assistant(let assistant):
    // An empty bubble is the turn in progress; there is nothing to preview
    // until the first token lands.
    return previewText(assistant.text)

  case .botDmIn(let dm):
    let body = JS.trim(dm.text)
    // `??`, not `||`: an empty handle the gateway sent stays empty, and then
    // there is no handle to show rather than the display name.
    let handle = JS.trim(dm.senderHandle ?? dm.senderName)

    return body.isEmpty ? nil : ChatPreview(text: body, fromHandle: handle.isEmpty ? nil : handle, system: false)

  case .cronDelivery(let cron):
    // The report, never the header: the job's name is in the card, and a
    // preview of a header is a preview of plumbing.
    return previewText(cron.body)

  default:
    return nil
  }
}

private func previewText(_ value: String) -> ChatPreview? {
  let trimmed = JS.trim(value)

  return trimmed.isEmpty ? nil : ChatPreview(text: trimmed, system: false)
}

/// The gateway's `preview` string, with any scaffolding wrapper taken off.
///
/// `nil` for an empty string, so a caller can fall through to the bot's
/// description the way it always has. The TypeScript takes `unknown` and reads
/// only a string; anything else is `nil` here.
public func previewFromGatewayText(_ raw: String?) -> ChatPreview? {
  guard let raw, !JS.trimsToEmpty(raw) else {
    return nil
  }

  guard let injected = parseInjectedRow(raw) else {
    if let opener = truncatedInjectedOpener(raw) {
      return ChatPreview(text: opener, system: true)
    }
    return ChatPreview(text: JS.trim(raw), system: false)
  }

  /*
    The scaffolding's own words, and the narrowest of them.

    `title` rather than `body` on purpose: a fan-out report's body is the whole
    row, headers and payload, which on one line of a list row is worse than the
    header alone. For a `[System: …]` note the two are the same sentence anyway,
    because `parseInjectedRow` already took the wrapper off both.
  */
  let title = JS.trim(injected.title)
  return ChatPreview(text: title.isEmpty ? JS.trim(injected.body) : title, system: true)
}

/// What a chat-list row should show: the transcript's last real message when
/// there is one, the gateway's string otherwise.
///
/// The transcript wins even when the gateway's string is newer, and that is the
/// intended trade. The string is only ever the LAST row, so a chat whose last row
/// is scaffolding has no real message in it to offer; the transcript has the one
/// before it. A stale-by-one-row preview of something somebody said beats a fresh
/// preview of a marker nobody wrote.
public func chatRowPreview(
  _ state: ChatState?,
  _ gatewayPreview: String?,
  _ options: ChatPreviewOptions = ChatPreviewOptions()
) -> ChatPreview? {
  previewFromChat(state, options) ?? previewFromGatewayText(gatewayPreview)
}

/// `/^\s*\[(?:System|IMPORTANT):\s*([^\r\n]+)/u`
private let injectedOpenerPattern = JSRegExp(
  #"\A"# + JSPattern.s + #"*\[(?:System|IMPORTANT):"# + JSPattern.s + #"*([^\r\n]+)"#
)
/// `/(?:\.\.\.|…)\s*$/u`
private let trailingEllipsisPattern = JSRegExp(#"(?:\.\.\.|…)"# + JSPattern.s + "*" + JSPattern.end)
/// `/\]\s*$/u`
private let trailingBracketPattern = JSRegExp(#"\]"# + JSPattern.s + "*" + JSPattern.end)
/// `/[.;](?=\s|$)/u`
private let sentenceStopPattern = JSRegExp(#"[.;](?=[\#(JSPattern.spaceSet)]|\#(JSPattern.end))"#)

/// A `[System: …]` or `[IMPORTANT: …]` row the gateway has already cut down for
/// a list.
///
/// The roster's preview is the newest user or assistant row squashed onto one
/// line and cut at eighty characters, so an injected wrapper arrives with its
/// newlines gone and, past eighty characters, its closing bracket gone too —
/// which is exactly what `parseInjectedRow` reads for: a header line, a body
/// under it, a bracket at the end. None of that survives the cut, and the raw
/// text with its opening bracket was what reached the chat list. So a preview
/// that OPENS like scaffolding is read as scaffolding: the first sentence after
/// the marker, with the ellipsis the gateway appended and any bracket it left
/// taken off. It is a lookup on the opener only; a message that merely starts
/// with a bracket (`[link](…)`) does not match.
private func truncatedInjectedOpener(_ raw: String) -> String? {
  guard let match = injectedOpenerPattern.exec(raw), let opener = match[1] else {
    return nil
  }

  let rest = trailingBracketPattern.replaceFirst(
    in: trailingEllipsisPattern.replaceFirst(in: opener, with: ""),
    with: ""
  )
  let stop = sentenceStopPattern.search(rest)
  let sentence = JS.trim(stop == -1 ? rest : JS.slice(rest, 0, stop))

  return sentence.isEmpty ? nil : sentence
}
