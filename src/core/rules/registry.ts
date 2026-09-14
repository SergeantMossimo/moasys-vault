/**
 * core/rules/registry.ts
 * ----------------------
 * One place that knows which schema and defaults belong to which rules file.
 *
 * Before this, every runner spelled out `loadRules({ mediaType, schema,
 * defaults, projectRoot })` itself — fourteen near-identical call sites — and
 * the Plex commands loaded the same type's rules more than once per run,
 * printing a duplicate `[RULES]` line each time.
 *
 * Results are memoized per project root and type, so asking twice in one run
 * is free and logs once. Rules files don't change mid-run.
 */

import { PROJECT_ROOT } from '../project'

import { AudiobooksRules, AudiobooksRulesSchema, defaultAudiobooksRules } from './audiobooks'
import { loadRules } from './loader'
import { MoviesRules, MoviesRulesSchema, defaultMoviesRules } from './movies'
import { MusicRules, MusicRulesSchema, defaultMusicRules } from './music'
import { PlexRules, PlexRulesSchema, defaultPlexRules } from './plex'
import { ShowsRules, ShowsRulesSchema, defaultShowsRules } from './shows'

export interface RulesByType {
  movies: MoviesRules
  shows: ShowsRules
  music: MusicRules
  audiobooks: AudiobooksRules
  plex: PlexRules
}

export type RulesType = keyof RulesByType

const REGISTRY = {
  movies: { schema: MoviesRulesSchema, defaults: defaultMoviesRules },
  shows: { schema: ShowsRulesSchema, defaults: defaultShowsRules },
  music: { schema: MusicRulesSchema, defaults: defaultMusicRules },
  audiobooks: { schema: AudiobooksRulesSchema, defaults: defaultAudiobooksRules },
  plex: { schema: PlexRulesSchema, defaults: defaultPlexRules },
}

const memo = new Map<string, unknown>()

/**
 * Load, merge and validate `rules/<type>.yaml` (+ `.local.yaml`) for one
 * rules type. Exits with a readable message on invalid rules, like
 * `loadRules`.
 */
export function loadTypeRules<K extends RulesType>(
  type: K,
  projectRoot: string = PROJECT_ROOT
): RulesByType[K] {
  const key = `${projectRoot}|${type}`
  if (!memo.has(key)) {
    const { schema, defaults } = REGISTRY[type]
    memo.set(key, loadRules<unknown>({ mediaType: type, schema, defaults, projectRoot }))
  }
  return memo.get(key) as RulesByType[K]
}
