require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieScene'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only, and that includes the Mac: "Designed for iPad" runs this same slice.
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  # There is one thing JavaScript asks this module, and it is not about scenes as such: the URL this
  # process was launched by, which `Linking.getInitialURL()` cannot answer under the scene life
  # cycle. See `HermieSceneDelegate.launchURL`. Everything else here is still invisible from
  # JavaScript — autolinking is what gets the pod into the build at all, and the app target's
  # `-ObjC` link flag is what keeps `HermieSceneDelegate` (which UIKit finds by the name in
  # Info.plist and nothing references at compile time) out of the linker's dead-strip.
  s.dependency 'ExpoModulesCore'

  # CoreSpotlight is here for two symbols: `CSSearchableItemActionType` and
  # `CSSearchableItemActivityIdentifier`. A tap on a bot found in Spotlight
  # arrives as a user activity React Native does not answer, and the scene
  # delegate turns it back into the `hermie://chat/<bot>` link it was indexed
  # under. See `continue(_:)`.
  s.frameworks = 'CoreSpotlight', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
