// Adapted from immich-app/immich server/eslint.config.mjs; see README.md.
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { importX } from 'eslint-plugin-import-x';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import typescriptEslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

export default defineConfig([
  {
    basePath: fileURLToPath(new URL('..', import.meta.url)),
    files: ['server/**/*.ts', 'server/**/*.tsx'],
    extends: [
      {
        ignores: [
          '**/dist/**',
          '**/node_modules/**',
          'server/src/protocol/generated/**',
          'server/tools/**',
          'assets/**',
          'server/scripts/**',
          'examples/**',
        ],
      },
      eslintPluginUnicorn.configs.recommended,
      js.configs.recommended,
      typescriptEslint.configs.recommended,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      {
        ignores: ['eslint.config.mjs'],
      },
      {
        files: ['server/src/**/*.{ts,tsx}', 'server/tests/**/*.ts'],
        settings: {
          'import-x/resolver-next': [
            createTypeScriptImportResolver({
              project: [fileURLToPath(new URL('./tsconfig.json', import.meta.url))],
              conditionNames: ['types', 'development', 'node', 'import', 'default'],
            }),
          ],
        },
        languageOptions: {
          globals: {
            ...globals.node,
          },

          parser: typescriptEslint.parser,
          ecmaVersion: 2023,
          sourceType: 'module',

          parserOptions: {
            project: ['tsconfig.json'],
            tsconfigRootDir: import.meta.dirname,
          },
        },

        rules: {
          // Effect.fn and Effect.gen bodies are generators even when a step has nothing to yield.
          'require-yield': 'off',
          '@typescript-eslint/interface-name-prefix': 'off',
          '@typescript-eslint/explicit-function-return-type': 'off',
          '@typescript-eslint/explicit-module-boundary-types': 'off',
          '@typescript-eslint/no-explicit-any': 'off',
          '@typescript-eslint/no-floating-promises': 'error',
          'unicorn/name-replacements': 'off',
          'unicorn/filename-case': 'off',
          'unicorn/no-null': 'off',
          'unicorn/prefer-top-level-await': 'off',
          'unicorn/prefer-event-target': 'off',
          'unicorn/no-thenable': 'off',
          'unicorn/import-style': 'off',
          'unicorn/prefer-structured-clone': 'off',
          'unicorn/no-for-loop': 'off',
          'unicorn/no-array-sort': 'off',
          'unicorn/no-unreadable-for-of-expression': 'off',
          'unicorn/no-break-in-nested-loop': 'off',
          'unicorn/no-top-level-assignment-in-function': 'off',
          'unicorn/prefer-uint8array-base64': 'off',
          'unicorn/max-nested-calls': 'off',
          'unicorn/no-declarations-before-early-exit': 'off',
          'unicorn/prefer-smaller-scope': 'off',
          'unicorn/no-unreadable-object-destructuring': 'off',
          'unicorn/single-line-block-comment-style': ['error', 'single-line'],
          'unicorn/prefer-await': 'off',
          'unicorn/consistent-class-member-order': 'off',
          'unicorn/class-reference-in-static-methods': ['error', { preferThis: false, preferSuper: false }],
          'unicorn/no-unsafe-property-key': 'off',
          'unicorn/consistent-boolean-name': 'off',
          'unicorn/no-computed-property-existence-check': 'off',
          'unicorn/no-non-function-verb-prefix': 'off',
          'unicorn/prefer-simple-condition-first': 'off',
          'unicorn/prefer-ternary': 'off',
          'unicorn/prefer-combined-guards': 'off',
          'unicorn/no-immediate-mutation': 'off',
          'unicorn/prefer-minimal-ternary': 'off',
          // prefer the typescript-eslint type-aware version
          'unicorn/require-array-sort-compare': 'off',
          '@typescript-eslint/require-array-sort-compare': 'error',
          '@typescript-eslint/await-thenable': 'error',
          '@typescript-eslint/no-misused-promises': 'error',
          '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
          'require-await': 'off',
          '@typescript-eslint/require-await': 'error',
          curly: 2,
          'object-shorthand': ['error', 'always'],
          eqeqeq: 'error',
          'import-x/no-named-as-default': 'off',
          'import-x/no-empty-named-blocks': 'error',

          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: ['.*'],
                  message: 'Relative imports are not allowed.',
                },
              ],
            },
          ],

          '@typescript-eslint/no-unused-vars': [
            'warn',
            {
              argsIgnorePattern: '^_',
              varsIgnorePattern: '^_',
            },
          ],
        },
      },
      eslintConfigPrettier,
      {
        plugins: { '@stylistic': stylistic },
        rules: {
          '@stylistic/lines-between-class-members': ['error', 'always'],
        },
      },
    ],
  },
  ...svelte.configs.recommended,
  {
    basePath: fileURLToPath(new URL('..', import.meta.url)),
    files: ['web/**/*.svelte'],
    languageOptions: {
      parserOptions: { parser: typescriptEslint.parser },
      globals: globals.browser,
    },
    rules: { 'svelte/no-at-html-tags': 'error', 'svelte/prefer-svelte-reactivity': 'off' },
  },
  {
    basePath: fileURLToPath(new URL('..', import.meta.url)),
    files: ['web/**/*.ts'],
    plugins: { '@typescript-eslint': typescriptEslint.plugin, 'import-x': importX },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({ project: [fileURLToPath(new URL('../web/tsconfig.json', import.meta.url))] }),
      ],
    },
    languageOptions: { parser: typescriptEslint.parser, globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...typescriptEslint.configs.recommended[2].rules,
      'no-undef': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
      'import-x/no-unresolved': ['error', { ignore: ['^vite/modulepreload-polyfill$'] }],
    },
  },
]);
