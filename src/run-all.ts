/**
 * run-all.ts
 * ----------
 * CLI entry point: `npm run all [drive]`
 *
 * One command for the routine refresh — every read-only pass, in the order
 * each depends on the last:
 *
 *   1. scan       npm run scan:all [drive]
 *   2. validate   npm run validate:all [drive]   (movies/shows skipped without a TMDB key)
 *   3. plex pull  npm run plex:pull              (only when Plex is configured)
 *   4. plex check npm run plex:check [drive]     (only when Plex is configured)
 *
 * `plex:logs` isn't included — it needs the server owner's token and is an
 * occasional deep-dive rather than part of a routine refresh. `fix:shows`
 * never is: it's the one command that writes to a library, and always runs by
 * hand.
 *
 * Each step runs as its own process, exactly as if you'd typed its npm script,
 * so output and exit codes are the same. A failing step stops the run.
 */

import { spawnSync } from 'child_process'
import path from 'path'

import { loadConfig } from './core/config'
import { PROJECT_ROOT } from './core/project'
import { printBanner } from './core/runner-shared'
import { hasSecrets } from './validate/secrets'

interface Step {
  name: string
  script: string
  args: string[]
  /** Why the step won't run, or null to run it. */
  skip: string | null
}

interface Options {
  drive?: string
  validate: boolean
  plex: boolean
}

function parseArgs(argv: string[]): Options | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help'
  const unknown = argv.filter(a => a.startsWith('-') && a !== '--no-validate' && a !== '--no-plex')
  if (unknown.length > 0) {
    console.error(`\n  Error: unknown flag '${unknown[0]}'`)
    process.exit(1)
  }
  return {
    drive: argv.find(a => !a.startsWith('-')),
    validate: !argv.includes('--no-validate'),
    plex: !argv.includes('--no-plex'),
  }
}

/** Build the step list, deciding up front which steps will be skipped and why. */
export function planSteps(
  opts: Options,
  env: { plexConfigured: boolean; plexToken: boolean }
): Step[] {
  const drive = opts.drive ? [opts.drive] : []

  let plexSkip: string | null = null
  if (!opts.plex) plexSkip = '--no-plex'
  else if (!env.plexConfigured) plexSkip = 'no "plex" block in config.json'
  else if (!env.plexToken) plexSkip = 'no Plex token in .secrets.json'

  return [
    { name: 'scan', script: 'src/scan.ts', args: ['--all', ...drive], skip: null },
    {
      name: 'validate',
      script: 'src/validate/runner.ts',
      args: ['--all', ...drive],
      skip: opts.validate ? null : '--no-validate',
    },
    { name: 'plex pull', script: 'src/plex/pull.ts', args: [], skip: plexSkip },
    { name: 'plex check', script: 'src/plex/check.ts', args: ['--all', ...drive], skip: plexSkip },
  ]
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function printHelp(): void {
  console.log(`
  MOASYS-Vault — run every routine pass

  Usage:
    npm run all [drive]                 scan → validate → plex pull → plex check
    npm run all -- --no-validate        Skip the TMDB / Open Library pass
    npm run all -- --no-plex            Skip the Plex steps

  [drive] names a root from config.json, as for the individual commands.
  Types without that drive are skipped. Plex steps run only when config.json
  has a "plex" block and .secrets.json has a Plex token. Validation of movies
  and shows needs a TMDB key; without one those types are skipped.

  Not included: plex:logs (needs the server owner's token) and fix:shows
  (the one command that renames files — always run it yourself).
  `)
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    printHelp()
    process.exit(0)
  }

  const config = loadConfig(PROJECT_ROOT)
  const steps = planSteps(parsed, {
    plexConfigured: config.plex !== undefined,
    plexToken: hasSecrets(PROJECT_ROOT, 'plex'),
  })

  printBanner(parsed.drive ? `Run All (${parsed.drive})` : 'Run All')

  const tsxCli = require.resolve('tsx/cli')
  const results: string[] = []

  for (const step of steps) {
    if (step.skip) {
      results.push(`  - ${step.name.padEnd(11)} skipped (${step.skip})`)
      continue
    }

    console.log(`\n  ▶ ${step.name}`)
    const started = Date.now()
    const run = spawnSync(
      process.execPath,
      [tsxCli, path.join(PROJECT_ROOT, step.script), ...step.args],
      {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      }
    )
    const took = formatDuration(Date.now() - started)

    if (run.status !== 0) {
      results.push(`  ✗ ${step.name.padEnd(11)} failed after ${took}`)
      console.log(`\n${results.join('\n')}\n`)
      console.error(`  Stopped: '${step.name}' exited with status ${run.status ?? run.signal}.`)
      process.exit(run.status ?? 1)
    }
    results.push(`  ✓ ${step.name.padEnd(11)} ${took}`)
  }

  console.log(`\n${'─'.repeat(50)}\n  Run All — summary\n${'─'.repeat(50)}`)
  console.log(`${results.join('\n')}\n`)
}

if (require.main === module) main()
