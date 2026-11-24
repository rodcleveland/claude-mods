import type { Milestone, MilestoneStatus, Plan, PlanSection } from '../types'

// Plan Pane's plan reading, with no engine calls: which files are plans, and their sections and
// milestones.

// The milestone id of a unit heading's text (without the leading #s), or null when the heading is
// not a milestone. Progress matching depends on these exact ids, so keep them stable.
//   "U3. Calendar view"           -> "U3"      "U12b. Split"        -> "U12b"
//   "Task 2: Wire the API"         -> "task-2"
//   "Phase 1: Setup", "Phase 0 — x" -> "phase-1", "phase-0"
//   "Unit 4 — #213: Emails"       -> "unit-4"
// Also taken, with the same ids: "U3: x", "U3 — x", a bare "U3" or "Task 2".
export function milestoneId(heading: string): string | null {
  const h = heading.trim()
  const unit = /^U(\d+[a-z]?)(?:\.|\s*[:—–-]|\s*$)/.exec(h)
  if (unit) return `U${unit[1]}`
  const named = /^(Task|Phase|Unit)\s+(\d+)\s*(?:[:.—–-]|$)/i.exec(h)
  if (named) return `${named[1]!.toLowerCase()}-${named[2]}`
  return null
}

// True for a path that may hold a plan: a .md file inside a folder named plans (docs/plans,
// doc/plans, superpowers/plans, ~/.claude/plans), not a *-requirements.md.
export function isPlanPath(path: string): boolean {
  const parts = path.split(/[\\/]+/)
  const name = parts.pop() ?? ''
  if (!/\.md$/i.test(name) || /-requirements\.md$/i.test(name)) return false
  return parts.some(p => p.toLowerCase() === 'plans')
}

// True when the file at path, with this text, is a plan worth showing.
export function isPlanDoc(path: string, text: string): boolean {
  if (!isPlanPath(path)) return false
  const doc = readDoc(text)
  const fm = doc.frontmatter
  if (/^requirements-only$/i.test(fm.artifact_readiness ?? '')) return false
  if (fm.artifact_contract === 'ce-unified-plan/v1') return true
  if (fm.title && TITLE_PLAN.test(fm.title)) return true
  if (doc.headings.some(h => h.level === 2 && /^implementation units$/i.test(h.label))) return true
  const ids = doc.headings.filter(h => h.level >= 2 && h.level <= 4 && h.id).map(h => h.id!)
  if (doc.banner && ids.some(id => id.startsWith('task-'))) return true
  return new Set(ids).size >= 2
}

