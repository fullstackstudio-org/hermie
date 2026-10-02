require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HermieShare'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  # iOS only, and that includes the Mac: "Designed for iPad" runs this same
  # slice, and a share extension in it appears in the Mac's own share menu.
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # NOT `**/*`, for the same reason `HermieWidgets.podspec` says it twice: the
  # extension's Swift — its view controller, its SwiftUI sheet and its
  # `@objc(ShareViewController)` entry point — lives one directory up in
  # `../share/`, and it belongs to a DIFFERENT target. Compiled into the app it
  # would drag SwiftUI and a principal class into a binary that has no use for
  # either. The glob stops at this directory's own files so that it cannot
  # reach them even by accident.
  s.source_files = '*.{h,m,mm,swift}'
end
