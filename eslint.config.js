import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // electron/generated: the web's secret detector bundled by scripts/build-secrets.mjs
  globalIgnores(['dist', 'release', 'build', 'electron/generated']),
  // Renderer (desktop shell) — shared UI sources are linted in joty-web
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // Main process + preload (CommonJS, Node)
  {
    files: ['electron/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  // Preloads also run in the page (sandboxed renderer)
  {
    files: ['electron/*preload.cjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  // Build scripts (ESM, Node)
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
])
