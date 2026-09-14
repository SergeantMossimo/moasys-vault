import { describe, it, expect } from 'vitest'

import { planSteps } from '../../src/run-all'

const configured = { plexConfigured: true, plexToken: true }

const summary = (steps: ReturnType<typeof planSteps>) =>
  steps.map(s => ({ name: s.name, args: s.args, skip: s.skip }))

describe('planSteps', () => {
  it('runs scan → validate → plex pull → plex check in order', () => {
    expect(summary(planSteps({ validate: true, plex: true }, configured))).toEqual([
      { name: 'scan', args: ['--all'], skip: null },
      { name: 'validate', args: ['--all'], skip: null },
      { name: 'plex pull', args: [], skip: null },
      { name: 'plex check', args: ['--all'], skip: null },
    ])
  })

  it('passes the drive to every drive-aware step, but not to the Plex pull', () => {
    const steps = planSteps({ drive: 'external', validate: true, plex: true }, configured)
    expect(steps.map(s => s.args)).toEqual([
      ['--all', 'external'],
      ['--all', 'external'],
      [],
      ['--all', 'external'],
    ])
  })

  it('skips both Plex steps when Plex is not configured, with the reason', () => {
    const steps = planSteps(
      { validate: true, plex: true },
      { plexConfigured: false, plexToken: true }
    )
    expect(steps.filter(s => s.name.startsWith('plex')).map(s => s.skip)).toEqual([
      'no "plex" block in config.json',
      'no "plex" block in config.json',
    ])
  })

  it('skips the Plex steps when there is no token', () => {
    const steps = planSteps(
      { validate: true, plex: true },
      { plexConfigured: true, plexToken: false }
    )
    expect(steps.find(s => s.name === 'plex pull')?.skip).toBe('no Plex token in .secrets.json')
  })

  it('honors --no-validate and --no-plex', () => {
    const steps = planSteps({ validate: false, plex: false }, configured)
    expect(steps.map(s => s.skip)).toEqual([null, '--no-validate', '--no-plex', '--no-plex'])
  })

  it('never includes the fix:shows rename tool', () => {
    const steps = planSteps({ validate: true, plex: true }, configured)
    expect(steps.some(s => s.script.includes('rename'))).toBe(false)
  })
})
