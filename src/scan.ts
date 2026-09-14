/**
 * scan.ts
 * -------
 * MOASYS-Vault — Media Library Scanner
 * Entry point for cataloging a Plex media library. Each type runs as one
 * merged pass: probe (cache-aware) + scan (folder walk) → catalog + rich
 * probe data + warnings.
 *
 * Each media type can span several drives — config.json lists one or more
 * named roots per type, and a run targets exactly one of them. Name it
 * positionally, or omit it to get the first configured root.
 *
 * Usage:
 *   npm run movies                 # first root configured for movies
 *   npm run movies external        # the root named "External"
 *   npm run shows
 *   npm run music
 *   npm run audiobooks
 *   npm run scan:all
 *   npm run scan:all external      # every type that has an "External" root
 */

import fs from 'fs'
import path from 'path'

import {
  AppConfig,
  BaseMediaConfig,
  MediaModule,
  MediaRootConfig,
  WarningCollector,
} from './core/types'
import { driveSlug, loadConfig } from './core/config'
import { scan, writeJson } from './core/scanner'
import { loadRules } from './core/rules/loader'
import { loadIgnoreList } from './core/ignored'
import { reportLegacyOutputFiles, typeOutputPaths } from './core/output-paths'
import {
  parseRunnerArgs,
  resolveRoot,
  rootNames,
  writeJsonOutput,
  writeWarnings,
} from './core/runner-shared'

import { createMoviesModule } from './media/movies'
import { createShowsModule } from './media/shows'
import { createMusicModule } from './media/music'
import { createAudiobooksModule } from './media/audiobooks'

import { MoviesRulesSchema, defaultMoviesRules } from './core/rules/movies'
import { ShowsRulesSchema, defaultShowsRules } from './core/rules/shows'
import { MusicRulesSchema, defaultMusicRules } from './core/rules/music'
import { AudiobooksRulesSchema, defaultAudiobooksRules } from './core/rules/audiobooks'

import { ProbeCache } from './probe/cache'
import { ProbeData } from './probe/types'
import { probeMovies } from './probe/movies'
import { probeShows } from './probe/shows'
import { probeMusic } from './probe/music'
import { probeAudiobooks } from './probe/audiobooks'

// ─────────────────────────────────────────────
// Config + paths
// ─────────────────────────────────────────────

const SCRIPT_DIR = path.join(__dirname, '..')
const CACHE_DIR = path.join(SCRIPT_DIR, 'cache')

// CONFIG is loaded + Zod-validated by loadConfig(); see src/core/config.ts.
// Cheap to load once at module init — it's small and shared across all types.
const CONFIG: AppConfig = loadConfig(SCRIPT_DIR)

// ─────────────────────────────────────────────
// Media-type registry shape
// ─────────────────────────────────────────────

/**
 * Per-media-type registry entry. Carries everything the merged runner needs
 * that is independent of which drive is being scanned:
 *   - `module` walks folders and produces the catalog.
 *   - `probe` walks the same files with ffprobe (cache-aware) and produces
 *     the rich `data/probe.json` artifact + the probe-specific warnings.
 *
 * Drive-dependent paths (output dir, cache file, ignore list) are derived
 * per-run in `runType()` from the resolved root, since one media type can
 * have several. Rules stay here because categories are a type-level concept
 * — the same `rules/<type>.yaml` applies to every drive.
 *
 * Built lazily by per-type factory functions (`buildMoviesEntry()` etc.) so
 * `npm run movies` only loads rules for movies — a typo in
 * rules/audiobooks.yaml no longer blocks an unrelated movies scan, and the
 * boot log prints just one `[RULES] Loaded ...` line instead of four.
 */
interface MediaTypeEntry<TRecord, TOutput, TConfig extends BaseMediaConfig> {
  module: MediaModule<TRecord, TOutput, TConfig>
  label: string
  probe: (
    config: TConfig,
    cache: ProbeCache,
    warnings: WarningCollector
  ) => Promise<{ output: unknown; byPath: Map<string, ProbeData> }>
}

function makeEntry<TRecord, TOutput, TConfig extends BaseMediaConfig>(
  entry: MediaTypeEntry<TRecord, TOutput, TConfig>
): MediaTypeEntry<TRecord, TOutput, TConfig> {
  return entry
}

// ─────────────────────────────────────────────
// Per-type factory functions
// ─────────────────────────────────────────────

// Each factory loads its own rules and builds its module and probe closure.
// They're only called for the media type the user actually requested.
//
// To add a new type in the future:
//   1. Create src/media/newtype.ts exporting a createNewtypeModule(rules) factory
//   2. Create src/core/rules/newtype.ts with schema + defaults
//   3. Create src/probe/newtype.ts exporting probeNewtype(config, rules, cache, warnings)
//   4. Add `<newtype>` to VALID_TYPES below and write a build<Newtype>Entry() here
//   5. Wire dispatchType to call the new factory

