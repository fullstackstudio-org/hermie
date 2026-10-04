import HermieCore
import SwiftUI

/// The launch's one-time notices and the router's last refusal, above the content, each dismissible.
struct NoticeStack: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(AppRouter.self) private var router

  var body: some View {
    VStack(spacing: 8) {
      ForEach(launch.notices) { notice in
        NoticeRow(text: Self.text(for: notice), systemImage: Self.symbol(for: notice)) {
          launch.dismiss(notice)
        }
      }

      if let notice = router.notice {
        NoticeRow(text: Self.text(for: notice), systemImage: "link.badge.plus") {
          router.dismissNotice()
        }
      }
    }
    .padding(.horizontal)
    .padding(.top, launch.notices.isEmpty && router.notice == nil ? 0 : 8)
    .animation(.default, value: launch.notices)
    .animation(.default, value: router.notice)
  }

  static func text(for notice: LaunchNotice) -> String {
    switch notice {
    case .recovered: NativeStrings.Notice.recovered
    case .lockSettingNotRestored: NativeStrings.Notice.lockSettingNotRestored
    case .runningInMemory: NativeStrings.Notice.runningInMemory
    }
  }

  static func symbol(for notice: LaunchNotice) -> String {
    switch notice {
    case .recovered: "externaldrive.badge.checkmark"
    case .lockSettingNotRestored: "lock.trianglebadge.exclamationmark"
    case .runningInMemory: "externaldrive.badge.exclamationmark"
    }
  }

  static func text(for notice: RouterNotice) -> String {
    switch notice {
    case .gatewayNotConfigured: NativeStrings.Notice.gatewayNotConfigured
    case .noGatewayYet: NativeStrings.Notice.noGateway
    }
  }
}

/// One notice: a line of text of at most `ComposerView.noticeLineLimit` lines, the whole of it in the
/// tooltip, and a dismiss button.
///
/// The text wraps (`fixedSize(vertical:)`), and SwiftUI measures a window's minimum size at the
/// narrowest width it probes, where a long or unbreakable text takes a line every few letters: left
/// unbounded, a long notice at the top of the root view raised the window's minimum by thousands of
/// points (see `ChatNoticeLayoutTests`). The line cap keeps that measure to a few lines.
struct NoticeRow: View {
  let text: String
  let systemImage: String
  let dismiss: () -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: systemImage)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)

      Text(text)
        .lineLimit(ComposerView.noticeLineLimit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .help(text)

      Button(Strings.App.Common.dismiss, systemImage: "xmark", action: dismiss)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
    }
    .padding(.leading, 12)
    .padding(.vertical, 4)
    .background(.regularMaterial, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.notice")
  }
}
