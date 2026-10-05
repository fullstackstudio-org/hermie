import Foundation
import HermieCore
import HermieGateway

/// The QR pairing screens' own sentences, from `Resources/Native.xcstrings`.
extension NativeStrings {
  enum Pairing {
    /// Scan QR code (the button in setup that opens the scanner)
    static var scan: String { String(localized: "native.pairing.scan", table: "Native", bundle: .module) }
    /// Scan the code another device shows under Settings, Gateways, Share via QR, or choose a picture of it. (under the button)
    static var scanFooter: String {
      String(localized: "native.pairing.scanFooter", table: "Native", bundle: .module)
    }

    /// The scanner's own sheet.
    enum Sheet {
      /// Scan a gateway (title)
      static var title: String { String(localized: "native.pairing.sheet.title", table: "Native", bundle: .module) }
      /// Hold the code in front of the camera. It turns on when you press Scan.
      static var intro: String { String(localized: "native.pairing.sheet.intro", table: "Native", bundle: .module) }
      /// Scan (the button that turns the camera on)
      static var start: String { String(localized: "native.pairing.sheet.start", table: "Native", bundle: .module) }
      /// Aim the camera at the QR code.
      static var aim: String { String(localized: "native.pairing.sheet.aim", table: "Native", bundle: .module) }
      /// Camera (the scanner's accessibility label)
      static var camera: String { String(localized: "native.pairing.sheet.camera", table: "Native", bundle: .module) }
      /// Choose a picture (opens the photo picker to read a code from a picture)
      static var chooseImage: String {
        String(localized: "native.pairing.sheet.chooseImage", table: "Native", bundle: .module)
      }
      /// Scan again
      static var again: String { String(localized: "native.pairing.sheet.again", table: "Native", bundle: .module) }
      /// Hermie cannot use the camera. Allow it in Settings, or choose a picture of the code.
      static var denied: String { String(localized: "native.pairing.sheet.denied", table: "Native", bundle: .module) }
      /// The camera is turned off on this device by a profile or a restriction.
      static var restricted: String {
        String(localized: "native.pairing.sheet.restricted", table: "Native", bundle: .module)
      }
      /// No camera could be used here. Choose a picture of the code instead.
      static var noCamera: String {
        String(localized: "native.pairing.sheet.noCamera", table: "Native", bundle: .module)
      }
      /// A gateway code was found. (announced)
      static var found: String { String(localized: "native.pairing.sheet.found", table: "Native", bundle: .module) }
    }

    /// What an offered gateway is, before it is taken.
    enum Offer {
      /// Add this gateway? (title)
      static var title: String { String(localized: "native.pairing.offer.title", table: "Native", bundle: .module) }
      /// Host (the machine the gateway is on, shown first)
      static var host: String { String(localized: "native.pairing.offer.host", table: "Native", bundle: .module) }
      /// Name
      static var name: String { String(localized: "native.pairing.offer.name", table: "Native", bundle: .module) }
      /// Address
      static var address: String { String(localized: "native.pairing.offer.address", table: "Native", bundle: .module) }
      /// Sign-in (how the gateway signs people in)
      static var signIn: String { String(localized: "native.pairing.offer.signIn", table: "Native", bundle: .module) }
      /// Encrypted connection (https)
      static var secure: String { String(localized: "native.pairing.offer.secure", table: "Native", bundle: .module) }
      /// Plain http, accepted only because the gateway is on this device or this network.
      static var local: String { String(localized: "native.pairing.offer.local", table: "Native", bundle: .module) }
      /// The code holds only an address and a name. Nothing is added until you continue, and then you sign in yourself.
      static var note: String { String(localized: "native.pairing.offer.note", table: "Native", bundle: .module) }
      /// The name comes from the code and is not checked. Continue only if you know where the code came from.
      static var unverified: String {
        String(localized: "native.pairing.offer.unverified", table: "Native", bundle: .module)
      }
      /// Continue (to sign in)
      static var add: String { String(localized: "native.pairing.offer.add", table: "Native", bundle: .module) }
      /// You already have this gateway.
      static var have: String { String(localized: "native.pairing.offer.have", table: "Native", bundle: .module) }
    }

    /// How a gateway signs people in, as a code names it.
    static func auth(_ mode: GatewayAuthMode) -> String {
      switch mode {
      case .nativePKCE: String(localized: "native.pairing.auth.nativePKCE", table: "Native", bundle: .module)
      case .sessionToken: String(localized: "native.pairing.auth.sessionToken", table: "Native", bundle: .module)
      case .cookie: String(localized: "native.pairing.auth.cookie", table: "Native", bundle: .module)
      }
    }

    /// Why a code or a link cannot be taken.
    static func problem(_ problem: GatewayPairingOffer.Problem) -> String {
      switch problem {
      case .notAnOffer:
        String(localized: "native.pairing.problem.notAnOffer", table: "Native", bundle: .module)
      case .notAnAddress:
        String(localized: "native.pairing.problem.notAnAddress", table: "Native", bundle: .module)
      case .notSecure(let host):
        String(
          localized: "native.pairing.problem.notSecure",
          defaultValue:
            "The code points to \(host) over plain http. Only https is accepted from a code, except for a gateway on this device or a .local name. You can still add it by typing its address.",
          table: "Native", bundle: .module)
      }
    }

    /// Share via QR.
    enum Share {
      /// Share via QR (the action on a gateway, and the sheet's title)
      static var action: String { String(localized: "native.pairing.share.action", table: "Native", bundle: .module) }
      /// What the code holds, and what it does not.
      static var blurb: String { String(localized: "native.pairing.share.blurb", table: "Native", bundle: .module) }
      /// QR code for {name} (accessibility label)
      static func label(_ name: String) -> String {
        String(localized: "native.pairing.share.label", defaultValue: "QR code for \(name)", table: "Native", bundle: .module)
      }
      /// This gateway cannot be shared as a code. {reason}
      static func unavailable(_ reason: String) -> String {
        String(
          localized: "native.pairing.share.unavailable", defaultValue: "This gateway cannot be shared as a code. \(reason)",
          table: "Native", bundle: .module)
      }
      /// The code could not be drawn.
      static var failed: String { String(localized: "native.pairing.share.failed", table: "Native", bundle: .module) }
    }
  }
}
