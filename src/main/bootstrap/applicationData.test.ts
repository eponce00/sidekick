import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { isolatedE2EUserDataPath } from './applicationData'

describe('application data isolation', () => {
  const temporaryRoot = resolve('tmp', 'sidekick-tests')
  const isolatedPath = join(temporaryRoot, 'sidekick-e2e-1234')

  it('accepts an explicitly enabled, dedicated temporary profile', () => {
    expect(isolatedE2EUserDataPath(['--sidekick-e2e'], isolatedPath, temporaryRoot)).toBe(
      isolatedPath
    )
  })

  it('uses normal application data when no E2E override is requested', () => {
    expect(isolatedE2EUserDataPath([], undefined, temporaryRoot)).toBeNull()
  })

  it.each([
    { argv: ['--sidekick-e2e'], path: undefined },
    { argv: [], path: isolatedPath },
    { argv: ['--sidekick-e2e'], path: temporaryRoot },
    { argv: ['--sidekick-e2e'], path: join(temporaryRoot, 'ordinary-folder') },
    { argv: ['--sidekick-e2e'], path: join(temporaryRoot, '..', 'sidekick-e2e-escape') }
  ])('rejects partial, broad, or escaping configuration: $path', ({ argv, path }) => {
    expect(() => isolatedE2EUserDataPath(argv, path, temporaryRoot)).toThrow()
  })
})
