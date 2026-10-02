const fs = require('fs')
const path = require('path')

const { withDangerousMod } = require('expo/config-plugins')

// Xcode 26 refuses to build anything below iOS 15. `platform :ios` in the Podfile
// covers the pod targets themselves, but not the resource-bundle targets
// CocoaPods synthesises from a podspec, which keep whatever the podspec declares.
// @react-native-async-storage/async-storage still says 13.4, so a stock prebuild
// fails to compile. This raises the floor for every target in the Pods project
// and leaves anything already higher alone.
//
// Drop this plugin once the dependencies ship podspecs with a supported minimum.
const MARKER = '# hermie: deployment target floor'

function snippet(deploymentTarget) {
  return [
    `    ${MARKER}`,
    '    installer.pods_project.targets.each do |pod_target|',
    '      pod_target.build_configurations.each do |build_configuration|',
    "        declared = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
    `        next if declared.nil? || Gem::Version.new(declared) >= Gem::Version.new('${deploymentTarget}')`,
    `        build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${deploymentTarget}'`,
    '      end',
    '    end',
    ''
  ].join('\n')
}

module.exports = function withIosDeploymentTargetFloor(config, options = {}) {
  const deploymentTarget = options.deploymentTarget ?? '15.1'

  return withDangerousMod(config, [
    'ios',
    async modConfig => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile')
      const contents = fs.readFileSync(podfilePath, 'utf8')

      if (contents.includes(MARKER)) {
        return modConfig
      }

      const anchor = '  post_install do |installer|\n'
      const anchorIndex = contents.indexOf(anchor)
      if (anchorIndex === -1) {
        throw new Error('Could not find the post_install block in the generated Podfile; the plugin needs updating.')
      }

      const insertAt = anchorIndex + anchor.length
      const patched = contents.slice(0, insertAt) + snippet(deploymentTarget) + contents.slice(insertAt)
      fs.writeFileSync(podfilePath, patched)

      return modConfig
    }
  ])
}
