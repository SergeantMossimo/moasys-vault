/**
 * core/scanner.ts
 * ---------------
 * Shared scanning scaffolding used by all media type modules.
 * Handles folder walking, warning collection, and JSON output writing.
 * Media-specific parsing is delegated to the media module passed in at runtime.
 *
 * This file should rarely need to be edited. Adding a new media type means
 * creating a new file in media/ and registering it in scan.ts — not changing this.
 */

import path from 'path'

import { writeFileAtomic } from './atomic-write'
import { DirReader } from './dir-reader'
import { isSystemFolder } from './files'
import { detectQuality, ResolvedCategory } from './rules/helpers'
import { WarningCollector, MediaModule, BaseMediaConfig } from './types'
import { ProbeData } from '../probe/types'

// ─────────────────────────────────────────────
// Core scanner
// ─────────────────────────────────────────────

/**
 * Walk the effective categories for this module and delegate per-folder
 * parsing to the media module's scanCategory() function.
 *
 * The category list comes from the module's getCategories() — which reads
 * from rules.categories, or returns a single synthetic entry pointing at
 * root_path with name "default" when the user hasn't configured any.
 *
 * Pass the `DirReader` the probe pass used, so folders it already listed
 * aren't listed again.
 *
 * Returns a Map of { unique_key -> record } where the record structure
 * is defined by the media module.
 */
export function scan<TRecord, TOutput>(
  config: BaseMediaConfig,
  mediaModule: MediaModule<TRecord, TOutput>,
  warnings: WarningCollector,
  probeByPath: Map<string, ProbeData>,
  dir: DirReader = new DirReader()
): Map<string, TRecord> {
  const records = new Map<string, TRecord>()
  const { root_path } = config
  const categories = mediaModule.getCategories()

  for (const cat of categories) {
    const folderPath = path.join(root_path, cat.folderName)

    // Skip gracefully if the folder doesn't exist on this machine
    if (!dir.isDirectory(folderPath)) {
      console.log(`    [SKIP] Category folder not found: ${folderPath}`)
      continue
    }

    // A folder that exists but can't be listed is reported, not fatal — the
    // same as an unreadable folder deeper down.
    try {
      dir.readdir(folderPath)
    } catch {
      warnings.add('permission_denied', cat.folderName, 'Permission denied reading folder.')
      continue
    }

    // For the synthetic single-entry case (empty folderName + "default" label),
    // log a friendlier message so the user understands what's happening.
    if (cat.folderName === '') {
      console.log(`    [SCAN] root_path (no categories configured; label: ${cat.name})`)
    } else {
      console.log(`    [SCAN] ${cat.folderName}`)
    }

    // Ask the media module to scan this folder and return its records
    const incoming = mediaModule.scanCategory(
      folderPath,
      cat.folderName,
      cat.name,
      dir,
      warnings,
      probeByPath
    )

    // Delegate merging to the media module — each type has its own merge logic
    mediaModule.merge(records, incoming)
  }

  // Post-merge hook: media modules can run checks that need the full records map
  mediaModule.postScan?.(records, warnings)

  if (mediaModule.warnUnlistedFolders) {
    findUnlistedFolders(root_path, categories, dir, warnings)
  }

  return records
}

/**
 * `warn_unlisted_folder`: folders under `root_path` the scan never looked in.
 *
 * With categories configured, only the listed folders are walked, so any
 * other folder at the top — a new `Other SD/` nobody added to the rules, a
 * title dropped in the wrong place — is silently invisible. Each one is named.
 *
 * With no categories, `root_path` is walked as one flat library and every
 * folder is read as a title. A folder named like a quality category (`HD`,
 * `Other UHD`) is then almost certainly a categorized library run on the
 * default rules, so it gets the same warning with a pointer to `categories`.
 */
function findUnlistedFolders(
  rootPath: string,
  categories: ResolvedCategory[],
  dir: DirReader,
  warnings: WarningCollector
): void {
  let entries
  try {
    entries = dir.readdir(rootPath)
  } catch {
    return // reported by the category walk above
  }
  const folders = entries.filter(e => e.isDirectory() && !isSystemFolder(e.name))
  const flat = categories.every(c => c.folderName === '')

  if (flat) {
    for (const folder of folders) {
      if (detectQuality(folder.name) === null) continue
      warnings.add(
        'warn_unlisted_folder',
        folder.name,
        `Named like a category, but no categories are configured, so it is read as a title.`
      )
    }
    return
  }

  const listed = new Set(categories.map(c => c.folderName.toLowerCase()))
  for (const folder of folders) {
    if (listed.has(folder.name.toLowerCase())) continue
    warnings.add(
      'warn_unlisted_folder',
      folder.name,
      `Not one of the configured categories, so nothing in it is scanned.`
    )
  }
}

// ─────────────────────────────────────────────
// Output writers
// ─────────────────────────────────────────────

/**
 * Serialize records to a JSON file using the media module's serializer,
 * pretty-printed so diffs between runs stay readable.
 */
export function writeJson<TRecord, TOutput>(
  records: Map<string, TRecord>,
  mediaModule: MediaModule<TRecord, TOutput>,
  outputPath: string
): void {
  const data = mediaModule.serialize(records)
  writeFileAtomic(outputPath, JSON.stringify(data, null, 2))
  console.log(`    [OUT] ${outputPath}  (${data.length} entries)`)
}
