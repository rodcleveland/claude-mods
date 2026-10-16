import type { EngineInterface } from 'claude-code'

import type { SessionRecord } from '../types'

export const dataDir = (root: string) => `${root}/.claude/token-time`
export const sessionsDir = (root: string) => `${dataDir(root)}/sessions`
export const sessionFile = (root: string, id: string) => `${sessionsDir(root)}/${id}.json`

// Writes go one at a time, so a slow older write never lands over a newer one.
let writing: Promise<void> = Promise.resolve()

export function save($: EngineInterface, rec: SessionRecord): Promise<void> {
  writing = writing
    .then(() => $.fs.write(sessionFile(rec.project.root, rec.sessionId), JSON.stringify(rec)))
    .catch(() => undefined)
  return writing
}

/** Resolves once every write queued so far has landed. */
export const flushWrites = (): Promise<void> => writing