// The plan's title, major sections and milestones, each milestone's status taken from the file
// alone (its checkboxes); progress from tasks is merged later.
export function parsePlan(path: string, text: string): Plan {
  const doc = readDoc(text)
  const { headings, boxes, frontmatter: fm } = doc
  // Older ce-plan files mark a finished plan in frontmatter; unified plans never carry progress there.
  const allDone = !fm.artifact_contract && /^completed$/i.test(fm.status ?? '')

  // A milestone heading holding deeper milestone headings (a "### Phase 1" over "#### U2." units)
  // is a container: its children are the milestones, and an H2 container becomes a section.
  const candidate = headings.map(h => h.level >= 2 && h.level <= 4 && h.id !== null)
  const container = headings.map((h, i) => {
    if (!candidate[i]) return false
    for (let j = i + 1; j < headings.length && headings[j]!.level > h.level; j++) if (candidate[j]) return true
    return false
  })

  const drafts: Draft[] = []
  const seen = new Set<string>()
  let current: Draft | undefined
  let fold: Draft | undefined
  let grouped: Draft | undefined

  headings.forEach((h, i) => {
    const milestone = candidate[i] && !container[i]
    if (h.level === 2) {
      if (milestone) {
        // "## Task N:" plans: every such H2 is a milestone of one section, placed at the first.
        if (!grouped) drafts.push((grouped = { title: '', milestones: [], kind: 'group' }))
        current = grouped
        fold = undefined
      } else if (CONTRACT.has(h.label.toLowerCase())) {
        // Consecutive standard contract H2s fold into one row.
        if (!fold) drafts.push((fold = { title: h.label, milestones: [], kind: 'fold', members: [] }))
        fold.members!.push(h.label.toLowerCase())
        current = fold
        return
      } else {
        drafts.push((current = { title: h.label, milestones: [] }))
        fold = undefined
        return
      }
    }
    if (!milestone || seen.has(h.id!)) return
    seen.add(h.id!)
    if (!current) drafts.push((current = { title: 'Overview', milestones: [] }))
    const status: MilestoneStatus = allDone ? 'done' : boxStatus(headings, boxes, i)
    current.milestones.push({ id: h.id!, label: h.label, status })
  })

  const ids = new Set<string>()
  const sections: PlanSection[] = drafts.map(d => {
    const title = d.kind === 'group' ? groupTitle(d.milestones) : d.kind === 'fold' ? foldTitle(d) : d.title
    const base = 's:' + (slug(title) || 'section')
    let id = base
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`
    ids.add(id)
    return { id, title, milestones: d.milestones }
  })

  return { path, title: planTitle(path, doc), sections }
}

type Draft = { title: string; milestones: Milestone[]; kind?: 'group' | 'fold'; members?: string[] }
type Heading = { level: number; label: string; id: string | null; line: number }
type Box = { line: number; checked: boolean }
type Doc = { frontmatter: Record<string, string>; headings: Heading[]; boxes: Box[]; banner: boolean }

const TITLE_PLAN = /\s+[-–—]\s+Plan\s*$/i
const BEFORE_UNITS = ['goal capsule', 'product contract', 'planning contract']
const AFTER_UNITS = ['verification contract', 'definition of done', 'appendix']
const CONTRACT = new Set([...BEFORE_UNITS, ...AFTER_UNITS])

// A folded run keeps its own name when it is one heading, else names what it holds.
function foldTitle(d: Draft): string {
  const m = d.members!
  if (m.length === 1) return d.title
  if (m.every(t => BEFORE_UNITS.includes(t))) return 'Goal & contracts'
  if (m.every(t => AFTER_UNITS.includes(t))) return 'Verification & done'
  return 'Contracts'
}

function groupTitle(milestones: Milestone[]): string {
  const kinds = new Set(milestones.map(m => (/^U\d/.test(m.id) ? 'U' : m.id.replace(/-\d+$/, ''))))
  if (kinds.size !== 1) return 'Milestones'
  const kind = [...kinds][0]
  return kind === 'U' ? 'Implementation Units' : kind === 'task' ? 'Tasks' : kind === 'phase' ? 'Phases' : 'Units'
}

// Checkboxes under heading i, up to the next heading of the same or a higher level.
function boxStatus(headings: Heading[], boxes: Box[], i: number): MilestoneStatus {
  const h = headings[i]!
  let end = Infinity
  for (let j = i + 1; j < headings.length; j++) {
    if (headings[j]!.level <= h.level) {
      end = headings[j]!.line
      break
    }
  }
  const mine = boxes.filter(b => b.line > h.line && b.line < end)
  const ticked = mine.filter(b => b.checked).length
  if (mine.length === 0 || ticked === 0) return 'todo'
  return ticked === mine.length ? 'done' : 'active'
}

function planTitle(path: string, doc: Doc): string {
  const strip = (t: string) => t.replace(TITLE_PLAN, '').trim()
  const fm = doc.frontmatter.title && strip(plain(doc.frontmatter.title))
  if (fm) return fm
  const h1 = doc.headings.find(h => h.level === 1)
  if (h1 && strip(h1.label)) return strip(h1.label)
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, '')
  return name.replace(/^\d{4}-\d{2}-\d{2}-(\d{3,4}-)?/, '') || name
}

// Frontmatter, headings and checkboxes, skipping anything inside fenced code blocks.
function readDoc(text: string): Doc {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const frontmatter: Record<string, string> = {}
  let start = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l))
    if (close > 0) {
      for (const l of lines.slice(1, close)) {
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l)
        if (kv) frontmatter[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
      }
      start = close + 1
    }
  }

  const headings: Heading[] = []
  const boxes: Box[] = []
  let banner = false
  let fence: string | null = null
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l)
    if (f) {
      if (!fence) fence = f[1]!
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length && l.trim() === f[1]) fence = null
      continue
    }
    if (fence) continue
    const h = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(l)
    if (h) {
      const label = plain(h[2]!)
      headings.push({ level: h[1]!.length, label, id: milestoneId(label), line: i })
      continue
    }
    const b = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(l)
    if (b) boxes.push({ line: i, checked: b[1] !== ' ' })
    else if (/^\s*>\s*\*\*For agentic workers:?\*\*/i.test(l)) banner = true
  }
  return { frontmatter, headings, boxes, banner }
}

// Heading text without its markdown: links, emphasis, strike-through markers and backticks.
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
