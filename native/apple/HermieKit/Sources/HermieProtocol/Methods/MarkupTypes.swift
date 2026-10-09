// The `markup` key of `client.capabilities`: which Hermie blocks this connection draws in a reply
// (`chart`, `cards`, `alerts`). The gateway tells a model about exactly those, on the turns this connection
// submits, and only those. See `HermieGateway/MarkupCapabilities.swift` for when it may be sent.

extension ClientCapabilitiesParams {
  /// The blocks this connection draws (at most 16 names of at most 32 characters, `[a-z][a-z-]*`). Sent in the
  /// second call only, and in every later call: the gateway takes each call as the whole advertisement, so a call
  /// without it clears it. An older gateway refuses the unknown key with 4000 and the whole call.
  public var markup: [String]? { get { json[field: "markup"] } set { json[field: "markup"] = newValue } }
}

extension ClientCapabilitiesResult {
  /// The blocks the gateway accepted from this connection, sorted (`[]` when none). Always present from a
  /// gateway that knows the key; absent from one that does not.
  public var markup: [String]? { get { json[field: "markup"] } set { json[field: "markup"] = newValue } }
}
