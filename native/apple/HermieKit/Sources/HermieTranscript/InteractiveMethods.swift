/// The server-request methods that become a `request` item.
///
/// `INTERACTIVE_METHODS`: the contract's list (`contract/requests/schema.json`,
/// `methods`), held equal to it by a test. `approval` and `clarify` are not in it:
/// they have items of their own.
public let interactiveMethods: [String] = [
  "input.form", "input.file", "review.draft", "review.diff", "input.signature", "device.location", "device.contact",
  "device.calendar", "device.scan",
]

/// `isInteractiveMethod`.
public func isInteractiveMethod(_ method: String?) -> Bool {
  guard let method else { return false }
  return interactiveMethods.contains(method)
}
