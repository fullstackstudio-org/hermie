import Foundation

/// What the gateway will accept as a bot's handle, decided before it is asked: the port of
/// `features/profiles/profile-name.ts`, which is a transcription of upstream's validator
/// (`hermes_constants.py::PROFILE_ID_RE` and `hermes_cli/profiles.py`).
///
/// A profile's name is a directory under `profiles/`, an argv value after `-p` and the filename of a
/// wrapper script, so it has rules a label does not. The verdict names the problem; the screen says it
/// in the reader's language. The gateway stays the authority: `profiles.create` runs all of this again.
public enum ProfileName {
  /// `PROFILE_ID_RE` is `^[a-z0-9][a-z0-9_-]{0,63}$`: at most this many characters.
  public static let maxLength = 64

  /// `_RESERVED_NAMES`: these collide with the installation itself or with a common system binary.
  static let reserved: Set<String> = ["hermes", "default", "test", "tmp", "root", "sudo"]

  /// `_HERMES_SUBCOMMANDS`, abridged to the ones a person would plausibly name a bot. A warning and
  /// never a refusal: only the `hermes <name>` shortcut is not made.
  static let subcommands: Set<String> = [
    "chat", "model", "gateway", "setup", "whatsapp", "login", "logout", "serve", "update", "profile",
    "skills", "tools", "cron", "plugins", "mcp", "auth", "config"
  ]

  public enum Problem: Equatable, Sendable {
    /// Nothing usable was typed.
    case empty
    /// `default` is the built-in bot and cannot be made again.
    case builtIn
    /// Not lower-case letters, digits, `-` or `_`, or too long; `suggestion` is a legal handle made
    /// from what was typed.
    case shape(suggestion: String)
    case reserved(String)
    case taken(String)
  }

  public enum Warning: Equatable, Sendable {
    /// The handle is also a `hermes` subcommand: no shell shortcut, the bot itself is fine.
    case subcommand(String)
  }

  public struct Verdict: Equatable, Sendable {
    /// The name as the gateway would store it. Empty when nothing usable was typed.
    public var handle: String
    public var problem: Problem?
    public var warning: Warning?

    /// Whether `handle` may be sent to `profiles.create`.
    public var isValid: Bool { problem == nil }
  }

  /// `normalize_profile_name`: trim, then lower case (`Default` and `DEFAULT` land on the built-in).
  public static func normalize(_ name: String) -> String {
    name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  /// `PROFILE_ID_RE`.
  public static func isLegal(_ handle: String) -> Bool {
    let scalars = Array(handle.unicodeScalars)

    guard let first = scalars.first, scalars.count <= maxLength, isAlphanumeric(first) else {
      return false
    }

    return scalars.dropFirst().allSatisfy { isAlphanumeric($0) || $0 == "-" || $0 == "_" }
  }

  /// `_suggest_profile_name`: a best-effort legal id from what was typed (`My Work` is `my-work`).
  public static func suggestion(for name: String) -> String {
    var scalars: [Unicode.Scalar] = []
    var pendingDash = false

    for scalar in normalize(name).unicodeScalars {
      if isAlphanumeric(scalar) || scalar == "-" || scalar == "_" {
        if pendingDash {
          scalars.append("-")
          pendingDash = false
        }

        scalars.append(scalar)
      } else {
        pendingDash = true
      }
    }

    while let first = scalars.first, first == "-" || first == "_" {
      scalars.removeFirst()
    }

    while let last = scalars.last, last == "-" || last == "_" {
      scalars.removeLast()
    }

    var candidate = String.UnicodeScalarView()
    candidate.append(contentsOf: scalars.prefix(maxLength))
    let text = String(candidate)

    return isLegal(text) ? text : "my-work"
  }

  /// The whole verdict in one pass, for a field that is checked while it is typed. `taken` is the
  /// roster the client already holds: a name that exists is caught in the field, not by a refusal.
  public static func check(_ raw: String, taken: [String] = []) -> Verdict {
    let handle = normalize(raw)

    func fail(_ problem: Problem) -> Verdict {
      Verdict(handle: handle, problem: problem, warning: nil)
    }

    if handle.isEmpty {
      return fail(.empty)
    }

    // `create_profile` refuses this one before the reserved-name check can reach it.
    if handle == "default" {
      return fail(.builtIn)
    }

    if !isLegal(handle) {
      return fail(.shape(suggestion: suggestion(for: raw)))
    }

    if reserved.contains(handle) {
      return fail(.reserved(handle))
    }

    if taken.contains(handle) {
      return fail(.taken(handle))
    }

    return Verdict(handle: handle, problem: nil, warning: subcommands.contains(handle) ? .subcommand(handle) : nil)
  }

  private static func isAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
    (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9")
  }
}
