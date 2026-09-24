import { describe, it, expect } from 'vitest'

import { planSteps } from '../../src/run-all'

const configured = { plexConfigured: true, plexToken: true }
const on = { validate: true, plex: true, report: true }

const summary = (steps: ReturnType<typeof planSteps>) =>
  steps.map(s => ({ name: s.name, args: s.args, skip: s.skip }))

describe('planSteps', () => {
  it('runs scan → validate → plex pull → plex check → report in order', () => {
    expect(summary(planSteps(on, configured))).toEqual([
      { name: 'scan', args: ['--all'], skip: null },
      { name: 'validate', args: ['--all'], skip: null },
      { name: 'plex pull', args: [], skip: null },
      { name: 'plex check', args: ['--all'], skip: null },
      { name: 'report', args: ['--all'], skip: null },
    ])
  })

  // The report merges what the earlier steps wrote, so it has to come after
  // them — running it first would fold in the previous run's files.
  it('puts the report last', () => {
    const steps = planSteps(on, configured)
    expect(steps[steps.length - 1]?.name).toBe('report')
  })

  it('passes the drive to every drive-aware step, but not to the Plex pull', () => {
    const steps = planSteps({ drive: 'external', ...on }, configured)
    expect(steps.map(s => s.args)).toEqual([
      ['--all', 'external'],
      ['--all', 'external'],
      [],
      ['--all', 'external'],
      ['--all', 'external'],
    ])
  })

  it('skips both Plex steps when Plex is not configured, with the reason', () => {
    const steps = planSteps(on, { plexConfigured: false, plexToken: true })
    expect(steps.filter(s => s.name.startsWith('plex')).map(s => s.skip)).toEqual([
      'no "plex" block in config.json',
      'no "plex" block in config.json',
    ])
  })

  it('skips the Plex steps when there is no token', () => {
    const steps = planSteps(on, { plexConfigured: true, plexToken: false })
    expect(steps.find(s => s.name === 'plex pull')?.skip).toBe('no Plex token in .secrets.json')
  })

  // A skipped Plex step is not a reason to skip the report: it reads only
  // output/, and reports that command as a missing source instead.
  it('still runs the report when the Plex steps are skipped', () => {
    const steps = planSteps({ validate: true, plex: false, report: true }, configured)
    expect(steps.find(s => s.name === 'report')?.skip).toBeNull()
  })

  it('honors --no-validate, --no-plex and --no-report', () => {
    const steps = planSteps({ validate: false, plex: false, report: false }, configured)
    expect(steps.map(s => s.skip)).toEqual([
      null,
      '--no-validate',
      '--no-plex',
      '--no-plex',
      '--no-report',
    ])
  })

  it('never includes the fix:shows rename tool', () => {
    const steps = planSteps(on, configured)
    expect(steps.some(s => s.script.includes('rename'))).toBe(false)
  })
})
