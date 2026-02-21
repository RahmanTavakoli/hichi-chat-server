// eslint.config.js (یا .ts)

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginUnusedImports from 'eslint-plugin-unused-imports';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintPluginNext from '@next/eslint-plugin-next';
import eslintPluginImport from 'eslint-plugin-import';

/** @type {import("eslint").Linter.FlatConfig} */
export default [
  {
    ignores: [
      'node_modules',
      '.next',
      'dist',
      'build',
      'out',
      'public',
      'coverage',
      'next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'import': eslintPluginImport,
      react: eslintPluginReact,
      prettier: eslintPluginPrettier,
      next: eslintPluginNext,
      'unused-imports': eslintPluginUnusedImports,
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      // React rules
      'react/jsx-props-no-spreading': 'off',

      // General rules
      'no-empty-function': 'warn',
      'no-useless-catch': 'warn',
      'no-undef': 'off',

      // Unused imports cleanup
      'unused-imports/no-unused-imports': 'warn',

      'import/prefer-default-export': 'off',
    },
  },
];
