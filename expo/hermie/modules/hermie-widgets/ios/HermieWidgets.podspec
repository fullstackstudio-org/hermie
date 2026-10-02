require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieWidgets'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only, and that includes the Mac: "Designed for iPad" runs this same slice,
  # where the widgets appear in Notification Center rather than on a home screen.
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # WidgetKit is here for ONE call: `WidgetCenter.shared.reloadAllTimelines()`.
  # Everything that draws a widget is in `../widget/`, which is a different
  # target entirely — see the note on `source_files` below.
  s.frameworks = 'WidgetKit', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # NOT `**/*`, and this is the one line in this file worth reading twice. The
  # other local modules sweep their whole directory because everything in it
  # belongs to the app. This module has a second target's worth of Swift in it —
  # the extension's views, its timeline providers and its `@main` — and a `@main`
  # compiled into the app binary is a duplicate entry point and a link error. The
  # extension's sources live one directory up, in `../widget/`, so the glob
  # cannot reach them even by accident; this pattern stops at this directory's
  # own files for the same reason.
  s.source_files = '*.{h,m,mm,swift}'
end
