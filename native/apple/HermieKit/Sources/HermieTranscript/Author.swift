import HermieProtocol

// The marker a gateway puts on a turn an agent sent on a person's behalf
// (`display_metadata.author.via`, and the same under `replayed_by`), and how the
// engine words it: the port of `author.ts`, whose contract is
// `contract/gateway/mcp.md`.
//
// The identity of such a row stays the PERSON's: `author.id` and `author.name` are who
// the agent works for, and `via` says it was an agent, and which one, that actually
// sent it. A client never shows the person's name alone for a row that carries one,
// so what it draws is one label, `<name> via <client>` (`authorLabel`).
//
// Everything read here is defensive in the way `Identity.swift` is: a value of the
// wrong type is absent, never half-trusted.

/// The longest client name the engine will carry, in code points. The gateway cleans to the same cap.
public let authorViaClientLimit = 80

/// The English word that joins a name to the client it came through. The engine words
/// the label; a client that localises its own chrome may spell the join in its own
/// language, around the same two parts.
public let authorViaWord = "via"

/// One line of plain text: format characters (`Cf`: bidi overrides, zero-width space and
/// joiners) gone, line breaks and other controls a space, runs of whitespace one space,
/// held to the limit. The port of `cleanClient`.
private func cleanClient(_ value: String) -> String {
  var spaced = String.UnicodeScalarView()

  for scalar in value.unicodeScalars {
    switch scalar.properties.generalCategory {
    case .format:
      continue
    case .control, .lineSeparator, .paragraphSeparator:
      spaced.append(" ")
    default:
      spaced.append(scalar)
    }
  }

  // `.replace(/\s+/gu, ' ').trim()`: JavaScript's whitespace, runs collapsed to one space.
  var collapsed = String.UnicodeScalarView()
  var inRun = false

  for scalar in spaced {
    if scalar.value <= 0xFFFF, JS.isWhitespace(UInt16(scalar.value)) {
      inRun = true
    } else {
      if inRun {
        collapsed.append(" ")
      }

      inRun = false
      collapsed.append(scalar)
    }
  }

  if inRun {
    collapsed.append(" ")
  }

  let trimmed = JS.trim(String(collapsed))
  // `Array.from(...).slice(0, 80).join('')`: code points, never a cut through a pair.
  let limited = String(String.UnicodeScalarView(trimmed.unicodeScalars.prefix(authorViaClientLimit)))

  return JS.trim(limited)
}

/// `via` out of an `author` (or `replayed_by`) object: `{ kind, client }` with a non-empty
/// string `kind` and a `client` that is a non-empty string once cleaned. Unknown keys are
/// ignored (a later gateway may add some); a `via` of any other shape is absent, and the
/// author keeps what it has: dropping the whole author for it would take the person's
/// identity with the marker, and a colleague's row in a group chat would then read as
/// nobody's.
public func authorViaOf(_ value: JSONValue?) -> AuthorVia? {
  guard case .object(let object)? = value else {
    return nil
  }

  guard case .string(let kind)? = object["kind"], !JS.trim(kind).isEmpty, case .string(let client)? = object["client"]
  else {
    return nil
  }

  let cleaned = cleanClient(client)

  return cleaned.isEmpty ? nil : AuthorVia(kind: JS.trim(kind), client: cleaned)
}

/// `<name> via <client>` for an author that carries `via`, else `name` as it is.
///
/// Plain text, never Markdown: `via` is a word, not emphasis, and nothing here escapes or
/// wraps. A caller that puts the label into Markdown escapes the whole line the way it
/// escapes any other person's text. A blank `name` leaves `via <client>`, so an agent's
/// turn is never labelled as nobody's.
public func authorLabel(via: AuthorVia?, _ name: String) -> String {
  guard let via else {
    return name
  }

  let who = JS.trim(name)

  return who.isEmpty ? "\(authorViaWord) \(via.client)" : "\(who) \(authorViaWord) \(via.client)"
}

/// `authorLabel` for a row's author.
public func authorLabel(_ author: MessageAuthor?, _ name: String) -> String {
  authorLabel(via: author?.via, name)
}