function buildMoviesEntry() {
  const rules = loadRules({
    mediaType: 'movies',
    schema: MoviesRulesSchema,
    defaults: defaultMoviesRules,
    projectRoot: SCRIPT_DIR,
  })
  return makeEntry({
    module: createMoviesModule(rules),
    label: 'Movies',
    probe: (cfg, cache, warnings) => probeMovies(cfg, rules, cache, warnings),
  })
}

function buildShowsEntry() {
  const rules = loadRules({
    mediaType: 'shows',
    schema: ShowsRulesSchema,
    defaults: defaultShowsRules,
    projectRoot: SCRIPT_DIR,
  })
  return makeEntry({
    module: createShowsModule(rules),
    label: 'Shows',
    probe: (cfg, cache, warnings) => probeShows(cfg, rules, cache, warnings),
  })
}

function buildMusicEntry() {
  const rules = loadRules({
    mediaType: 'music',
    schema: MusicRulesSchema,
    defaults: defaultMusicRules,
    projectRoot: SCRIPT_DIR,
  })
  return makeEntry({
    module: createMusicModule(rules),
    label: 'Music',
    probe: (cfg, cache, warnings) => probeMusic(cfg, rules, cache, warnings),
  })
}

function buildAudiobooksEntry() {
  const rules = loadRules({
    mediaType: 'audiobooks',
    schema: AudiobooksRulesSchema,
    defaults: defaultAudiobooksRules,
    projectRoot: SCRIPT_DIR,
  })
  return makeEntry({
    module: createAudiobooksModule(rules),
    label: 'Audiobooks',
    probe: (cfg, cache, warnings) => probeAudiobooks(cfg, rules, cache, warnings),
  })
}

// ─────────────────────────────────────────────
// Valid types (lightweight, no factories invoked)
// ─────────────────────────────────────────────

const VALID_TYPES = ['movies', 'shows', 'music', 'audiobooks'] as const
type MediaType = (typeof VALID_TYPES)[number]

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

/**
 * Run the merged pipeline for one media type against one named root:
 *   1. Probe pass — walks every primary file (cache-aware)
 *   2. Scan pass — walks folders, parses names, builds the catalog
 *   3. Write all three outputs — <type>.json, warnings.json, data/probe.json
 *
 * Everything drive-specific is namespaced by the root's slug, so two drives
 * never share state:
 *   output/<drive>/<type>/            (layout: core/output-paths.ts)
 *   cache/<drive>/<type>-probe.json
 *   ignored/<drive>/<type>.yaml
 *
 * That separation matters for the cache in particular — entries are keyed by
 * a path relative to the root, so a shared cache file would let one drive's
 * orphan pruning delete the other drive's entries.
 *
 * The probe cache makes subsequent runs near-instant: only newly added /
 * modified / removed files trigger a real ffprobe call.
 */
