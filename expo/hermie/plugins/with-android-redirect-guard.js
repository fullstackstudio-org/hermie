const fs = require('node:fs')
const path = require('node:path')

const { withDangerousMod, withMainApplication } = require('expo/config-plugins')

// On Android, a redirect that changes the origin is not followed by JavaScript's `fetch`.
//
// React Native's `fetch` ignores `redirect: 'manual'`, and OkHttp under it follows a redirect
// with every header the request carried: OkHttp strips `Authorization` on an origin change and
// nothing else, so a Cloudflare Access service token and the gateway's session token went to
// whatever host a 302 named — and OkHttp also follows https to http. The gateway client notices
// afterwards (`response.url` is from another origin) and refuses the answer, but by then the
// credentials have been sent, and a 307 or 308 has replayed the body too: a refresh token, an
// uploaded file.
//
// So this stops the follow itself. A network interceptor sees each hop before OkHttp decides
// whether to follow it, and OkHttp only follows a redirect that has a `Location`; for one whose
// target is a different origin (scheme, host or port), the interceptor moves `Location` to
// `X-Hermie-Refused-Location`. OkHttp then hands the 3xx to JavaScript as the answer, and the
// gateway client reports it as a `redirect` failure that still names where it went.
//
// Scope, deliberately: only the client React Native's networking module builds for `fetch` and
// `XMLHttpRequest` (`NetworkingModule.setCustomClientBuilder`). Images (Fresco), WebSockets and
// the sign-in web view have clients of their own and are unchanged. A redirect within one origin
// is followed exactly as before.
const MARKER = '// hermie: android redirect guard'

/** The header the refused target travels in; `REFUSED_LOCATION_HEADER` in the gateway client. */
const REFUSED_LOCATION_HEADER = 'X-Hermie-Refused-Location'

const CLASS_NAME = 'HermieRedirectGuard'

/** The Kotlin source, in the app's own package so `MainApplication` reaches it without an import. */
function guardSource(packageName) {
  return `package ${packageName}

import com.facebook.react.modules.network.NetworkingModule
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Written by plugins/with-android-redirect-guard.js at prebuild; edit it there.
 *
 * Refuses, for JavaScript's fetch and XMLHttpRequest, every redirect whose target is a different
 * origin than the request's: OkHttp would carry every header but Authorization to it, and would
 * go from https to http. The 3xx reaches JavaScript with Location moved to ${REFUSED_LOCATION_HEADER}.
 */
object ${CLASS_NAME} : Interceptor {
  private const val REFUSED_LOCATION = "${REFUSED_LOCATION_HEADER}"

  /** Called once from MainApplication.onCreate, before the first request. */
  fun install() {
    NetworkingModule.setCustomClientBuilder { builder -> builder.addNetworkInterceptor(this) }
  }

  override fun intercept(chain: Interceptor.Chain): Response {
    val request = chain.request()
    val response = chain.proceed(request)

    if (!response.isRedirect) {
      return response
    }

    val location = response.header("Location") ?: return response
    val from = request.url
    val target = from.resolve(location)

    if (target != null && target.scheme == from.scheme && target.host == from.host && target.port == from.port) {
      return response
    }

    return response.newBuilder()
      .removeHeader("Location")
      .header(REFUSED_LOCATION, target?.toString() ?: "")
      .build()
  }
}
`
}

/**
 * Call the guard first thing in `onCreate`, before React Native can build its client.
 *
 * Throws on a template without `super.onCreate()` in `MainApplication`: a prebuild that
 * quietly produced an app without the guard would look fine and carry credentials across hosts.
 */
function addRedirectGuard(contents) {
  if (contents.includes(MARKER)) {
    return contents
  }

  const anchor = /(override fun onCreate\(\)[^{]*\{\s*\n)(\s*)(super\.onCreate\(\)\s*\n)/
  const match = anchor.exec(contents)

  if (!match) {
    throw new Error(
      'with-android-redirect-guard: MainApplication has no `override fun onCreate() { super.onCreate()` to install the redirect guard after. The template changed; update the plugin.'
    )
  }

  const [whole, head, indent, superCall] = match

  return contents.replace(whole, `${head}${indent}${superCall}${indent}${MARKER}\n${indent}${CLASS_NAME}.install()\n`)
}

function guardPath(projectRoot, packageName) {
  return path.join(projectRoot, 'app', 'src', 'main', 'java', ...packageName.split('.'), `${CLASS_NAME}.kt`)
}

function withAndroidRedirectGuard(config) {
  const packageName = config.android?.package

  if (!packageName) {
    throw new Error('with-android-redirect-guard: android.package is not set.')
  }

  config = withDangerousMod(config, [
    'android',
    async modConfig => {
      const file = guardPath(modConfig.modRequest.platformProjectRoot, packageName)

      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, guardSource(packageName))

      return modConfig
    }
  ])

  return withMainApplication(config, modConfig => {
    if (modConfig.modResults.language !== 'kt') {
      throw new Error('with-android-redirect-guard: MainApplication is not Kotlin; update the plugin.')
    }

    modConfig.modResults.contents = addRedirectGuard(modConfig.modResults.contents)

    return modConfig
  })
}

module.exports = withAndroidRedirectGuard
module.exports.addRedirectGuard = addRedirectGuard
module.exports.guardSource = guardSource
module.exports.guardPath = guardPath
module.exports.MARKER = MARKER
module.exports.REFUSED_LOCATION_HEADER = REFUSED_LOCATION_HEADER
module.exports.CLASS_NAME = CLASS_NAME
