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
import { loadTypeRules } from './core/rules/registry'
import { loadIgnoreList } from './core/ignored'
import { reportLegacyOutputFiles, typeOutputPaths } from './core/output-paths'
import { MEDIA_TYPES, MediaType, PROJECT_ROOT } from './core/project'
import {
  parseRunnerArgs,
  printBanner,
  printRunSummary,
  selectRoot,
  writeJsonOutput,
  writeWarnings,
} from './core/runner-shared'

import { createMoviesModule } from './media/movies'
import { createShowsModule } from './media/shows'
import { createMusicModule } from './media/music'
import { createAudiobooksModule } from './media/audiobooks'

import { ProbeCache } from './probe/cache'
import { ProbeData } from './probe/types'
import { probeMovies } from './probe/movies'
import { probeShows } from './probe/shows'
import { probeMusic } from './probe/music'
import { probeAudiobooks } from './probe/audiobooks'

const CACHE_DIR = path.join(PROJECT_ROOT, 'cache')

// ─────────────────────────────────────────────
// Media-type registry shape
// ─────────────────────────────────────────────

/**
 * Per-media-type entry. Carries everything the merged runner needs that is
 * independent of which drive is being scanned:
 *   - `module` walks folders and produces the catalog.
 *   - `probe` walks the same files with ffprobe (cache-aware) and produces
 *     the rich `data/probe.json` artifact + the probe-specific warnings.
 *
 * Drive-dependent paths (output dir, cache file, ignore list) are derived
 * per-run in `runType()` from the resolved root, since one media type can
 * have several. Rules stay here because categories are a type-level concept
 * — the same `rules/<type>.yaml` applies to every drive.
 *
 * Built lazily by `runMediaType()` so `npm run movies` only loads rules for
 * movies — a typo in rules/audiobooks.yaml doesn't block an unrelated movies
 * scan, and the boot log prints just one `[RULES] Loaded ...` line.
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

// To add a new type in the future:
//   1. Create src/media/newtype.ts exporting a createNewtypeModule(rules) factory
//   2. Create src/core/rules/newtype.ts with schema + defaults, and register it
//      in src/core/rules/registry.ts
//   3. Create src/probe/newtype.ts exporting probeNewtype(config, rules, cache, warnings)
//   4. Add it to MEDIA_TYPES in src/core/project.ts and a case below
async function runMediaType(mediaType: MediaType, root: MediaRootConfig): Promise<void> {
  switch (mediaType) {
    case 'movies': {
      const rules = loadTypeRules('movies')
      return runType(mediaType, root, {
        module: createMoviesModule(rules),
        label: 'Movies',
        probe: (cfg, cache, warnings) => probeMovies(cfg, rules, cache, warnings),
      })
    }
    case 'shows': {
      const rules = loadTypeRules('shows')
      return runType(mediaType, root, {
        module: createShowsModule(rules),
        label: 'Shows',
        probe: (cfg, cache, warnings) => probeShows(cfg, rules, cache, warnings),
      })
    }
    case 'music': {
      const rules = loadTypeRules('music')
      return runType(mediaType, root, {
        module: createMusicModule(rules),
        label: 'Music',
        probe: (cfg, cache, warnings) => probeMusic(cfg, rules, cache, warnings),
      })
    }
    case 'audiobooks': {
      const rules = loadTypeRules('audiobooks')
      return runType(mediaType, root, {
        module: createAudiobooksModule(rules),
        label: 'Audiobooks',
        probe: (cfg, cache, warnings) => probeAudiobooks(cfg, rules, cache, warnings),
      })
    }
  }
}

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
  root: TConfig & MediaRootConfig,
  entry: MediaTypeEntry<TRecord, TOutput, TConfig>
): Promise<void> {
  const slug = driveSlug(root.name)
  const out = typeOutputPaths(PROJECT_ROOT, slug, mediaType)
  const cachePath = path.join(CACHE_DIR, slug, `${mediaType}-probe.json`)

  printBanner(entry.label, root)
  if ((root.probe_concurrency ?? 1) > 1) {
    console.log(`    [PROBE] Up to ${root.probe_concurrency} files at once (probe_concurrency)`)
  }

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
  const warnings = new WarningCollector(
    loadIgnoreList(PROJECT_ROOT, slug, mediaType),
    hasCategories
  )

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

  printRunSummary(warnings, {
    noun: 'warnings',
    lead: `${records.size} entries, `,
    review: `${out.displayDir}/warnings.json`,
  })
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseRunnerArgs(MEDIA_TYPES)

  if (parsed.kind === 'help') {
    printHelp()
    // Implicit help (no args) exits with status 1; explicit `--help` is clean.
    process.exit(parsed.explicit ? 0 : 1)
  }

  const config: AppConfig = loadConfig(PROJECT_ROOT)
  const acrossAllTypes = parsed.kind === 'all'
  const types = acrossAllTypes ? MEDIA_TYPES : [parsed.type as MediaType]

  // Each type builds its own rules, module, and probe closure only when it's
  // about to run, so `scan:all` loads one type's rules at a time.
  for (const mediaType of types) {
    const root = selectRoot(config, mediaType, parsed.drive, acrossAllTypes)
    if (root) await runMediaType(mediaType, root)
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

  Types: ${MEDIA_TYPES.join(', ')}

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
