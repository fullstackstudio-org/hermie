import HermieCore
import SwiftUI

/**
 What a gateway that somebody offers is, before anything is done with it (NX-14): its name, its
 address, how it signs in, and whether it is reached over an encrypted connection, in plain text.

 Everything here came out of a QR code or a link, so it is shown as text and nothing else: no link
 is made of it, nothing is opened, and the page says so, and says that the name is the offering
 side's word and not checked.
 */
struct PairingOfferSummary: View {
  let offer: GatewayPairingOffer

  private typealias Words = NativeStrings.Pairing.Offer

  var body: some View {
    Section {
      // The host leads: it is where the person will be sending their sign-in, and the one thing here the
      // code cannot dress up. The name is the code's word.
      LabeledContent(Words.host) {
        Text(verbatim: offer.host)
          .font(.headline.monospaced())
          .multilineTextAlignment(.trailing)
          .textSelection(.enabled)
      }
      .accessibilityIdentifier("hermie.pairing.host")

      if !offer.name.isEmpty {
        LabeledContent(Words.name) {
          Text(verbatim: offer.name)
            .multilineTextAlignment(.trailing)
        }
        .accessibilityIdentifier("hermie.pairing.name")
      }

      LabeledContent(Words.address) {
        Text(verbatim: offer.address)
          .font(.callout.monospaced())
          .multilineTextAlignment(.trailing)
          .textSelection(.enabled)
      }
      .accessibilityIdentifier("hermie.pairing.address")

      if let auth = offer.authHint {
        LabeledContent(Words.signIn) {
          Text(NativeStrings.Pairing.auth(auth))
        }
        .accessibilityIdentifier("hermie.pairing.signIn")
      }

      Label(
        offer.isSecure ? Words.secure : Words.local,
        systemImage: offer.isSecure ? "lock.fill" : "lock.open"
      )
      .accessibilityIdentifier("hermie.pairing.security")
    } footer: {
      VStack(alignment: .leading, spacing: 6) {
        SettingsNote(Words.note)
        SettingsNote(Words.unverified)
      }
    }
  }
}

/**
 A gateway offered by a link (a scanned QR code opened in Camera, a message, a web page): the sheet
 the router shows (`AppSheet.pairing`). Continue opens setup for a new gateway with the address and
 name filled in, and setup goes straight on to sign-in once the gateway has answered; Cancel drops it.

 A link can come from anybody, so this is only ever an offer: nothing is stored, probed or opened until
 Continue, and a gateway the person already has cannot be added a second time.
 */
struct PairingConfirmSheet: View {
  let offer: GatewayPairingOffer

  @Environment(AppRouter.self) private var router
  @Environment(AppLaunch.self) private var launch

  private var alreadyHave: Bool {
    launch.gateways.entries.contains { offer.matches(address: $0.address) }
  }

  var body: some View {
    NavigationStack {
      Form {
        PairingOfferSummary(offer: offer)

        if alreadyHave {
          Section {
            Label(NativeStrings.Pairing.Offer.have, systemImage: "checkmark.circle")
              .accessibilityIdentifier("hermie.pairing.have")
          }
        }

        StepPrimarySection(
          title: NativeStrings.Pairing.Offer.add,
          enabled: !alreadyHave,
          busy: false
        ) {
          router.confirmPairing(offer)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(NativeStrings.Pairing.Offer.title)
      .toolbar { StepToolbar { router.dismissSheet() } }
    }
    #if os(macOS)
      .frame(minWidth: 480, idealWidth: 520, minHeight: 420, idealHeight: 480)
    #endif
    .accessibilityIdentifier("hermie.pairing.confirm")
  }
}
