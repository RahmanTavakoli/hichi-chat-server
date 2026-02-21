import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import eslintPluginImport from 'eslint-plugin-import';
import eslintPluginUnusedImports from 'eslint-plugin-unused-imports';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettier from 'eslint-plugin-prettier';

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  {
    // نادیده گرفتن پوشه‌های خروجی و پکیج‌ها
    ignores: ['node_modules', 'dist', 'build', 'coverage'],
  },

  // تنظیمات پیشنهادی پایه
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      // تغییر متغیرهای سراسری از مرورگر به محیط نود جی‌اس
      globals: {
        ...globals.node,
        ...globals.es2021,
        ...globals.jest, // در صورت استفاده از Jest برای تست‌نویسی
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'import': eslintPluginImport,
      'unused-imports': eslintPluginUnusedImports,
      'prettier': eslintPluginPrettier,
    },
    rules: {
      // ادغام Prettier با ESLint به عنوان یک Rule
      'prettier/prettier': 'warn',

      // --- قوانین تایپ‌اسکریپت ---
      '@typescript-eslint/no-explicit-any': 'warn', // جلوگیری از استفاده بی‌رویه از any
      '@typescript-eslint/no-unused-vars': 'off', // غیرفعال کردن این مورد تا پلاگین unused-imports آن را مدیریت کند
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/consistent-type-imports': 'warn', // تشویق به استفاده از import type برای پرفورمنس بهتر

      // --- مدیریت ایمپورت‌ها ---
      'unused-imports/no-unused-imports': 'error', // حذف خودکار ایمپورت‌های بی‌استفاده
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // --- قوانین عمومی سرور ---
      'no-console': 'warn', // هشدار برای جا ماندن console.log در پروداکشن (بهتر است از لاگرهایی مثل winston استفاده شود)
      'no-empty-function': 'warn',
      'no-useless-catch': 'warn',
    },
  },

  // غیرفعال کردن قوانین ESLint که با Prettier تداخل دارند (باید همیشه در انتهای آرایه باشد)
  eslintConfigPrettier,
];