import HermieCore
import SwiftUI
import WebKit

/**
 The fallback sign-in: the gateway's sign-in page inside Hermie (ADR-0004), shown as a sheet.

 The web view is forgetful on purpose: a non-persistent data store per attempt, so it never picks up a
 browser session and never leaves one behind. Every navigation is put to `InAppSignInAttempt.decide`
 (only http and https; nothing on this device but the gateway's own origin; the callback is taken out,
 never loaded). The extra headers ride on the first load only, and the front door's script is added
 at document start on the main frame, where it only acts on the gateway's own origin.
 */
struct InAppSignInPage: View {
  let attempt: InAppSignInAttempt

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      SignInWebView(attempt: attempt)
        .ignoresSafeArea(edges: .bottom)
        .overlay {
          if attempt.phase == .exchanging || attempt.phase == .finished {
            VStack(spacing: 12) {
              ProgressView()
              Text(Strings.App.Onboarding.SignIn.Webview.exchanging)
            }
            .padding(24)
            .background(.regularMaterial, in: .rect(cornerRadius: 16))
          }
        }
        .navigationTitle(Strings.App.Onboarding.SignIn.Webview.title)
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button(Strings.App.Common.cancel) {
              attempt.cancel()
              dismiss()
            }
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("hermie.signIn.inApp.cancel")
          }
        }
    }
    #if os(macOS)
      .frame(minWidth: 520, minHeight: 640)
    #endif
    .accessibilityIdentifier("hermie.signIn.inApp")
  }
}

/// The web view itself, and its navigation delegate.
@MainActor
struct SignInWebView {
  let attempt: InAppSignInAttempt

  func makeCoordinator() -> Coordinator {
    Coordinator(attempt: attempt)
  }

  @MainActor
  static func makeWebView(attempt: InAppSignInAttempt, coordinator: Coordinator) -> WKWebView {
    let configuration = WKWebViewConfiguration()

    configuration.websiteDataStore = .nonPersistent()

    if !attempt.userScript.isEmpty {
      configuration.userContentController.addUserScript(
        WKUserScript(source: attempt.userScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
      )
    }

    let webView = WKWebView(frame: .zero, configuration: configuration)

    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator

    var request = URLRequest(url: attempt.authorizeURL)

    for (name, value) in attempt.headers {
      request.setValue(value, forHTTPHeaderField: name)
    }

    webView.load(request)
    return webView
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    let attempt: InAppSignInAttempt

    init(attempt: InAppSignInAttempt) {
      self.attempt = attempt
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      guard let url = navigationAction.request.url else {
        return .cancel
      }

      return await attempt.decide(url.absoluteString) == .allow ? .allow : .cancel
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationResponse: WKNavigationResponse
    ) async -> WKNavigationResponsePolicy {
      // Only the page the attempt opened matters; a provider's own sub-page error is its business.
      if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
        response.statusCode >= 400, response.url == attempt.authorizeURL {
        attempt.pageFailed(status: response.statusCode)
        return .cancel
      }

      return .allow
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
      failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
      failed(error)
    }

    /// A link that wants a new window opens here instead, under the same rules.
    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if navigationAction.targetFrame == nil {
        webView.load(navigationAction.request)
      }

      return nil
    }

    private func failed(_ error: any Error) {
      let error = error as NSError

      // A navigation this delegate cancelled (the callback, a blocked address) is not a failure.
      if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
        return
      }

      if error.domain == "WebKitErrorDomain" && error.code == 102 {
        return
      }

      attempt.pageFailed(status: nil)
    }
  }
}

#if os(iOS)
  extension SignInWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
      Self.makeWebView(attempt: attempt, coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
      webView.stopLoading()
      webView.navigationDelegate = nil
      webView.uiDelegate = nil
    }
  }
#else
  extension SignInWebView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
      Self.makeWebView(attempt: attempt, coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
      webView.stopLoading()
      webView.navigationDelegate = nil
      webView.uiDelegate = nil
    }
  }
#endif
