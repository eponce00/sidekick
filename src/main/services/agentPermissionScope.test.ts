import { describe, expect, it } from 'vitest'
import { agentPermissionScope } from './agentPermissionScope'

function covers(granted: string, requested: string): boolean {
  const grant = agentPermissionScope('shell', { command: granted })!
  const request = agentPermissionScope('shell', { command: requested })!
  return request.keys.every((key) => grant.keys.includes(key))
}

describe('agentPermissionScope', () => {
  it('scopes a command to its exact text, directory and mode', () => {
    const base = agentPermissionScope('shell', { command: 'npm test', cwd: 'src/' })!
    expect(base.label).toBe('this exact command')
    expect(agentPermissionScope('shell', { command: ' npm test ', cwd: './src' })!.keys).toEqual(
      base.keys
    )
    for (const other of [
      { command: 'npm test -- --watch', cwd: 'src' },
      { command: 'npm test', cwd: '.' },
      { command: 'npm test', cwd: 'src', background: true }
    ]) {
      expect(agentPermissionScope('shell', other)!.keys).not.toEqual(base.keys)
    }
    expect(covers('npm test', 'npm test && rm -rf build')).toBe(false)
  })

  it('scopes file edits to their paths and keeps deletion separate', () => {
    const edit = agentPermissionScope('write', { file_path: 'src\\app.ts', content: 'a' })!
    expect(edit.label).toBe('edits to src/app.ts')
    expect(
      agentPermissionScope('edit', { file_path: './src/app.ts', old_string: 'x' })!.keys
    ).toEqual(edit.keys)
    expect(agentPermissionScope('write', { file_path: 'src/other.ts' })!.keys).not.toEqual(
      edit.keys
    )
    expect(agentPermissionScope('delete_file', { file_path: 'src/app.ts' })!.keys).not.toEqual(
      edit.keys
    )
  })

  it('reads every path a patch touches', () => {
    const scope = agentPermissionScope('apply_patch', {
      patch: [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '@@',
        '-old',
        '+new',
        '*** Delete File: src/b.ts',
        '*** End Patch'
      ].join('\n')
    })!
    expect(scope.label).toBe('changes to these 2 files')
    expect(scope.keys).toEqual(
      agentPermissionScope('write', { file_path: 'src/a.ts' })!.keys.concat(
        agentPermissionScope('delete_file', { file_path: 'src/b.ts' })!.keys
      )
    )
    expect(agentPermissionScope('apply_patch', { patch: 'not a patch' })).toBeUndefined()
  })

  it('scopes any other tool to its exact arguments', () => {
    const tool = 'mcp__tracker__create_issue'
    const scope = agentPermissionScope(tool, { title: 'Bug', body: 'x' })!
    expect(scope.label).toBe('this exact action')
    expect(agentPermissionScope(tool, { body: 'x', title: 'Bug' })!.keys).toEqual(scope.keys)
    expect(agentPermissionScope(tool, { title: 'Other', body: 'x' })!.keys).not.toEqual(scope.keys)
  })
})
