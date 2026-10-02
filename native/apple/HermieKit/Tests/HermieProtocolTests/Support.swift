import Foundation
import HermieProtocol

/// The repository's `contract/` directory, found from this file's own path
/// (`<repo>/native/apple/HermieKit/Tests/HermieProtocolTests/Support.swift`).
let contractDirectory: URL = {
  var url = URL(fileURLWithPath: #filePath)
  for _ in 0..<6 { url.deleteLastPathComponent() }
  return url.appendingPathComponent("contract", isDirectory: true)
}()

/// Every `.json` file under `contract/`, sorted by path relative to it.
func contractFiles() throws -> [(path: String, url: URL)] {
  let root = contractDirectory.standardizedFileURL.path
  guard let enumerator = FileManager.default.enumerator(at: contractDirectory, includingPropertiesForKeys: nil) else {
    return []
  }
  var files: [(String, URL)] = []
  for case let url as URL in enumerator where url.pathExtension == "json" {
    let path = url.standardizedFileURL.path
    files.append((String(path.dropFirst(root.count + 1)), url))
  }
  return files.sorted { $0.0 < $1.0 }
}

func loadContract(_ relativePath: String) throws -> JSONValue {
  try JSONValue(parsing: Data(contentsOf: contractDirectory.appendingPathComponent(relativePath)))
}

/// `text` with every whitespace byte outside string literals removed. For a file written by
/// `JSON.stringify(value, null, 2)` this is exactly `JSON.stringify(value)`: the TypeScript
/// reference's own compact text, produced by node, not by this package.
func minifiedJSONText(_ data: Data) -> String {
  var output: [UInt8] = []
  output.reserveCapacity(data.count)
  var inString = false
  var escaped = false
  for byte in data {
    if inString {
      output.append(byte)
      if escaped {
        escaped = false
      } else if byte == UInt8(ascii: "\\") {
        escaped = true
      } else if byte == UInt8(ascii: "\"") {
        inString = false
      }
    } else {
      switch byte {
      case 0x20, 0x09, 0x0A, 0x0D:
        continue
      case UInt8(ascii: "\""):
        inString = true
        output.append(byte)
      default:
        output.append(byte)
      }
    }
  }
  return String(decoding: output, as: UTF8.self)
}

func canonical(_ value: JSONValue) throws -> String {
  try value.canonicalString()
}

func canonical<T: JSONConvertible>(_ value: T) throws -> String {
  try value.jsonValue.canonicalString()
}
