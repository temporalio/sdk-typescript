import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importPlugin from 'eslint-plugin-import-x';

export default [
  {
    files: ['packages/*/src/**/*.ts', 'contrib/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { '@typescript-eslint': tsPlugin, import: importPlugin },
    settings: {
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ['./packages/*/tsconfig.json', './contrib/*/tsconfig.json'],
        }),
      ],
      'import-x/internal-regex': '^@temporalio/',
    },
    rules: {
      'import/no-unresolved': ['error', { ignore: ['^__temporal_'] }],
      'import/no-useless-path-segments': 'error',
      'import/no-relative-packages': 'error',
      'import/no-extraneous-dependencies': 'error',
      'import/unambiguous': 'error',
    },
  },
];
