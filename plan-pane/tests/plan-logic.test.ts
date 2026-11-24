import { expect, test } from 'claude-code/testing'

import { isPlanDoc, isPlanPath, milestoneId, parsePlan } from '../hooks/plan-logic'

const P = '/work/docs/plans/2026-11-20-0809-feat-phone-agent-plan.md'

// The shape of a plan without its milestones' labels: section titles and "id:status" per milestone.
const outline = (text: string, path = P) =>
  parsePlan(path, text).sections.map(s => [s.title, s.milestones.map(m => `${m.id}:${m.status}`)])

const CE = `---
title: Phone Answering Agent - Plan
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
---

# Phone Answering Agent - Plan

## Goal Capsule

- **Objective:** answer calls.

## Product Contract

### Summary

### Key Decisions

- ~~Should we record calls?~~ Resolved: no.

## Planning Contract

### Key Technical Decisions

## Implementation Units

### U1. Spike the unknowns

### U2. Add the phone channel

### U4. Store caller messages — complete flow

## Verification Contract

## Definition of Done

## Appendix
`

test('milestone ids keep their rules and take a few more spellings', () => {
  expect(milestoneId('U3. Calendar view')).toBe('U3')
  expect(milestoneId('U12b. Split')).toBe('U12b')
  expect(milestoneId('Task 2: Wire the API')).toBe('task-2')
  expect(milestoneId('Phase 0 — De-risk')).toBe('phase-0')
  expect(milestoneId('Unit 4 — #213: Emails')).toBe('unit-4')
  expect(milestoneId('U3: x')).toBe('U3')
  expect(milestoneId('U3 — x')).toBe('U3')
  expect(milestoneId('Task 7')).toBe('task-7')
  expect(milestoneId('Unit tests')).toBeNull()
  expect(milestoneId('Phase 2 notes')).toBeNull()
  expect(milestoneId('UI polish')).toBeNull()
})

test('plan paths are .md files in a plans folder, not requirements', () => {
  expect(isPlanPath('/r/docs/plans/2026-01-01-0101-feat-x-plan.md')).toBe(true)
  expect(isPlanPath('/r/doc/plans/x.md')).toBe(true)
  expect(isPlanPath('/r/docs/superpowers/plans/x.md')).toBe(true)
  expect(isPlanPath('/home/me/.claude/plans/x.md')).toBe(true)
  expect(isPlanPath('C:\\repo\\docs\\plans\\x.md')).toBe(true)
  expect(isPlanPath('/r/docs/plans/x-requirements.md')).toBe(false)
  expect(isPlanPath('/r/docs/plans/x.txt')).toBe(false)
  expect(isPlanPath('/r/docs/plans.md')).toBe(false)
  expect(isPlanPath('/r/docs/myplans/x.md')).toBe(false)
  expect(isPlanPath('/r/docs/brainstorms/x.md')).toBe(false)
})

test('plan docs need a plan path and a plan marker', () => {
  expect(isPlanDoc(P, CE)).toBe(true)
  expect(isPlanDoc('/r/docs/notes/x.md', CE)).toBe(false)
  expect(isPlanDoc(P, '---\ntitle: "Search - Plan"\n---\n\nText.')).toBe(true)
  expect(isPlanDoc(P, '# X\n\n## Implementation Units\n\nTBD')).toBe(true)
  expect(isPlanDoc(P, '# Design\n\n## Background\n\n## Options\n')).toBe(false)
  expect(isPlanDoc(P, '# X\n\n### Phase 1: a\n\n### Phase 2: b\n')).toBe(true)
  expect(isPlanDoc(P, '# X\n\n### Phase 1: a\n')).toBe(false)
  // A milestone-looking heading inside a code fence doesn't count.
  expect(isPlanDoc(P, '# X\n\n### Phase 1: a\n\n```\n### Phase 2: b\n```\n')).toBe(false)
  expect(isPlanDoc(P, '> **For agentic workers:** use it.\n\n## Task 1: Go\n')).toBe(true)
  expect(isPlanDoc(P, '## Task 1: Go\n')).toBe(false)
  const reqs = CE.replace('implementation-ready', 'requirements-only')
  expect(isPlanDoc(P, reqs)).toBe(false)
})

test('a ce-plan folds its contract headings around the units', () => {
  const plan = parsePlan(P, CE)
  expect(plan.title).toBe('Phone Answering Agent')
  expect(plan.path).toBe(P)
  expect(outline(CE)).toEqual([
    ['Goal & contracts', []],
    ['Implementation Units', ['U1:todo', 'U2:todo', 'U4:todo']],
    ['Verification & done', []],
  ])
  expect(plan.sections.map(s => s.id)).toEqual(['s:goal-contracts', 's:implementation-units', 's:verification-done'])
  // "complete" in a unit title is not progress, and the label is the heading text.
  expect(plan.sections[1]!.milestones[2]!.label).toBe('U4. Store caller messages — complete flow')
})

test('a lone contract heading keeps its own name', () => {
  const text = '# P\n\n## Goal Capsule\n\n## Summary\n\n## Implementation Units\n\n### U1. A\n\n## Appendix\n'
  expect(outline(text)).toEqual([
    ['Goal Capsule', []],
    ['Summary', []],
    ['Implementation Units', ['U1:todo']],
    ['Appendix', []],
  ])
})

