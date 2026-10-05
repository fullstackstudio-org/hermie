import CoreGraphics
import HermieCore
import SwiftUI

/**
 "Share via QR" on a gateway (NX-14): the gateway's pairing code, for another device or a colleague to
 scan under Add gateway.

 The code holds the address, the name the person gave the gateway (none when it goes by its host) and
 how it signs in, and nothing else: `GatewayPairingOffer` has no field for a password, a token, a
 header or the front door's keys, so there is nothing to leave out by mistake. Whoever scans it still
 signs in to the gateway with their own account. A gateway whose address would not be accepted from a
 code (plain http on a public host) says so instead of showing one the other side would refuse.
 */
struct ShareGatewayQRSheet: View {
  let entry: GatewayDirectory.Entry

  @Environment(\.dismiss) private var dismiss
  @State private var image: CGImage?
  @State private var drawn = false

  private var offer: Result<GatewayPairingOffer, GatewayPairingOffer.Problem> {
    GatewayPairingOffer.sharing(address: entry.address, name: entry.customName ?? "", authKind: entry.authKind)
  }

  var body: some View {
    NavigationStack {
      Form {
        switch offer {
        case .success(let offer):
          codeSection(offer)
        case .failure(let problem):
          Section {
            Label(
              NativeStrings.Pairing.Share.unavailable(NativeStrings.Pairing.problem(problem)),
              systemImage: "exclamationmark.triangle"
            )
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("hermie.pairing.share.unavailable")
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.Pairing.Share.action)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(role: .close) { dismiss() }
            .accessibilityIdentifier("hermie.pairing.share.close")
        }
      }
    }
    #if os(macOS)
      .frame(minWidth: 420, idealWidth: 460, minHeight: 520, idealHeight: 580)
    #endif
    .accessibilityIdentifier("hermie.pairing.share")
  }

  @ViewBuilder private func codeSection(_ offer: GatewayPairingOffer) -> some View {
    Section {
      VStack(spacing: 12) {
        qr(offer)

        Text(verbatim: entry.displayLabel)
          .font(.headline)

        Text(verbatim: offer.host)
          .font(.callout.monospaced())
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
      .listRowBackground(Color.clear)
    } footer: {
      SettingsNote(NativeStrings.Pairing.Share.blurb)
    }
  }

  @ViewBuilder private func qr(_ offer: GatewayPairingOffer) -> some View {
    Group {
      if let image {
        Image(decorative: image, scale: 1)
          .interpolation(.none)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: 280, maxHeight: 280)
          .accessibilityHidden(false)
          .accessibilityLabel(NativeStrings.Pairing.Share.label(entry.displayLabel))
          .accessibilityAddTraits(.isImage)
      } else if drawn {
        Label(NativeStrings.Pairing.Share.failed, systemImage: "exclamationmark.triangle")
      } else {
        ProgressView()
          .frame(width: 280, height: 280)
      }
    }
    .accessibilityIdentifier("hermie.pairing.share.code")
    .task(id: offer) {
      image = offer.linkString.flatMap { PairingQRCode.image(for: $0) }
      drawn = true
    }
  }
}
