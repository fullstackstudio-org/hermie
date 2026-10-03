import XCTest

/// The audit checks that exist on iOS only. On the Mac they are an empty set, so a comparison with
/// them is false and the file builds for both (`scripts/test.sh --ui-mac`).
extension XCUIAccessibilityAuditType {
  static var dynamicTypeCheck: XCUIAccessibilityAuditType {
    #if os(iOS)
      .dynamicType
    #else
      []
    #endif
  }

  static var textClippedCheck: XCUIAccessibilityAuditType {
    #if os(iOS)
      .textClipped
    #else
      []
    #endif
  }
}