test('superpowers task headings take their status from ticked steps', () => {
  const text = `# Board Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers.

## File Structure

- Modify \`a.ts\`

## Task 1: Add **scaling** to \`Board\`

- [x] **Step 1: Write tests**
- [x] **Step 2: Run them**

## Task 2: Wire state

- [x] **Step 1: Write tests**
- [ ] **Step 2: Implement**

### Notes

- [ ] **Step 3: Commit**

## Task 3: Verify

- [ ] **Step 1: Run tests**

\`\`\`md
- [x] not a real step
## Task 9: not a heading
\`\`\`

## Task 4: Ship

## Self-Review
`
  const plan = parsePlan('/r/doc/plans/2026-05-05-board.md', text)
  expect(plan.title).toBe('Board Plan')
  expect(outline(text)).toEqual([
    ['File Structure', []],
    ['Tasks', ['task-1:done', 'task-2:active', 'task-3:todo', 'task-4:todo']],
    ['Self-Review', []],
  ])
  expect(plan.sections[1]!.milestones[0]!.label).toBe('Task 1: Add scaling to Board')
})

test('H3 task headings sit under their H2 and read checkboxes until the next H3', () => {
  const text = `# P

## Tasks

### Task 1: One

- [X] a

#### Detail

- [x] b

### Task 2: Two

* [ ] a
1. [x] b
`
  expect(outline(text)).toEqual([['Tasks', ['task-1:done', 'task-2:active']]])
})

test('units inside phases become the milestones', () => {
  const text = `---
status: active
---

# feat: Subscribe

## Implementation Units

### Phase 0 — De-risk

#### U1. Spike

### Phase 1 — Foundations

#### U2. Install

#### U3. Vault

### Phase 2: Rollout

## Testing Strategy
`
  expect(outline(text)).toEqual([
    ['Implementation Units', ['U1:todo', 'U2:todo', 'U3:todo', 'phase-2:todo']],
    ['Testing Strategy', []],
  ])
})

test('an H2 phase holding tasks becomes a section of its own', () => {
  const text = '# P\n\n## Phase 1: Setup\n\n### Task 1: A\n\n### Task 2: B\n\n## Phase 2: Build\n\n### Task 3: C\n'
  const plan = parsePlan(P, text)
  expect(outline(text)).toEqual([
    ['Phase 1: Setup', ['task-1:todo', 'task-2:todo']],
    ['Phase 2: Build', ['task-3:todo']],
  ])
  expect(plan.sections.map(s => s.id)).toEqual(['s:phase-1-setup', 's:phase-2-build'])
})

test('unit and phase variants are read as milestones', () => {
  const text = '# P\n\n## Work\n\n### Unit 1 — #213: Emails\n\n### Unit 2 — #214: Texts\n\n### Phase 1: Later\n'
  expect(outline(text)).toEqual([['Work', ['unit-1:todo', 'unit-2:todo', 'phase-1:todo']]])
})

test('older finished ce-plans are all done, unified plans never', () => {
  const old = '---\nstatus: completed\n---\n\n# P\n\n## Implementation Units\n\n### U1. A\n\n### U2. B\n'
  expect(outline(old)).toEqual([['Implementation Units', ['U1:done', 'U2:done']]])
  const unified = old.replace('status: completed', 'status: completed\nartifact_contract: ce-unified-plan/v1')
  expect(outline(unified)).toEqual([['Implementation Units', ['U1:todo', 'U2:todo']]])
})

test('a free-form plan still shows its H2 sections', () => {
  const text = '# Design notes\n\n## Background\n\nText.\n\n## Options\n\n### Option A\n\n## Decision\n'
  expect(outline(text)).toEqual([
    ['Background', []],
    ['Options', []],
    ['Decision', []],
  ])
})

test('section ids are unique and duplicate milestone ids keep the first', () => {
  const text = '# P\n\n## Notes\n\n### U1. First\n\n### U1. Again\n\n## Notes\n\n## notes!\n'
  const plan = parsePlan(P, text)
  expect(plan.sections.map(s => s.id)).toEqual(['s:notes', 's:notes-2', 's:notes-3'])
  expect(plan.sections[0]!.milestones).toEqual([{ id: 'U1', label: 'U1. First', status: 'todo' }])
})

test('milestones before any H2 land in an Overview section', () => {
  expect(outline('### U1. A\n\n## Later\n')).toEqual([
    ['Overview', ['U1:todo']],
    ['Later', []],
  ])
})

test('titles come from frontmatter, then the H1, then the file name', () => {
  expect(parsePlan(P, '---\ntitle: "Search - Plan"\n---\n# Other\n').title).toBe('Search')
  expect(parsePlan(P, '# feat: Search — Plan\n').title).toBe('feat: Search')
  expect(parsePlan(P, '## Only H2\n').title).toBe('feat-phone-agent-plan')
  expect(parsePlan('C:\\r\\docs\\plans\\notes.md', 'text').title).toBe('notes')
})

test('Windows line endings and a byte-order mark still parse', () => {
  const text = '\uFEFF---\r\ntitle: X - Plan\r\n---\r\n\r\n## Task 1: A\r\n\r\n- [x] done\r\n'
  const plan = parsePlan(P, text)
  expect(plan.title).toBe('X')
  expect(outline(text)).toEqual([['Tasks', ['task-1:done']]])
})
