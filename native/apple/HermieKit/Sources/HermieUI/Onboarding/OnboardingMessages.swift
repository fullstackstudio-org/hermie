import HermieCore
import HermieGateway
import SwiftUI

/// The sentences for what the onboarding model found, in the app's voice (`describeProbeError` and
/// friends in the Expo app). The model holds codes; these read them.
@MainActor
enum OnboardingMessages {
  enum Tone {
    case checking
    case ok
    case error
  }

  /// The probe line under the address, and its tone; nil when there is nothing to say.
  static func probeLine(_ model: OnboardingModel) -> (text: String, tone: Tone)? {
    switch model.probe {
    case .idle:
      return nil
    case .checking(let pinned):
      return (pinned.map { Strings.App.Onboarding.Address.probingScheme(scheme: $0) } ?? Strings.App.Onboarding.Address.probingBoth, .checking)
    case .failed(let failure):
      return (probeFailure(failure), .error)
    case .found(let found):
      let result = found.result
      let pinned = GatewayAddress.hasExplicitScheme(model.address.trimmingCharacters(in: .whitespacesAndNewlines))
      let scheme =
        pinned
        ? "" : " · " + (found.foundOverHTTP ? Strings.App.Transport.foundOverHttp : Strings.App.Transport.foundOverHttps)

      if !result.authRequired {
        return (Strings.App.Onboarding.Address.sessionTokenRequired(version: result.version) + scheme, .ok)
      }

      if result.providers.isEmpty {
        return (Strings.App.Onboarding.Address.signInRequiredNoProviders(version: result.version) + scheme, .error)
      }

      let names = result.providers.map(\.displayName)

      return (Strings.App.Onboarding.Address.signInRequired(version: result.version, providers: names) + scheme, .ok)
    }
  }

  static func probeFailure(_ failure: OnboardingModel.ProbeFailure) -> String {
    let host = failure.host
    let hints = [
      failure.verdict.landingPage ? Strings.App.Errors.landingPage : "",
      failure.verdict.hint == .privateNetwork ? Strings.App.Errors.privateNetworkOnly : ""
    ]
    let withHints = { (message: String) in ([message] + hints).filter { !$0.isEmpty }.joined(separator: " ") }

    switch failure.kind {
    case .network?:
      return withHints(failure.httpsWasPinned ? Strings.App.Errors.networkOverHttps(host: host) : Strings.App.Errors.network(host: host))
    case .tls?:
      return Strings.App.Errors.tls(host: host)
    case .timeout?:
      return Strings.App.Errors.timeout(host: host)
    case .notHermes?:
      return withHints(Strings.App.Errors.notHermes(host: host))
    case .redirect?:
      return Strings.App.Errors.redirected(from: host, to: redirectDestination(failure))
    case .auth?:
      return Strings.App.Errors.authProxy(status: failure.status ?? 401)
    case .server?:
      return Strings.App.Errors.server(status: failure.status ?? 500)
    case .incompatible?:
      return Strings.App.Errors.incompatible
    case .config?:
      return failure.message.isEmpty ? Strings.App.Errors.unknown : failure.message
    case .protocol?, nil:
      return Strings.App.Errors.unknown
    }
  }

  /// Where a redirect went: the host, or the whole origin when the host is the same one.
  static func redirectDestination(_ failure: OnboardingModel.ProbeFailure) -> String {
    guard let target = failure.redirectedTo, !target.isEmpty else {
      return Strings.App.Settings.unknown
    }

    if target == failure.host, let origin = failure.redirectedOrigin, !origin.isEmpty {
      return origin
    }

    return target
  }

  /// What the "Use … instead" button names: the host for a plain `https://host`, else the origin.
  static func redirectLabel(host: String, origin: String?) -> String {
    guard let origin, !origin.isEmpty else {
      return host
    }

    let bracketed = host.contains(":") ? "[\(host)]" : host

    return origin == "https://\(bracketed)" ? host : origin
  }

