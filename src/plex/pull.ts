/**
 * plex/pull.ts
 * ------------
 * CLI entry point: `npm run plex:pull [library…]`
 *
 * Reads every library (or the named ones) from the Plex server and writes,
 * per library:
 *
 *   output/plex/<library>/catalog.json      ← items, external ids, mapped file paths
 *   output/plex/<library>/collections.json  ← collections and their items
 *
 * plus an index of all libraries at output/plex/libraries.json.
 *
 * Output is split per library because a large server makes one combined
 * file unwieldy, and because a server often has several libraries of one
 * type (`Movies`, `4K Movies`). Each library's files are written as soon as
 * it finishes, so a failure part-way keeps the libraries already pulled.
 *
 * Read-only: every request is a GET (see plex/client.ts).
 */

import fs from 'fs'
import path from 'path'

import { printBanner, writeJsonOutput } from '../core/runner-shared'

import {
  DUPLICATE_FILTER_TYPES,
  assignSlugs,
  itemTypesFor,
  toCatalogItem,
  toCollection,
} from './catalog'
import { PlexClient } from './client'
import { PathMapper } from './paths'
import { PLEX_OUTPUT_DIR, openPlexSession } from './setup'
import {
  PLEX_TYPE_NUMBER,
  PlexCatalogItem,
  PlexCatalogOutput,
  PlexCollectionsOutput,
  PlexLibrariesOutput,
  PlexLibrarySummary,
  PlexSection,
} from './types'

// ─────────────────────────────────────────────
// One library
// ─────────────────────────────────────────────

/**
 * The rating keys Plex lists under its Duplicates filter for one item type.
 * A server that rejects the filter for a type yields an empty set rather
 * than failing the pull — duplicates are one check among several.
 */
async function duplicateKeys(client: PlexClient, section: PlexSection): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const type of itemTypesFor(section.type).filter(t => DUPLICATE_FILTER_TYPES.includes(t))) {
    try {
      const items = await client.sectionItems(section.key, PLEX_TYPE_NUMBER[type], { duplicate: 1 })
      for (const item of items) keys.add(item.ratingKey)
    } catch (err) {
      console.log(
        `      [PLEX] Duplicate filter unavailable for ${type}: ${(err as Error).message}`
      )
    }
  }
  return keys
}

