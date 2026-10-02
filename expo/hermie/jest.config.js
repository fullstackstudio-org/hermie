module.exports = {
  // Keep the microtask family real when a test switches to fake timers:
  // the testing library's cleanup awaits a microtask flush, and faking these
  // on Node 22 makes that flush hang until the hook times out.
  fakeTimers: { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] },
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.after-env.js'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)', '<rootDir>/src/**/*.test.ts?(x)'],
  transformIgnorePatterns: [
    // `@noble/hashes` (PKCE, via @hermie/gateway-client) ships ESM only, so it
    // has to go through babel like the React Native packages do. `marked` (the
    // Markdown lexer) resolves to its ESM build under the react-native
    // condition, so it needs the same treatment.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble/.*|marked|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-webview|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg))'
  ]
}
