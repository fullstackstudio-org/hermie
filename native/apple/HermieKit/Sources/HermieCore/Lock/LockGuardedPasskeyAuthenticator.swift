import Foundation

/**
 A passkey authenticator that tells the app lock while its system sheet is up (plan P10: `AppLock`
 treats the ceremony like its own prompt, so the sheet's resign does not re-lock the app under it).

 It wraps the authenticator itself rather than following `PasskeyConfirmPhase.signing`, because
 the authenticator is the one place that knows when the sheet is up: an enrolment, an invite and a
 revoke run a ceremony without a confirmation, and a withdrawn confirmation leaves `.signing`
 before the sheet has closed. One wrapper sits around the app's one authenticator, shared by every
 gateway's session.
 */
public struct LockGuardedPasskeyAuthenticator: PasskeyAuthenticator {
  let base: any PasskeyAuthenticator
  let lock: AppLock

  public init(_ base: any PasskeyAuthenticator, lock: AppLock) {
    self.base = base
    self.lock = lock
  }

  public func register(_ request: PasskeyRegistrationRequest) async throws(PasskeyCeremonyError) -> PasskeyRegistration {
    await lock.ceremonyBegan()

    do {
      let registration = try await base.register(request)
      await lock.ceremonyEnded()
      return registration
    } catch {
      await lock.ceremonyEnded()
      throw error
    }
  }

  public func assert(_ request: PasskeyAssertionRequest) async throws(PasskeyCeremonyError) -> PasskeyAssertionResponse {
    await lock.ceremonyBegan()

    do {
      let response = try await base.assert(request)
      await lock.ceremonyEnded()
      return response
    } catch {
      await lock.ceremonyEnded()
      throw error
    }
  }

  public func cancel() async {
    await base.cancel()
  }
}