async function pullLibrary(
  client: PlexClient,
  mapper: PathMapper,
  section: PlexSection,
  summary: PlexLibrarySummary
): Promise<void> {
  const generated = new Date().toISOString()
  const dir = path.join(PLEX_OUTPUT_DIR, summary.slug)

  console.log(`\n  ${section.title}  (${section.type} library → output/plex/${summary.slug}/)`)

  const duplicates = await duplicateKeys(client, section)
  const items: PlexCatalogItem[] = []
  for (const type of itemTypesFor(section.type)) {
    const raw = await client.sectionItems(
      section.key,
      PLEX_TYPE_NUMBER[type],
      {},
      (fetched, total) => {
        if (total !== null && total > 0 && (fetched === total || fetched % 2000 === 0)) {
          console.log(`      [PLEX] ${type}: ${fetched}/${total}`)
        }
      }
    )
    for (const meta of raw) items.push(toCatalogItem(meta, type, mapper, duplicates))
  }

  const rawCollections = await client.collections(section.key)
  const collections = []
  for (const meta of rawCollections) {
    collections.push(toCollection(meta, await client.collectionItems(meta.ratingKey)))
  }

  summary.item_count = items.length
  summary.collection_count = collections.length

  const catalog: PlexCatalogOutput = { generated, library: summary, items }
  const collectionsOut: PlexCollectionsOutput = {
    generated,
    library: { key: summary.key, title: summary.title, slug: summary.slug },
    collections,
  }
  writeJsonOutput(path.join(dir, 'catalog.json'), catalog)
  writeJsonOutput(path.join(dir, 'collections.json'), collectionsOut)

  const unmapped = items.reduce(
    (n, item) => n + item.files.filter(f => f.library_path === null).length,
    0
  )
  if (unmapped > 0) {
    console.log(`      [PLEX] ${unmapped} file(s) didn't map to a configured root`)
  }
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

function printHelp(): void {
  console.log(`
  MOASYS-Vault — Plex library pull

  Usage:
    npm run plex:pull                   Pull every library
    npm run plex:pull movies "tv shows" Pull only the named libraries

  Library names match the Plex library title or its output folder name,
  case-insensitively. Writes output/plex/<library>/catalog.json and
  collections.json, plus output/plex/libraries.json.

  Needs plex.url in config.json and plex.token in .secrets.json.
  See docs/PLEX.md.
  `)
}

/** Previous libraries.json, so a partial pull keeps other libraries' counts. */
function readPreviousLibraries(): Map<string, PlexLibrarySummary> {
  const p = path.join(PLEX_OUTPUT_DIR, 'libraries.json')
  if (!fs.existsSync(p)) return new Map()
  try {
    const prev = JSON.parse(fs.readFileSync(p, 'utf-8')) as PlexLibrariesOutput
    return new Map(prev.libraries.map(l => [l.key, l]))
  } catch {
    return new Map()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  printBanner('Plex Pull')

  const { client, identity, sections, mapper } = await openPlexSession()
  const slugs = assignSlugs(sections)
  const previous = readPreviousLibraries()

  const summaries = sections.map<PlexLibrarySummary>(section => {
    const prev = previous.get(section.key)
    return {
      key: section.key,
      title: section.title,
      plex_type: section.type,
      slug: slugs.get(section.key)!,
      agent: section.agent ?? null,
      locations: (section.Location ?? []).map(l => l.path),
      mapped_locations: (section.Location ?? []).flatMap(l => {
        const mapped = mapper.map(l.path)
        return mapped
          ? [{ plex_path: l.path, drive: mapped.drive, library_path: mapped.relative }]
          : []
      }),
      media_type: mapper.sectionMediaType(section),
      item_count: prev?.item_count ?? 0,
      collection_count: prev?.collection_count ?? 0,
    }
  })

  // Positional args select libraries by title or slug.
  const wanted = args.map(a => a.toLowerCase())
  const selected = sections.filter((section, i) => {
    if (itemTypesFor(section.type).length === 0) return false
    if (wanted.length === 0) return true
    return wanted.includes(section.title.toLowerCase()) || wanted.includes(summaries[i]!.slug)
  })
  const matchedNames = new Set(selected.flatMap(s => [s.title.toLowerCase(), slugs.get(s.key)!]))
  const unknown = wanted.filter(w => !matchedNames.has(w))
  if (unknown.length > 0) {
    const available = summaries
      .filter(s => itemTypesFor(s.plex_type).length > 0)
      .map(s => `'${s.title}' (${s.slug})`)
      .join(', ')
    console.error(`\n  Error: no library named ${unknown.map(u => `'${u}'`).join(', ')}.`)
    console.error(`    Available: ${available}`)
    process.exit(1)
  }

  const skippedPhoto = sections.filter(s => itemTypesFor(s.type).length === 0)
  if (skippedPhoto.length > 0 && wanted.length === 0) {
    console.log(
      `    [PLEX] Skipping ${skippedPhoto.map(s => `'${s.title}'`).join(', ')} (${skippedPhoto.map(s => s.type).join(', ')} — not scanned media)`
    )
  }

  for (const section of selected) {
    const summary = summaries.find(s => s.key === section.key)!
    try {
      await pullLibrary(client, mapper, section, summary)
    } catch (err) {
      console.error(`\n  Error pulling '${section.title}': ${(err as Error).message}`)
      console.error('    Libraries already pulled are kept.')
      writeIndex(identity, summaries)
      process.exit(1)
    }
  }

  writeIndex(identity, summaries)
  console.log(
    `\n  Done — ${selected.length} ${selected.length === 1 ? 'library' : 'libraries'} pulled. ${client.totalRequests} Plex requests.`
  )
  console.log('  → Next: npm run plex:check to compare Plex with your scan output.')
  console.log()
}

function writeIndex(
  identity: { machineIdentifier: string; version: string },
  libraries: PlexLibrarySummary[]
): void {
  const index: PlexLibrariesOutput = {
    generated: new Date().toISOString(),
    server: { machine_identifier: identity.machineIdentifier, version: identity.version },
    libraries,
  }
  writeJsonOutput(path.join(PLEX_OUTPUT_DIR, 'libraries.json'), index)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
