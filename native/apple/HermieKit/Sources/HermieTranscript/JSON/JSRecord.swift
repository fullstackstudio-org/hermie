import HermieProtocol

/// A string-keyed record that enumerates the way a JavaScript object does.
///
/// JavaScript walks an object's own keys in a fixed order: keys that are array
/// indices (`"0"` … `"4294967294"`) first, in numeric order, then every other key in
/// the order it was first set. Swift's `Dictionary` has no order at all. Where the
/// TypeScript engine walks a record and the walk shows in its output, the port needs
/// the JavaScript order, and this is it. That is two records today:
///
/// - `ChatState.subagents` — `Object.values(state.subagents)` is the order of the
///   cache's `subagents` array, of `runningSubagents` and of `subagentTree`;
/// - `ClarifyItem.answers` — `Object.keys(answers)` becomes `locked`, and the
///   export walks `Object.entries(answers)`.
///
/// Every other map in the state (`items`, `byRowId`, `byToolId`, …) is only ever
/// looked up by key, never walked, so it is a plain `Dictionary`.
///
/// Decoding: a `JSONValue` object has already lost its document order, so a
/// decoded record takes the order `JSON.parse` would give the CANONICAL text —
/// index keys numerically, then the rest by UTF-16 code unit. Every file under
/// `contract/` is canonical, so that is exactly the order the TypeScript replay saw.
///
/// Value semantics: two arrays and a dictionary, all copy-on-write; a copy is three
/// retains. Removing a non-index key is O(n) in the record's size, which is a
/// handful of subagents or clarify answers.
public struct JSRecord<Value: Sendable>: Sendable {
  private var storage: [String: Value] = [:]
  /// Array-index keys, ascending.
  private var indexKeys: [UInt32] = []
  /// Every other key, in insertion order.
  private var namedKeys: [String] = []

  public init() {}

  /// Keys and values in JavaScript enumeration order.
  public init<S: Sequence>(_ pairs: S) where S.Element == (String, Value) {
    for (key, value) in pairs { self[key] = value }
  }

  public var count: Int { storage.count }
  public var isEmpty: Bool { storage.isEmpty }

  /// `Object.keys(record)`.
  public var keys: [String] {
    indexKeys.map { String($0) } + namedKeys
  }

  /// `Object.values(record)`.
  public var values: [Value] {
    keys.map { storage[$0]! }
  }

  /// `Object.entries(record)`.
  public var entries: [(key: String, value: Value)] {
    keys.map { ($0, storage[$0]!) }
  }

  /// `record[key]`; setting `nil` is `delete record[key]`. Setting an existing key
  /// keeps its place, as assigning to a JavaScript property does.
  public subscript(key: String) -> Value? {
    get { storage[key] }
    set {
      guard let newValue else {
        removeValue(forKey: key)
        return
      }
      if storage.updateValue(newValue, forKey: key) == nil {
        if let index = Self.arrayIndex(key) {
          let position = indexKeys.partitioningIndex { $0 >= index }
          indexKeys.insert(index, at: position)
        } else {
          namedKeys.append(key)
        }
      }
    }
  }

  @discardableResult
  public mutating func removeValue(forKey key: String) -> Value? {
    guard let old = storage.removeValue(forKey: key) else { return nil }
    if let index = Self.arrayIndex(key) {
      indexKeys.removeAll { $0 == index }
    } else {
      namedKeys.removeAll { $0 == key }
    }
    return old
  }

  /// The plain dictionary, order dropped.
  public var dictionary: [String: Value] { storage }

  /// `key` as an ECMAScript array index: the canonical decimal form of an integer in
  /// `0 ... 2^32 - 2` (no sign, no leading zero, no exponent).
  static func arrayIndex(_ key: String) -> UInt32? {
    let units = key.utf8
    guard let first = units.first, units.count <= 10, first >= 0x30, first <= 0x39 else { return nil }
    if first == 0x30 { return units.count == 1 ? 0 : nil }
    var value: UInt64 = 0
    for unit in units {
      guard unit >= 0x30, unit <= 0x39 else { return nil }
      value = value * 10 + UInt64(unit - 0x30)
    }
    return value <= 4_294_967_294 ? UInt32(value) : nil
  }
}

extension JSRecord: Sequence {
  public func makeIterator() -> IndexingIterator<[(key: String, value: Value)]> {
    entries.makeIterator()
  }
}

extension JSRecord: Equatable where Value: Equatable {
  /// Same keys, same values, same enumeration order.
  public static func == (lhs: JSRecord, rhs: JSRecord) -> Bool {
    lhs.storage == rhs.storage && lhs.indexKeys == rhs.indexKeys && lhs.namedKeys == rhs.namedKeys
  }
}

extension JSRecord: Hashable where Value: Hashable {
  public func hash(into hasher: inout Hasher) {
    hasher.combine(storage)
    hasher.combine(namedKeys)
  }
}

extension JSRecord: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, Value)...) {
    self.init(elements)
  }
}

extension JSRecord: JSONField where Value: JSONField {
  static func read(_ json: JSONValue, at path: String) -> JSRecord? {
    guard case .object(let object) = json else { return nil }
    var record = JSRecord()
    record.storage.reserveCapacity(object.count)
    // The canonical text's order, which is the order `JSON.parse` inserts in.
    for key in object.keys.sorted(by: { $0.utf16.lexicographicallyPrecedes($1.utf16) }) {
      guard let value = Value.read(object[key]!, at: JSONPath.member(path, key)) else { return nil }
      record[key] = value
    }
    return record
  }

  var json: JSONValue {
    .object(storage.mapValues(\.json))
  }
}

fileprivate extension Array {
  /// The first index whose element satisfies `predicate`, for an array already
  /// partitioned by it (binary search).
  func partitioningIndex(where predicate: (Element) -> Bool) -> Int {
    var low = 0
    var high = count
    while low < high {
      let middle = (low + high) / 2
      if predicate(self[middle]) { high = middle } else { low = middle + 1 }
    }
    return low
  }
}
