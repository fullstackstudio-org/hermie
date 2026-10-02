require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieIntents'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only, and that includes the Mac: "Designed for iPad" runs this same
  # slice, where the App Shortcuts appear in the Mac's own Shortcuts app.
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # CoreSpotlight for `indexBots`. App Intents are NOT here — see the note on
  # `source_files` and the long version in `plugin/with-hermie-intents.js`.
  s.frameworks = 'CoreSpotlight', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # NOT `**/*`, and the reason is the opposite of the other two modules'.
  #
  # `HermieWidgets` and `HermieShare` exclude a sibling directory because it
  # belongs to a separate EXTENSION target. `../intents/` belongs to the APP
  # target — it has to, because Xcode's App Intents metadata extraction runs per
  # target over that target's own Swift sources, and an `AppShortcutsProvider`
  # compiled into a static library is one Apple's documentation puts in the app.
  # So the plugin copies `../intents/` into the app's own group and sources
  # phase, and this glob must not ALSO pull it into the pod: the same file in
  # two compilation units is a duplicate-symbol link error.
  s.source_files = '*.{h,m,mm,swift}'
end
