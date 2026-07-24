import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/build', 'reference/**', 'resources/**'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      'react-refresh/only-export-components': [
        'warn',
        {
          allowExportNames: [
            'applyAccentPalette',
            'formatTokenLabel',
            'getThemeColors',
            'parseProviderFromModelId',
            'playNotificationSound',
            'requestNotificationPermission',
            'showSystemNotification'
          ]
        }
      ],
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn'
    }
  },
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'Shared contracts must remain runtime-agnostic.' }],
          patterns: [
            {
              group: ['**/main/**', '**/preload/**', '**/renderer/**', 'node:*'],
              message: 'Shared code cannot depend on a process-specific layer.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/main/**', '**/preload/**'],
              message: 'Renderer code must use the preload API instead of process internals.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/renderer/**', '**/preload/**'],
              message:
                'Main-process code cannot depend on renderer or preload implementation details.'
            }
          ]
        }
      ]
    }
  },
  eslintConfigPrettier,
  {
    rules: {
      'prettier/prettier': 'off'
    }
  }
)
