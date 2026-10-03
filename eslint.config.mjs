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
      '**/dist-maps/**',
      'native/web/.tsbuild/**',
      'native/web/dist-harness/**',
      'native/web/test-results/**',
      'native/web/playwright-report/**',
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
    // The browser client (`native/web`) is served as static files on the
    // gateway's own origin, next to the dashboard. A script-injection bug in it
    // would act with the signed-in person's session, so the ways of turning
    // text into markup are not available at all; the document's policy
    // (`index.html`) enforces the same thing at run time.
    files: ['native/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'The web client never injects HTML. Render elements instead.'
        },
        {
          selector: "Property[key.name='dangerouslySetInnerHTML']",
          message: 'The web client never injects HTML. Render elements instead.'
        },
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]",
          message: 'The web client never assigns innerHTML or outerHTML. Create elements instead.'
        },
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.computed=true][left.property.value=/^(innerHTML|outerHTML)$/]",
          message: 'The web client never assigns innerHTML or outerHTML. Create elements instead.'
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'The web client never injects HTML. Create elements instead.'
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
          message: 'The web client never writes markup into the document.'
        }
      ]
    }
  },
  {
    // Browser APIs reach the web client through its seams: `platform/` (storage,
    // network, visibility, sockets, ...) and `boot/` (location, frame, sign-in
    // bounce). Everything else takes what it needs from them, which is what lets
    // the ported controllers and the tests run without a window.
    files: ['native/web/src/**/*.{ts,tsx}'],
    ignores: [
      'native/web/src/{platform,boot,test-support}/**',
      // Development-only pages (the transcript harness): built only with
      // `--mode harness`, never in the bundle (the bundle gate refuses their
      // marker), and a page of their own.
      'native/web/src/dev/**',
      'native/web/src/**/*.test.{ts,tsx}',
      'native/web/src/test-setup.ts'
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'history'].map(name => ({
          name,
          message: `Reach ${name} through a seam in native/web/src/platform or native/web/src/boot.`
        }))
      ]
    }
  },
  {
    // The state, platform and core layers of the web client are React-free:
    // they are ported controllers and browser seams, and `features/` is the only
    // place a component reads them through a hook.
    files: ['native/web/src/{core,state,platform}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message: 'core, state and platform are React-free; read state through a hook in features/.'
            },
            {
              name: 'react-dom',
              message: 'core, state and platform are React-free; read state through a hook in features/.'
            }
          ],
          patterns: [
            {
              group: ['react/*', 'react-dom/*'],
              message: 'core, state and platform are React-free; read state through a hook in features/.'
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
      'native/web/scripts/**/*.mjs',
      // The web client's Playwright specs run in Node and report their
      // measurements on the console.
      'native/web/e2e/**/*.ts',
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
