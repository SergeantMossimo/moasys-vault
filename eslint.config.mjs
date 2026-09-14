// MOASYS-Vault ESLint config (flat config — ESLint 9+).
// TypeScript-aware linting. The custom rules below are the project-specific
// decisions; everything else follows the recommended presets.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'output/', 'cache/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      // No `any` — use `unknown` + a type guard if you genuinely need an escape hatch.
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused vars/args are errors. Prefix with `_` to mark intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // CLI tool — console output is intentional.
      'no-console': 'off',
    },
  }
)
