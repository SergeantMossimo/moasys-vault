/**
 * plex/collections.ts
 * -------------------
 * CLI entry point: `npm run collections <library> [--apply] [--file <path>] [--undo <journal>]`
 *
 * Applies output/plex/<library>/collection-review.md to the Plex library:
 * creates the collections under `# Create`, adds the items under `# Add`, and
 * takes out the items under `# Remove`. A dry run unless `--apply` is given.
 *
 * Safety, in order:
 *   1. Everything is read live from Plex at run time, not from the last pull.
 *   2. Every line is resolved and every collection checked before anything
 *      changes; any problem stops the run with nothing touched.
 *   3. A journal of every planned change is written before the first one.
 *   4. Changes go one at a time and stop at the first error.
 *   5. All writes go through plex/collections-writer.ts, which allows only
 *      collection changes. Media files are never touched.
 *
 * After an apply, the lines that are done come out of the review file and
 * the library is pulled again so output/plex/ matches Plex. `--undo` reverses
 * a past run from its journal: it takes out what that run added and puts
 * back what it removed. Collections it created stay; delete them in Plex.
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { writeFileAtomic } from '../core/atomic-write'
import { printBanner } from '../core/runner-shared'
import { PROJECT_ROOT } from '../core/project'
import { loadSecrets } from '../validate/secrets'

import { assignSlugs, itemTypesFor } from './catalog'
import { PlexClient } from './client'
import { ItemLine, parseReview, removeLines } from './collections-format'
import { LibraryItem, LiveCollection, Operation, Plan, planChanges } from './collections-plan'
import { PlexCollectionsWriter, WriteScope } from './collections-writer'
import { PLEX_OUTPUT_DIR, openPlexSession } from './setup'
import { PLEX_TYPE_NUMBER, PlexMetadata, PlexSection } from './types'

export const REVIEW_FILE = 'collection-review.md'
export const JOURNAL_DIR = 'collection-changes'

/** Which items a library's collections hold, by Plex section type. */
const COLLECTION_ITEM_TYPE: Record<string, 'movie' | 'show' | 'album'> = {
  movie: 'movie',
  show: 'show',
  artist: 'album',
}

// ─────────────────────────────────────────────
// Journal
// ─────────────────────────────────────────────

export interface JournalOperation {
  kind: Operation['kind']
  collection: string
  collection_key: string | null
  rating_keys: string[]
  /** The review-file lines this change came from. */
  items: string[]
  status: 'planned' | 'done' | 'failed'
  error?: string
}

/** output/plex/<library>/collection-changes/<time>.json */
export interface CollectionJournal {
  generated: string
  mode: 'apply' | 'undo'
  library: { key: string; title: string; slug: string }
  server: string
  /** The review file (apply) or journal (undo) this run worked from, relative to the project. */
  source: string
  operations: JournalOperation[]
}

/**
 * The changes that reverse a journal's completed work: take out what was
 * created or added, put back what was removed. Steps that never ran are
 * skipped. Checked against live state before anything is sent.
 */
export function undoOperations(journal: CollectionJournal): Operation[] {
  const ops: Operation[] = []
  for (const op of journal.operations) {
    if (op.status !== 'done' || !op.collection_key) continue
    if (op.kind === 'remove') {
      ops.push({
        kind: 'add',
        collection: op.collection,
        collectionKey: op.collection_key,
        ratingKeys: op.rating_keys,
        group: `undo|${op.collection}`,
        lines: [],
      })
    } else {
      for (const k of op.rating_keys) {
        ops.push({
          kind: 'remove',
          collection: op.collection,
          collectionKey: op.collection_key,
          ratingKeys: [k],
          group: `undo|${op.collection}`,
          lines: [],
        })
      }
    }
  }
  return ops
}

// ─────────────────────────────────────────────
// Live state
// ─────────────────────────────────────────────

