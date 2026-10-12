import type { RackAutoLevel, RackFamily } from '../types'

// Auto Model's plain logic, with no engine calls: reading the sorter's answer, spotting a short
// reply, the word-based fallback, and the step from a level to a model line.

export const SORT_SYSTEM = [
  'Sort the user request into exactly one level. Reply with the one word only.',
  'small: quick, simple jobs. Summarize, sort, extract, rename, translate, reformat, a short factual answer.',
  'everyday: an email, a post, a short draft, a small edit, a simple question about one file, a quick chart.',
  'strong: the default for anything that matters. Building or changing software, multi-step projects, research, analysis, long documents, planning, anything touching several files or tools.',
  'strongest: only the very hardest. Deep research that runs for hours, a very large build or migration, a problem the strong model would likely fall short on.',
  'When unsure, say strong.',
].join('\n')

// Each level's model line, smallest to most capable.
export const LEVEL_FAMILY: Readonly<Record<RackAutoLevel, RackFamily>> = {
  small: 'haiku',
  everyday: 'sonnet',
  strong: 'opus',
  strongest: 'fable',
}

const STEP_DOWN: readonly RackFamily[] = ['fable', 'opus', 'sonnet', 'haiku']

export function parseLevel(answer: string): RackAutoLevel | null {
  const word = answer.trim().toLowerCase().match(/[a-z]+/)?.[0] ?? ''
  return word === 'small' || word === 'everyday' || word === 'strong' || word === 'strongest' ? word : null
}

const CARRY_ON = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'k', 'no', 'nope', 'thanks', 'thank you',
  'keep going', 'go on', 'go ahead', 'carry on', 'continue', 'proceed', 'do it', 'do that', 'sounds good',
  'looks good', 'lgtm', 'perfect', 'great', 'next', 'approved', 'yes please', 'please do', 'ship it',
])

// A reply to what Claude just said keeps the model: fewer than four words, or a carry-on phrase.
export function isShortReply(text: string): boolean {
  const plain = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ')
  if (plain === '') return true
  return CARRY_ON.has(plain) || plain.split(' ').length < 4
}

const STRONGEST = /\b(migrat\w*|entire (codebase|app|system|repo\w*)|whole (codebase|app|system|repo\w*)|large[- ]scale|from scratch|deep research|for hours|overnight|end[- ]to[- ]end (build|rewrite))\b/i
const STRONG = /\b(build|implement|refactor|debug|fix|architect\w*|design|research|analy[sz]\w*|plan|project|feature|tests?|deploy\w*|integrat\w*|database|api|across|several|multiple|files)\b/i
const EVERYDAY = /\b(email|e-mail|post|tweet|caption|draft|reply to|message|letter|bio|chart|edit|tweak|one file)\b/i
const SMALL = /^(please )?(summari[sz]e|translate|rename|reformat|extract|sort|convert|list|define|spell|count)\b|^(what|who|when|where) (is|was|are|were)\b/i

// When the sorter fails or times out: a guess from the words, strong when in doubt.
export function guessLevel(text: string): RackAutoLevel {
  if (STRONGEST.test(text)) return 'strongest'
  if (STRONG.test(text)) return 'strong'
  if (EVERYDAY.test(text)) return 'everyday'
  if (SMALL.test(text.trim())) return 'small'
  return 'strong'
}

// The level's model line, or the next one down that this plan can use.
export function familyFor(level: RackAutoLevel, unavailable: readonly RackFamily[]): RackFamily {
  const wanted = LEVEL_FAMILY[level]
  return STEP_DOWN.slice(STEP_DOWN.indexOf(wanted)).find(family => !unavailable.includes(family)) ?? 'haiku'
}

// Each model line's name, for the status line.
export const FAMILY_LABELS: Readonly<Record<RackFamily, string>> = {
  haiku: 'Haiku 5.5',
  sonnet: 'Sonnet 5.5',
  opus: 'Opus 5.5',
  fable: 'Fable 5.1',
}

// Auto Model's status-line entry: the model it picked, or nothing while it is off.
export function autoStatusText(isOn: boolean, model: RackFamily | null): string | null {
  if (!isOn) return null
  return `Auto · ${model === null ? 'waiting for a prompt' : FAMILY_LABELS[model]}`
}
