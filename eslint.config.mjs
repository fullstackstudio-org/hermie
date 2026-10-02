import js from '@eslint/js'
import expoFlatConfig from 'eslint-config-expo/flat.js'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'
import { config, configs } from 'typescript-eslint'

export default config(
  {
    ignores: [
      '**/node_modules/**',
      // Scratch worktrees checked out inside the repo (any hidden tool
      // directory). They hold another commit of this same tree, so linting
      // them lints every file twice and reports whatever that other commit
      // happened to be mid-change on.
      '.*/worktrees/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      'expo/hermie/ios/**',
      'expo/hermie/android/**',
      // Rust build output; not JS/TS at all.
      'apps/desktop/src-tauri/target/**',
      // Vendored upstream sources are linted by their own project, not by ours.
      'packages/hermes-shared/src/**'
    ]
  },
  js.configs.recommended,
  ...expoFlatConfig,
  ...configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart']
    }
  },
  {
    // @hermie/gateway-client has to run on Hermes (React Native) as well as in
    // Node, so it may never reach for a Node built-in.
    files: ['packages/gateway-client/src/**/*.ts'],
    ignores: ['packages/gateway-client/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message: 'packages/gateway-client runs on React Native; Node built-ins are not available there.'
            }
          ]
        }
      ]
    }
  },
  {
    // Build tooling and repo scripts run in Node, not in the app runtime.
    files: [
      'scripts/**/*.mjs',
      '{apps,expo}/*/scripts/**/*.mjs',
      '{apps,expo}/*/plugins/**/*.js',
      // A config plugin that lives inside the local module it installs, rather
      // than in expo/hermie/plugins/ with the three that only patch the app's
      // own project. Same runtime, same rules.
      '{apps,expo}/*/modules/*/plugin/**/*.js',
      // The published entry point of @hermie/web. It is CommonJS on purpose —
      // it has to run before anything is bundled, from a package with no build
      // step of its own — so `require` is the only import it can use.
      'packages/hermie-web/bin/*.js',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.ts',
      'packages/*/src/cli.ts',
      // The golden-corpus tooling (`npm run golden`): generators and the
      // transcript recorder, none of which runs in the app.
      'scripts/golden/**/*.ts',
      'packages/*/scripts/**/*.ts',
      'packages/transcript/golden/**/*.ts'
    ],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Test suites and their setup run under Jest, which supplies `jest` and a
    // CommonJS `require` that mock factories are expected to use.
    files: [
      '{apps,expo}/*/jest.setup.js',
      '{apps,expo}/*/jest.after-env.js',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx'
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  prettierConfig
)