/** TMDB titles by id from the validation cache, so a line can use TMDB's spelling. */
function tmdbTitles(itemType: string): Map<string, string> {
  const file =
    itemType === 'movie' ? 'tmdb-movies.json' : itemType === 'show' ? 'tmdb-shows.json' : null
  const titles = new Map<string, string>()
  if (!file) return titles
  const p = path.join(PROJECT_ROOT, 'cache', file)
  if (!fs.existsSync(p)) return titles
  try {
    const cache = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      entries: Record<string, { value: { title?: string; name?: string } }>
    }
    for (const [id, e] of Object.entries(cache.entries)) {
      const t = e.value.title ?? e.value.name
      if (t) titles.set(id, t)
    }
  } catch {
    // An unreadable cache only costs the TMDB-spelling fallback.
  }
  return titles
}

export function toLibraryItem(meta: PlexMetadata, titles: Map<string, string>): LibraryItem {
  const tmdb = (meta.Guid ?? []).map(g => g.id).find(id => id.startsWith('tmdb://'))
  const tmdbId = tmdb ? tmdb.slice('tmdb://'.length) : null
  return {
    ratingKey: meta.ratingKey,
    title: meta.title,
    year: meta.year ?? null,
    artist: meta.type === 'album' ? (meta.parentTitle ?? null) : null,
    tmdbId,
    tmdbTitle: tmdbId ? (titles.get(tmdbId) ?? null) : null,
  }
}

async function liveCollections(
  client: PlexClient,
  section: PlexSection,
  names: Set<string>
): Promise<LiveCollection[]> {
  const raw = await client.collections(section.key)
  const out: LiveCollection[] = []
  for (const c of raw) {
    const needed = names.has(c.title)
    const children = needed ? await client.collectionItems(c.ratingKey) : []
    out.push({
      ratingKey: c.ratingKey,
      title: c.title,
      smart: c.smart === true || c.smart === '1',
      itemKeys: new Set(children.map(ch => ch.ratingKey)),
    })
  }
  return out
}

// ─────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────

const VERB = { create: 'Create', add: 'Add to', remove: 'Remove from' } as const

function describe(op: Operation, itemNames: Map<string, string>): string[] {
  const names = op.lines.length
    ? op.lines.map(l => l.text)
    : op.ratingKeys.map(k => itemNames.get(k) ?? k)
  return names
}

function printPlan(plan: Plan, itemNames: Map<string, string>): void {
  const groups = new Map<string, Operation[]>()
  for (const op of plan.operations) groups.set(op.group, [...(groups.get(op.group) ?? []), op])
  for (const ops of groups.values()) {
    const first = ops[0]!
    const lines = first.lines.length
      ? first.lines.map(l => l.text)
      : [...new Set(ops.flatMap(o => describe(o, itemNames)))]
    console.log(
      `\n    ${VERB[first.kind]} "${first.collection}" — ${lines.length} item${lines.length === 1 ? '' : 's'}`
    )
    for (const l of lines) console.log(`      ${first.kind === 'remove' ? '-' : '+'} ${l}`)
  }
  if (plan.skipped.length) {
    console.log(`\n    Already done (${plan.skipped.length}):`)
    for (const s of plan.skipped)
      console.log(`      = ${s.collection}: ${s.line.text} — ${s.reason}`)
  }
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

interface Args {
  library: string
  apply: boolean
  file: string | null
  undo: string | null
}

function printHelp(): void {
  console.log(`
  MOASYS-Vault — apply collection changes to Plex

  Usage:
    npm run collections <library>                  Dry run: show what would change
    npm run collections <library> -- --apply       Make the changes
    npm run collections <library> -- --file <path> Use another review file
    npm run collections <library> -- --undo <journal> [--apply]
                                                   Reverse a past run

  <library> is a Plex library title or its output/plex/ folder name.
  Reads output/plex/<library>/collection-review.md: sections # Create,
  # Add and # Remove, each with ## Collection headings and "- Title (Year)"
  lines. Only collections are changed — never media files. See docs/PLEX.md.
  `)
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { library: '', apply: false, file: null, undo: null }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--apply') args.apply = true
    else if (a === '--file' || a === '--undo') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a path`)
      if (a === '--file') args.file = v
      else args.undo = v
    } else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`)
    else positional.push(a)
  }
  if (positional.length !== 1)
    throw new Error('Name exactly one library, e.g. npm run collections movies')
  if (args.file && args.undo) throw new Error("--file and --undo can't be used together")
  args.library = positional[0]!
  return args
}

