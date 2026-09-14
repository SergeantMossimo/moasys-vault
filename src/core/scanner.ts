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

import fs from 'fs'
import path from 'path'

import { writeFileAtomic } from './atomic-write'
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
 * Returns a Map of { unique_key -> record } where the record structure
 * is defined by the media module.
 */
export function scan<TRecord, TOutput, TConfig extends BaseMediaConfig>(
  config: TConfig,
  mediaModule: MediaModule<TRecord, TOutput, TConfig>,
  warnings: WarningCollector,
  probeByPath: Map<string, ProbeData>
): Map<string, TRecord> {
  const records = new Map<string, TRecord>()
  const { root_path } = config
  const categories = mediaModule.getCategories()

  for (const cat of categories) {
    const folderPath = path.join(root_path, cat.folderName)

    // Skip gracefully if the folder doesn't exist on this machine
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      console.log(`    [SKIP] Category folder not found: ${folderPath}`)
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
      config,
      warnings,
      probeByPath
    )

    // Delegate merging to the media module — each type has its own merge logic
    mediaModule.merge(records, incoming)
  }

  // Post-merge hook: media modules can run checks that need the full records map
  mediaModule.postScan?.(records, warnings)

  return records
}

// ─────────────────────────────────────────────
// Output writers
// ─────────────────────────────────────────────

/**
 * Serialize records to a JSON file using the media module's serializer.
 * JSON.stringify with indent=2 gives readable output matching the Python version.
 */
export function writeJson<TRecord, TOutput, TConfig extends BaseMediaConfig>(
  records: Map<string, TRecord>,
  mediaModule: MediaModule<TRecord, TOutput, TConfig>,
  outputPath: string
): void {
  const data = mediaModule.serialize(records)
  writeFileAtomic(outputPath, JSON.stringify(data, null, 2))
  console.log(`    [OUT] ${outputPath}  (${data.length} entries)`)
}
