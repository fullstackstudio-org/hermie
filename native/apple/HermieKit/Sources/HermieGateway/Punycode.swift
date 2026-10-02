/// RFC 3492 Punycode encoding, for the `xn--` labels an IDN host becomes.
enum Punycode {
  private static let base = 36
  private static let tMin = 1
  private static let tMax = 26
  private static let skew = 38
  private static let damp = 700
  private static let initialBias = 72
  private static let initialN = 128

  /// The Punycode form of one label (without the `xn--` prefix); `nil` on overflow.
  static func encode(_ label: String) -> String? {
    let input = label.unicodeScalars.map { Int($0.value) }
    var output = input.filter { $0 < 0x80 }.map { Character(Unicode.Scalar(UInt8($0))) }
    let basicCount = output.count
    var handled = basicCount

    if basicCount > 0 {
      output.append("-")
    }

    var n = initialN
    var delta = 0
    var bias = initialBias

    while handled < input.count {
      guard let next = input.filter({ $0 >= n }).min() else {
        return nil
      }

      let (scaled, overflow) = (next - n).multipliedReportingOverflow(by: handled + 1)

      guard !overflow else {
        return nil
      }

      delta += scaled
      n = next

      for code in input {
        if code < n {
          delta += 1
        }

        if code == n {
          var q = delta
          var k = base

          while true {
            let t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias)

            if q < t {
              break
            }

            output.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }

          output.append(digit(q))
          bias = adapt(delta, handled + 1, handled == basicCount)
          delta = 0
          handled += 1
        }
      }

      delta += 1
      n += 1
    }

    return String(output)
  }

  private static func digit(_ value: Int) -> Character {
    Character(Unicode.Scalar(UInt8(value < 26 ? value + 0x61 : value - 26 + 0x30)))
  }

  private static func adapt(_ delta: Int, _ count: Int, _ first: Bool) -> Int {
    var delta = first ? delta / damp : delta / 2
    delta += delta / count
    var k = 0

    while delta > ((base - tMin) * tMax) / 2 {
      delta /= base - tMin
      k += base
    }

    return k + (base - tMin + 1) * delta / (delta + skew)
  }
}