const rel = (p: string) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/')

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return
  }
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}`)
    process.exit(1)
  }

  printBanner(args.undo ? 'Collections — undo' : 'Collections')
  const { config, client, identity, sections } = await openPlexSession()
  const slugs = assignSlugs(sections)
  const wanted = args.library.toLowerCase()
  const section = sections.find(
    s =>
      itemTypesFor(s.type).length > 0 &&
      (s.title.toLowerCase() === wanted || slugs.get(s.key) === wanted)
  )
  const itemType = section ? COLLECTION_ITEM_TYPE[section.type] : undefined
  if (!section || !itemType) {
    const names = sections
      .filter(s => COLLECTION_ITEM_TYPE[s.type])
      .map(s => `'${s.title}' (${slugs.get(s.key)})`)
    console.error(`\n  Error: no library named '${args.library}'. Available: ${names.join(', ')}`)
    process.exit(1)
  }
  const slug = slugs.get(section.key)!
  const libDir = path.join(PLEX_OUTPUT_DIR, slug)
  console.log(
    `    [LIB] ${section.title} (${itemType}s)${args.apply ? '' : '  — dry run, nothing will change'}`
  )

  // ── Work out the plan ──
  const sourcePath = args.undo
    ? path.resolve(args.undo)
    : args.file
      ? path.resolve(args.file)
      : path.join(libDir, REVIEW_FILE)
  if (!fs.existsSync(sourcePath)) {
    console.error(`\n  Error: ${rel(sourcePath)} not found.`)
    process.exit(1)
  }
  const reviewText = args.undo ? '' : fs.readFileSync(sourcePath, 'utf-8')
  const review = parseReview(reviewText)
  const journalIn = args.undo
    ? (JSON.parse(fs.readFileSync(sourcePath, 'utf-8')) as CollectionJournal)
    : null
  if (
    journalIn &&
    (journalIn.library.key !== section.key || journalIn.server !== identity.machineIdentifier)
  ) {
    console.error(
      `\n  Error: that journal is for '${journalIn.library.title}' on another server or library.`
    )
    process.exit(1)
  }

  const titles = tmdbTitles(itemType)
  const raw = await client.sectionItems(section.key, PLEX_TYPE_NUMBER[itemType])
  const items = raw.map(m => toLibraryItem(m, titles))
  const itemNames = new Map(
    items.map(i => [i.ratingKey, `${i.title}${i.year ? ` (${i.year})` : ''}`])
  )
  const named = new Set([
    ...review.blocks.map(b => b.name),
    ...(journalIn?.operations.map(o => o.collection) ?? []),
  ])
  const collections = await liveCollections(client, section, named)
  console.log(`    [LIVE] ${items.length} ${itemType}s, ${collections.length} collections`)

  let plan: Plan
  if (journalIn) {
    const live = new Map(collections.map(c => [c.ratingKey, c]))
    const problems: string[] = []
    const operations = undoOperations(journalIn).filter(op => {
      const c = live.get(op.collectionKey)
      if (!c) {
        problems.push(`collection "${op.collection}" (${op.collectionKey}) no longer exists`)
        return false
      }
      // Only undo what is still the way that run left it.
      return op.kind === 'remove'
        ? c.itemKeys.has(op.ratingKeys[0]!)
        : !op.ratingKeys.every(k => c.itemKeys.has(k))
    })
    plan = { problems: [...new Set(problems)], operations, skipped: [] }
  } else {
    plan = planChanges(review, items, collections)
  }

  if (plan.problems.length) {
    console.error(
      `\n  Nothing changed — fix ${plan.problems.length === 1 ? 'this' : 'these'} first:`
    )
    for (const p of plan.problems) console.error(`    • ${p}`)
    process.exit(1)
  }
  printPlan(plan, itemNames)
  if (!plan.operations.length) {
    console.log('\n    Nothing to change.')
    return
  }
  if (!args.apply) {
    console.log(
      `\n    Dry run — ${plan.operations.length} request${plan.operations.length === 1 ? '' : 's'} planned, nothing changed.`
    )
    console.log(`    Run again with -- --apply to make these changes.`)
    return
  }

  // ── Apply ──
  const journalPath = path.join(
    libDir,
    JOURNAL_DIR,
    `${new Date().toISOString().replace(/[:.]/g, '-')}${journalIn ? '-undo' : ''}.json`
  )
  const journal: CollectionJournal = {
    generated: new Date().toISOString(),
    mode: journalIn ? 'undo' : 'apply',
    library: { key: section.key, title: section.title, slug },
    server: identity.machineIdentifier,
    source: rel(sourcePath),
    operations: plan.operations.map(op => ({
      kind: op.kind,
      collection: op.collection,
      collection_key: op.collectionKey || null,
      rating_keys: op.ratingKeys,
      // This request's own items: a long Add is split into batches, and each
      // batch's entry names only what it sent.
      items: [...new Set(op.ratingKeys.map(k => itemNames.get(k) ?? k))],
      status: 'planned',
    })),
  }
  const saveJournal = () => writeFileAtomic(journalPath, JSON.stringify(journal, null, 2))
  saveJournal()
  console.log(`\n    [JOURNAL] ${rel(journalPath)}`)

  const scope: WriteScope = {
    machineId: identity.machineIdentifier,
    sectionKey: section.key,
    typeNumber: PLEX_TYPE_NUMBER[itemType],
    itemKeys: new Set(items.map(i => i.ratingKey)),
    collectionKeys: new Set(collections.map(c => c.ratingKey)),
  }
  const { token } = loadSecrets(PROJECT_ROOT, 'plex')
  const writer = new PlexCollectionsWriter(config.plex!.url, token, scope)
  const createdKeys = new Map<string, string>()

  let failed = false
  for (const [i, op] of plan.operations.entries()) {
    const entry = journal.operations[i]!
    try {
      if (op.kind === 'create') {
        const key = await writer.create(op.collection, op.ratingKeys)
        createdKeys.set(op.group, key)
        entry.collection_key = key
      } else {
        const key = op.collectionKey || createdKeys.get(op.group)
        if (!key) throw new Error(`no collection id for "${op.collection}"`)
        entry.collection_key = key
        if (op.kind === 'add') await writer.add(key, op.ratingKeys)
        else await writer.remove(key, op.ratingKeys[0]!)
      }
      entry.status = 'done'
      console.log(`    [OK] ${VERB[op.kind]} "${op.collection}": ${entry.items.join('; ')}`)
    } catch (err) {
      entry.status = 'failed'
      entry.error = (err as Error).message
      failed = true
      console.error(`    [FAIL] ${VERB[op.kind]} "${op.collection}": ${entry.error}`)
    }
    saveJournal()
    if (failed) break
  }

  const done = journal.operations.filter(o => o.status === 'done').length
  console.log(
    `\n    ${done} of ${journal.operations.length} requests done${failed ? ' — stopped at the first error' : ''}.`
  )

  // Take finished lines out of the review file: every request in their group
  // succeeded, or there was nothing to do for them.
  if (!journalIn) {
    const groupDone = new Map<string, boolean>()
    plan.operations.forEach((op, i) =>
      groupDone.set(
        op.group,
        (groupDone.get(op.group) ?? true) && journal.operations[i]!.status === 'done'
      )
    )
    const finished = new Set<number>()
    for (const op of plan.operations)
      if (groupDone.get(op.group)) op.lines.forEach((l: ItemLine) => finished.add(l.lineNo))
    for (const s of plan.skipped) finished.add(s.line.lineNo)
    if (finished.size) {
      writeFileAtomic(sourcePath, removeLines(reviewText, finished))
      console.log(
        `    [REVIEW] ${finished.size} finished line${finished.size === 1 ? '' : 's'} taken out of ${rel(sourcePath)}`
      )
    }
  }

  // Refresh output/plex/<library>/ so it matches what Plex now has.
  console.log(`\n    Pulling '${section.title}' again so output/plex/${slug}/ matches Plex...`)
  spawnSync(
    process.execPath,
    [require.resolve('tsx/cli'), path.join(PROJECT_ROOT, 'src/plex/pull.ts'), slug],
    { stdio: 'inherit' }
  )

  if (failed) process.exit(1)
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
