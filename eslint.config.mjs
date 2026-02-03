// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import * as importPlugin from 'eslint-plugin-import';
import tsdocPlugin from 'eslint-plugin-tsdoc';
import { fixupPluginRules } from '@eslint/compat';

export default tseslint.config(
  // Global ignores (replaces .eslintignore)
  {
    ignores: ['**/node_modules/**', '**/lib/**'],
  },

  // Base configs
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // TypeScript files configuration
  {
    files: ['packages/*/src/**/*.ts'],

    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: ['./packages/*/tsconfig.json'],
      },
    },

    plugins: {
      tsdoc: tsdocPlugin,
      import: fixupPluginRules(importPlugin),
    },

    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json'],
        },
        node: true,
      },
      'import/internal-regex': '^@temporalio/',
      // Ignore parsing errors for packages that are pure ESM
      'import/ignore': ['chalk'],
    },

    rules: {
      // Core ESLint rules
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'error',
      'object-shorthand': ['error', 'always'],

      // Deprecation (migrated from eslint-plugin-deprecation)
      '@typescript-eslint/no-deprecated': 'warn',

      // TypeScript rules
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],

      // Import rules
      'import/no-unresolved': ['error', { ignore: ['^__temporal_'] }],
      // TypeScript compilation already ensures that named imports exist in the referenced module
      'import/named': 'off',
      'import/default': 'error',
      'import/namespace': 'error',
      'import/no-absolute-path': 'error',
      'import/no-self-import': 'error',
      'import/no-cycle': 'error',
      'import/no-useless-path-segments': 'error',
      'import/no-relative-packages': 'error',
      'import/export': 'error',
      'import/no-named-as-default': 'error',
      'import/no-extraneous-dependencies': 'error',
      'import/no-mutable-exports': 'error',
      'import/unambiguous': 'error',
      'import/first': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        },
      ],
      'import/newline-after-import': 'error',
      'import/no-unassigned-import': 'error',
      'import/no-named-default': 'error',

      // Restricted imports
      'no-restricted-imports': [
        'error',
        {
          patterns: ['@temporalio/*/src/*'],
        },
      ],
    },
  },

  // Prettier must be last to override formatting rules
  eslintConfigPrettier
);
