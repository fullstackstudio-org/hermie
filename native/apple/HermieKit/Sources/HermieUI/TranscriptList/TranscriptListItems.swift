/// A snapshot of the list's rows, compared by identity. Hold the rows as this
/// wherever they are stored on the main actor — an `@Observable` model's
/// property, a view's property — and hand it to `TranscriptList`.
///
/// Both SwiftUI and Observation compare an `Equatable` value with `==` before
/// they act on it: SwiftUI every stored property of a view it updates (looking
/// into structs field by field), Observation in the setter of an `@Observable`
/// property. For `[TranscriptRow]` that is a walk over every row of the
/// transcript on every streamed delta, once per place the array is stored; in
/// the spike it was the largest cost on the main thread (5.7 s of 7.4 s with a
/// deep row comparison, still 0.8 s of 2.4 s with an O(1) one). Here the array
/// sits behind one class reference and the type is not `Equatable`, so both
/// compare a pointer: a new snapshot re-renders, the same one does not, and
/// nothing walks the rows.
public struct TranscriptListItems<Element: Sendable>: RandomAccessCollection, Sendable {
  private final class Storage: Sendable {
    let elements: [Element]

    init(_ elements: [Element]) {
      self.elements = elements
    }
  }

  private let storage: Storage

  public init(_ elements: [Element] = []) {
    storage = Storage(elements)
  }

  /// The rows, as an array.
  public var elements: [Element] { storage.elements }

  public var startIndex: Int { 0 }
  public var endIndex: Int { storage.elements.count }

  public subscript(position: Int) -> Element {
    storage.elements[position]
  }
}
