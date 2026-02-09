import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/lib/**', '**/*.js', '**/*.mjs', '**/*.cjs'] },
  {
    files: ['packages/*/src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettierConfig],
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: { project: ['./packages/*/tsconfig.json'] },
    },
    settings: {
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import/resolver': {
        // Resolve types under `<root>@types` even for packages without source code, like `@types/unist`
        typescript: { alwaysTryTypes: true, project: ['packages/*/tsconfig.json'] },
      },
      'import/internal-regex': '^@temporalio/',
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'error',
      'object-shorthand': ['error', 'always'],
      'no-restricted-imports': ['error', { patterns: ['@temporalio/*/src/*'] }],
      // TypeScript rules
      '@typescript-eslint/no-deprecated': 'warn',
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
      'import/order': ['error', { groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'] }],
      'import/newline-after-import': 'error',
      'import/no-unassigned-import': 'error',
      'import/no-named-default': 'error',
    },
  }
);