async function runType<TRecord, TOutput, TConfig extends BaseMediaConfig>(
  mediaType: MediaType,
  entry: MediaTypeEntry<TRecord, TOutput, TConfig>,
  root: TConfig & MediaRootConfig
): Promise<void> {
  const slug = driveSlug(root.name)
  const out = typeOutputPaths(SCRIPT_DIR, slug, mediaType)
  const cachePath = path.join(CACHE_DIR, slug, `${mediaType}-probe.json`)

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`  MOASYS-Vault — ${entry.label}`)
  console.log(`  ${new Date().toLocaleString()}`)
  console.log('─'.repeat(50))
  console.log(`\n  Drive: ${root.name}`)
  console.log(`  Root : ${root.root_path}`)
  console.log()

  fs.mkdirSync(out.dir, { recursive: true })

  // A single WarningCollector is shared across both passes so warnings.json
  // collects everything — naming hygiene from scan, quality / ID3 issues from
  // probe — in one file. Constructed with this drive's ignored entries so any
  // warning that matches an entry in ignored/<drive>/<type>.yaml is silently
  // dropped (still counted via warnings.silencedCount()).
  //
  // hasCategories tells scope derivation whether the first path segment is a
  // category folder. A library with `categories: []` resolves to one synthetic
  // category with an empty folderName, so every warning path is one level
  // shallower — see deriveScope in core/ignored.ts.
  const hasCategories = entry.module.getCategories().some(c => c.folderName !== '')
  const warnings = new WarningCollector(loadIgnoreList(SCRIPT_DIR, slug, mediaType), hasCategories)

  // ── Probe pass ────────────────────────────────────────────────────────
  const cache = new ProbeCache(cachePath)
  console.log(`    [CACHE] ${cache.size()} entries loaded from ${cachePath}`)

  const { output: probeOutput, byPath: probeByPath } = await entry.probe(root, cache, warnings)

  // ── Scan pass ─────────────────────────────────────────────────────────
  // Scan reuses the probe results via `probeByPath` so each version's
  // `quality` is populated alongside the structural catalog work.
  const records = scan(root, entry.module, warnings, probeByPath)

  // ── Write outputs ─────────────────────────────────────────────────────
  console.log('\n  Writing output...')
  writeJson(records, entry.module, out.catalog)
  writeWarnings(out.warnings, warnings)
  writeJsonOutput(out.probe, probeOutput)
  reportLegacyOutputFiles(out)

  // Drop cache entries whose files no longer exist under root_path. Keeps
  // cache/<drive>/<type>-probe.json from growing without bound as files are
  // renamed or deleted from the library.
  const orphans = cache.pruneOrphans(root.root_path)
  cache.save()
  const orphanSummary = orphans > 0 ? ` (pruned ${orphans} orphan${orphans === 1 ? '' : 's'})` : ''
  console.log(`    [CACHE] ${cache.size()} entries saved to ${cachePath}${orphanSummary}`)

  const silenced = warnings.silencedCount()
  const silencedSummary = silenced > 0 ? `, ${silenced} silenced via ignore list` : ''
  console.log(`\n  Done — ${records.size} entries, ${warnings.count()} warnings${silencedSummary}.`)
  if (warnings.count() > 0) {
    const breakdown = warnings
      .countByType()
      .map(({ type, count }) => `${type} (${count})`)
      .join(', ')
    console.log(`    ${breakdown}`)
    console.log(`  → Review ${out.displayDir}/warnings.json for files needing attention.`)
  }
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

/**
 * Resolve which root to scan, then run it.
 *
 * When the requested drive isn't configured for this type, `--all` skips it
 * with a note while a single-type run treats it as an error — `scan:all
 * external` shouldn't die just because music lives on one drive, but
 * `npm run music external` is a typo worth surfacing.
 */
async function dispatchType(
  mediaType: MediaType,
  driveName: string | undefined,
  acrossAllTypes: boolean
): Promise<void> {
  const roots = CONFIG[mediaType]
  const root = resolveRoot(roots, driveName)

  if (!root) {
    const message = `no root named '${driveName}' configured for ${mediaType} (have: ${rootNames(roots)})`
    if (acrossAllTypes) {
      console.log(`\n  [SKIP] ${mediaType} — ${message}`)
      return
    }
    console.error(`\n  Error: ${message}`)
    process.exit(1)
  }

  // Each branch builds its own entry — rules, module, probe — only when that
  // type is actually about to run. `scan:all` calls this four times
  // sequentially, each time loading only what it needs for that type.
  switch (mediaType) {
    case 'movies':
      return runType(mediaType, buildMoviesEntry(), root)
    case 'shows':
      return runType(mediaType, buildShowsEntry(), root)
    case 'music':
      return runType(mediaType, buildMusicEntry(), root)
    case 'audiobooks':
      return runType(mediaType, buildAudiobooksEntry(), root)
  }
}

async function main(): Promise<void> {
  const parsed = parseRunnerArgs(VALID_TYPES)

  if (parsed.kind === 'help') {
    printHelp()
    // Implicit help (no args) exits with status 1; explicit `--help` is clean.
    process.exit(parsed.explicit ? 0 : 1)
  } else if (parsed.kind === 'all') {
    for (const t of VALID_TYPES) await dispatchType(t, parsed.drive, true)
  } else {
    await dispatchType(parsed.type as MediaType, parsed.drive, false)
  }

  console.log()
}

function printHelp(): void {
  console.log(`
  MOASYS-Vault — Plex Media Library Scanner

  Each run executes the merged pipeline (probe + scan) for the selected type,
  producing <type>.json (catalog), warnings.json (all hygiene issues), and
  data/probe.json (rich ffprobe data). The probe cache makes re-runs fast.

  Usage:
    npm run <type> [drive]     Run the merged pipeline for one media type
    npm run scan:all [drive]   Run the merged pipeline for all media types

  Types: ${VALID_TYPES.join(', ')}

  [drive] names a root from config.json. Omit it to use the first root
  configured for that type. Output goes to output/<drive>/<type>/, the probe
  cache to cache/<drive>/, and the ignore list is read from
  ignored/<drive>/<type>.yaml.

  Examples:
    npm run movies              # first configured movies root
    npm run movies external     # the root named "External"
    npm run scan:all
    npm run scan:all external   # every type that has an "External" root
  `)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