  /// The one line about a cleartext address (ADR-0014).
  static func cleartext(_ privacy: HostPrivacy) -> String {
    switch privacy {
    case .loopback: Strings.App.Transport.httpLoopback
    case .private, .linkLocal, .localName: Strings.App.Transport.httpLocalNetwork
    case .cgnat, .tailnet: Strings.App.Transport.httpTailnet
    case .public: Strings.App.Transport.httpExposed
    }
  }

  static func headerProblem(_ problem: OnboardingModel.HeaderProblem) -> String {
    switch problem {
    case .invalidName: NativeStrings.Onboarding.headerInvalidName
    case .reserved: NativeStrings.Onboarding.headerReserved
    }
  }

  static func signInProblem(_ problem: SignInProblem, host: String, sessionToken: Bool) -> String {
    switch problem {
    case .portInUse: NativeStrings.SignIn.portInUse
    case .listenerUnavailable: NativeStrings.SignIn.listenerUnavailable
    case .browserUnavailable: NativeStrings.SignIn.browserUnavailable
    case .cancelled: Strings.App.Onboarding.SignIn.Webview.cancelled
    case .timedOut: Strings.App.Onboarding.SignIn.Webview.timeout
    case .couldNotStart, .noCode, .blockedNavigation: Strings.App.Onboarding.SignIn.Webview.noCode
    case .stateMismatch: Strings.App.Onboarding.SignIn.Webview.stateMismatch
    // A fixed sentence: the provider's own text is not shown to the person (it is any page's to set).
    case .provider: NativeStrings.SignIn.providerRefused
    case .rejected: sessionToken ? NativeStrings.SignIn.tokenRejected : Strings.App.Errors.signedOut
    case .exchange(let kind, let status), .check(let kind, let status): gatewayProblem(kind, status: status, host: host)
    case .pageLoad(let status?): Strings.App.Onboarding.SignIn.Webview.httpError(status: status)
    case .pageLoad(nil): NativeStrings.SignIn.pageLoadFailed
    }
  }

  static func gatewayProblem(_ kind: GatewayErrorKind, status: Int?, host: String) -> String {
    switch kind {
    case .network: Strings.App.Errors.network(host: host)
    case .timeout: Strings.App.Errors.timeout(host: host)
    case .tls: Strings.App.Errors.tls(host: host)
    case .server: Strings.App.Errors.server(status: status ?? 500)
    case .auth: Strings.App.Errors.signedOut
    case .incompatible: Strings.App.Errors.incompatible
    default: Strings.App.Errors.unknown
    }
  }

  static func saveProblem(_ problem: OnboardingModel.SaveProblem) -> String {
    switch problem {
    case .keychain: Strings.App.Onboarding.Done.credentialsNotStored(reason: NativeStrings.Onboarding.keychainReason)
    case .store: Strings.App.Onboarding.Done.saveFailed(message: NativeStrings.Onboarding.storeReason)
    case .unsupportedRegistry: NativeStrings.Onboarding.unsupportedRegistry
    case .gatewayRemoved: NativeStrings.Onboarding.gatewayRemoved
    case .addressChanged: NativeStrings.Onboarding.addressChanged
    }
  }

  /// A catalogue sentence that carries Markdown (a code span).
  static func markdown(_ text: String) -> Text {
    Text((try? AttributedString(markdown: text)) ?? AttributedString(text))
  }
}

/// One line of status: a symbol for its tone, then the sentence.
struct StatusLine: View {
  let text: String
  let tone: OnboardingMessages.Tone

  var body: some View {
    Label {
      Text(text)
    } icon: {
      switch tone {
      case .checking:
        ProgressView()
          .controlSize(.small)
      case .ok:
        Image(systemName: "checkmark.circle.fill")
          .foregroundStyle(.green)
      case .error:
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/**
 A note inside a step's section, as a plain row. Not a section footer, nor a smaller font: both failed
 the Dynamic Type audit in the setup sheet, where a plain row's text follows every size.
 */
struct StepNote: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
  }
}
