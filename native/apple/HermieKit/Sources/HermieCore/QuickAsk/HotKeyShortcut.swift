import Foundation

/**
 A global keyboard shortcut: one key with the modifiers held, in the terms the Mac's Carbon hot key
 API takes (`RegisterEventHotKey`), which needs no permission.

 It is plain data. How one is written down (`storageString`), read back (`init?(storage:)`), shown
 (`display`) and judged (`isValid`) is decided here, so Settings, the registrar and the tests agree
 and none of them needs a keyboard, a window or the system.

 The key is a hardware key code (the `kVK_` values), not a character: it is the same key on every
 keyboard layout, which is what a shortcut that is registered once and recorded once needs.
 */
public struct HotKeyShortcut: Hashable, Sendable {
  public struct Modifiers: OptionSet, Hashable, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
      self.rawValue = rawValue
    }

    public static let command = Modifiers(rawValue: 1 << 0)
    public static let option = Modifiers(rawValue: 1 << 1)
    public static let control = Modifiers(rawValue: 1 << 2)
    public static let shift = Modifiers(rawValue: 1 << 3)
  }

  /// The Mac's virtual key code (`kVK_Space` is 49).
  public var keyCode: UInt16
  public var modifiers: Modifiers

  public init(keyCode: UInt16, modifiers: Modifiers) {
    self.keyCode = keyCode
    self.modifiers = modifiers
  }

  /// Option-Space, which no system shortcut uses.
  public static let standard = HotKeyShortcut(keyCode: 49, modifiers: [.option])

  // MARK: Judging

  /// Whether the system can be asked for it, and whether it is a shortcut worth having: a key
  /// the table knows, held with Command, Option or Control. A letter alone, or with Shift alone,
  /// would take that key from every app; a function key may stand alone.
  public var isValid: Bool {
    guard HotKeyKeys.name(of: keyCode) != nil else {
      return false
    }

    if HotKeyKeys.isFunctionKey(keyCode) {
      return true
    }

    return !modifiers.isDisjoint(with: [.command, .option, .control])
  }

  // MARK: Carbon

  /// The modifier bits `RegisterEventHotKey` takes (`cmdKey`, `shiftKey`, `optionKey`,
  /// `controlKey`), written out so this type needs no Carbon.
  public var carbonModifiers: UInt32 {
    var bits: UInt32 = 0

    if modifiers.contains(.command) { bits |= 0x0100 }
    if modifiers.contains(.shift) { bits |= 0x0200 }
    if modifiers.contains(.option) { bits |= 0x0800 }
    if modifiers.contains(.control) { bits |= 0x1000 }

    return bits
  }

  // MARK: Storing

  /// `control+option+shift+command+key`, in that order, lowercase: `option+space`. What
  /// `QuickAskSettings` keeps.
  public var storageString: String {
    var parts: [String] = []

    if modifiers.contains(.control) { parts.append("control") }
    if modifiers.contains(.option) { parts.append("option") }
    if modifiers.contains(.shift) { parts.append("shift") }
    if modifiers.contains(.command) { parts.append("command") }
    parts.append(HotKeyKeys.name(of: keyCode) ?? "key\(keyCode)")

    return parts.joined(separator: "+")
  }

  /// Reads what `storageString` wrote, and the usual spellings of it (`cmd+shift+K`, `alt+Space`).
  /// Nil for anything that is not a shortcut this type can hold: an unknown key, no key, two keys,
  /// or a combination `isValid` refuses.
  public init?(storage: String) {
    let parts = storage.lowercased()
      .split(separator: "+", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }

    guard let last = parts.last, !last.isEmpty else {
      return nil
    }

    var modifiers: Modifiers = []

    for word in parts.dropLast() {
      switch word {
      case "command", "cmd": modifiers.insert(.command)
      case "option", "opt", "alt": modifiers.insert(.option)
      case "control", "ctrl": modifiers.insert(.control)
      case "shift": modifiers.insert(.shift)
      default: return nil
      }
    }

    guard let code = HotKeyKeys.code(named: last) else {
      return nil
    }

    let shortcut = HotKeyShortcut(keyCode: code, modifiers: modifiers)

    guard shortcut.isValid else {
      return nil
    }

    self = shortcut
  }

  // MARK: Showing

  /// How a Mac writes it: modifiers in the order of the menus (⌃⌥⇧⌘), then the key. `⌥Space`.
  public var display: String {
    var text = ""

    if modifiers.contains(.control) { text += "⌃" }
    if modifiers.contains(.option) { text += "⌥" }
    if modifiers.contains(.shift) { text += "⇧" }
    if modifiers.contains(.command) { text += "⌘" }

    return text + HotKeyKeys.label(of: keyCode)
  }
}

/// The keys a shortcut may use: the Mac's virtual key codes, by the name `HotKeyShortcut` stores.
/// The US layout's names; the codes are the same on every layout.
enum HotKeyKeys {
  private static let table: [(name: String, code: UInt16, label: String)] = {
    var rows: [(String, UInt16, String)] = []
    let letters: [(String, UInt16)] = [
      ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9),
      ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("o", 31), ("u", 32),
      ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("k", 40), ("n", 45), ("m", 46)
    ]
    let digits: [(String, UInt16)] = [
      ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("9", 25), ("7", 26), ("8", 28), ("0", 29)
    ]

    for (name, code) in letters { rows.append((name, code, name.uppercased())) }
    for (name, code) in digits { rows.append((name, code, name)) }

    rows += [
      ("equal", 24, "="), ("minus", 27, "-"), ("rightbracket", 30, "]"), ("leftbracket", 33, "["),
      ("quote", 39, "'"), ("semicolon", 41, ";"), ("backslash", 42, "\\"), ("comma", 43, ","),
      ("slash", 44, "/"), ("period", 47, "."), ("grave", 50, "`"),
      ("return", 36, "↩"), ("tab", 48, "⇥"), ("space", 49, "Space"), ("delete", 51, "⌫"),
      ("escape", 53, "⎋"), ("forwarddelete", 117, "⌦"),
      ("home", 115, "↖"), ("end", 119, "↘"), ("pageup", 116, "⇞"), ("pagedown", 121, "⇟"),
      ("left", 123, "←"), ("right", 124, "→"), ("down", 125, "↓"), ("up", 126, "↑")
    ]

    let functionKeys: [(Int, UInt16)] = [
      (1, 122), (2, 120), (3, 99), (4, 118), (5, 96), (6, 97), (7, 98), (8, 100), (9, 101), (10, 109),
      (11, 103), (12, 111), (13, 105), (14, 107), (15, 113), (16, 106), (17, 64), (18, 79), (19, 80), (20, 90)
    ]

    for (number, code) in functionKeys { rows.append(("f\(number)", code, "F\(number)")) }

    return rows
  }()

  private static let byCode = Dictionary(uniqueKeysWithValues: table.map { ($0.code, $0) })
  private static let byName = Dictionary(uniqueKeysWithValues: table.map { ($0.name, $0.code) })
  private static let aliases = ["enter": UInt16(36), "esc": 53, "backspace": 51, "spacebar": 49]

  static func name(of code: UInt16) -> String? {
    byCode[code]?.name
  }

  static func code(named name: String) -> UInt16? {
    byName[name] ?? aliases[name]
  }

  static func label(of code: UInt16) -> String {
    byCode[code]?.label ?? "?"
  }

  static func isFunctionKey(_ code: UInt16) -> Bool {
    guard let name = byCode[code]?.name else {
      return false
    }

    return name.count >= 2 && name.hasPrefix("f") && name.dropFirst().allSatisfy(\.isNumber)
  }
}
