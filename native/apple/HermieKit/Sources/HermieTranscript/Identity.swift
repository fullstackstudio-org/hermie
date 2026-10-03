import HermieProtocol

// The three durable identities the gateway can attach to what it sends
// (`identity.ts`)
// ====================================================================
//
// - a ROW is `messages.id`, the persisted row itself (`row_id`);
// - a CALL is the assistant row that holds a `tool_calls` entry plus that
//   entry's position in it (`call_row_id` + `call_index`), which stays unique
//   per session however poorly a provider numbers its own `tool_id`;
// - a TURN is the random id the gateway minted when it started the turn
//   (`turn_id`), stamped on the user row's `display_metadata`.
//
// Every reader here is defensive in the same way: a value of the wrong type is
// "absent", never half-trusted, because an absent identity sends the engine down
// the path it had before any of this existed. Nothing here guesses.

/// `positiveFinite`: a finite number above zero.
private func positiveFinite(_ value: JSONValue?) -> Double? {
  guard case .number(let number)? = value, number.isFinite, number > 0 else { return nil }
  return number
}

/// `nonNegativeInteger`: `Number.isInteger(value) && value >= 0`.
private func nonNegativeInteger(_ value: JSONValue?) -> Double? {
  guard case .number(let number)? = value, number.isFinite, number >= 0, number.rounded(.towardZero) == number else {
    return nil
  }
  return number
}

/// `objectOf`: an object, or a string holding (a string holding …) a JSON object.
private func identityObject(_ value: JSONValue?) -> JSONObject? {
  switch value {
  case .string(let text)?:
    guard let parsed = JS.parseJSON(text) else { return nil }
    return identityObject(parsed)
  case .object(let object)?:
    return object
  default:
    return nil
  }
}

/// `callKeyOf`: `"<call_row_id>/<call_index>"`, or `nil` when either half is
/// missing or malformed. Both halves or nothing: a row id alone names the
/// assistant row, not the call.
///
/// `record` is whatever carries the two keys: a history row, a `tool.*` payload
/// or a cached item.
public func callKeyOf(_ record: JSONObject?) -> String? {
  guard let record, let rowID = positiveFinite(record["call_row_id"]),
    let index = nonNegativeInteger(record["call_index"])
  else {
    return nil
  }

  return "\(JS.string(rowID))/\(JS.string(index))"
}

/// `rowIdOf`: `row_id` of a frame or a history row when it is a positive finite
/// number. The model holds a row id as an integer (see `ItemBase`), so a
/// fractional one reads as absent.
public func rowIDOf(_ record: JSONObject?) -> Int? {
  guard let record, let rowID = positiveFinite(record["row_id"]) else { return nil }
  return Int(exactly: rowID)
}

/// `turnIdOfMetadata`: `turn_id` out of a user row's `display_metadata` (an
/// object, or the JSON text of one), when it is a non-empty string.
public func turnIDOfMetadata(_ value: JSONValue?) -> String? {
  guard case .string(let turnID)? = identityObject(value)?["turn_id"], !turnID.isEmpty else { return nil }
  return turnID
}
