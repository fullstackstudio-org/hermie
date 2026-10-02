const { getDefaultConfig } = require('expo/metro-config')

// `watchFolders` and `resolver.nodeModulesPaths` are left as Expo computed them.
// Expo already walks the npm workspaces and watches the hoisted root
// node_modules plus every workspace package. Adding the workspace root itself
// would move Metro's server root up to the repo root, and the native apps ask
// for `/index.bundle`, which only resolves when the server root is this package.
module.exports = getDefaultConfig(__dirname)
