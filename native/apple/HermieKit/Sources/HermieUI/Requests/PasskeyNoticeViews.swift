import HermieCore
import SwiftUI

/// What the passkey model wants the person to know that is not one confirmation: a passkey added
/// or removed without this device (`passkey.changed`), a gateway that does not identify itself as
/// the one the passkeys were set up for, a pin this device cannot read, a question whether two
/// stored gateways are one. Plain dismissible lines; the chat shows them under its banners, and
/// Settings → Gateways → Passkeys shows them too. Nothing here is silent.
public struct PasskeyNoticesView: View {
  let model: PasskeyModel?

  public init(model: PasskeyModel?) {
    self.model = model
  }

  public var body: some View {
    if let model, !model.notices.isEmpty {
      VStack(spacing: 6) {
        ForEach(model.notices) { notice in
          PasskeyNoticeRow(model: model, notice: notice)
            .padding(.leading, 12)
            .background(.regularMaterial, in: .rect(cornerRadius: 12))
        }
      }
      .padding(.horizontal)
      .padding(.vertical, 4)
    }
  }
}

/// One notice, its words, its one action when it has one, and the way to put it away.
struct PasskeyNoticeRow: View {
  let model: PasskeyModel
  let notice: PasskeyNotice

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: PasskeysText.noticeSymbol(notice.kind))
        .foregroundStyle(.orange)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 8) {
        // Built here from fixed sentences; a name in it is a passkey's or a gateway's own, as text.
        Text(verbatim: PasskeysText.notice(notice.kind))
          .font(.callout)
          .frame(maxWidth: .infinity, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)

        if case .sameGatewayAs(let storedID, _) = notice.kind, let action = PasskeysText.noticeAction(notice.kind) {
          Button(action) {
            Task { await model.linkPins(with: storedID) }
          }
          .buttonStyle(.bordered)
          .accessibilityIdentifier("hermie.passkeys.notice.link")
        }
      }

      Button(Strings.App.Common.dismiss, systemImage: "xmark") {
        model.dismissNotice(notice.id)
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.borderless)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(.rect)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("hermie.passkeys.notice")
  }
}
