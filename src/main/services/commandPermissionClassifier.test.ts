import { describe, expect, it } from 'vitest'
import { commandCanRunWithoutApproval } from './commandPermissionClassifier'

describe('command permission classifier', () => {
  it.each([
    'Get-Content src/app.ts',
    'Select-String -Path src/app.ts -Pattern TODO',
    'rg -n permission src',
    'git status --short',
    'git diff -- src/app.ts',
    'Get-ChildItem src | Select-String test'
  ])('allows inspection command %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(true)
  })

  it.each([
    'git push origin main',
    'git commit -am change',
    'Remove-Item src/app.ts',
    'npm install package',
    'Get-Content source > copy.txt',
    '$content = Get-Content src/app.ts; $content[0]'
  ])('requires approval for non-proven command %s', (command) => {
    expect(commandCanRunWithoutApproval(command)).toBe(false)
  })
})
