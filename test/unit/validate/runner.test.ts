import { describe, it, expect, vi, afterEach } from 'vitest'

import { extractRefreshOlderThanFlag } from '../../../src/validate/runner'

describe('extractRefreshOlderThanFlag', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads --refresh-older-than=30d and removes it', () => {
    const argv = ['node', 'runner.ts', '--all', 'external', '--refresh-older-than=30d']
    expect(extractRefreshOlderThanFlag(argv)).toBe(30)
    expect(argv).toEqual(['node', 'runner.ts', '--all', 'external'])
  })

  it('reads the spaced form and removes the value too, so it is not taken as a drive', () => {
    const argv = ['node', 'runner.ts', '--all', '--refresh-older-than', '30']
    expect(extractRefreshOlderThanFlag(argv)).toBe(30)
    expect(argv).toEqual(['node', 'runner.ts', '--all'])
  })

  it('returns 0 when the flag is absent', () => {
    expect(extractRefreshOlderThanFlag(['node', 'runner.ts', '--all'])).toBe(0)
  })

  it('exits on a value that is not a number of days', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    expect(() => extractRefreshOlderThanFlag(['--refresh-older-than=soon'])).toThrow('exit')
  })
})
