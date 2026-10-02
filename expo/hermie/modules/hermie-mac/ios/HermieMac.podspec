require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieMac'
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

  s.dependency 'ExpoModulesCore'

  # GameController is what answers "is Shift down" and "was Escape pressed" below the responder
  # chain. Its own header says it is available to an application that links the framework; nothing
  # else — no entitlement, no Info.plist key.
  #
  # QuickLook is `QLPreviewController`, which is how a file attachment is opened. Also entitlement
  # free, and iOS API rather than Mac API — see `HermieQuickLook`.
  s.frameworks = 'GameController', 'QuickLook', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
