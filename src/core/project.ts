/**
 * core/project.ts
 * ---------------
 * The project root — where config.json, rules/, ignored/, output/ and cache/
 * live. Every runner used to derive this from its own `__dirname` with a
 * different number of `..` segments; this is the one definition.
 */

import path from 'path'

/** Absolute path to the repository root (src/core/ → ../..). */
export const PROJECT_ROOT = path.join(__dirname, '..', '..')

/** The four media types config.json can list roots for, in run order. */
export const MEDIA_TYPES = ['movies', 'shows', 'music', 'audiobooks'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]
