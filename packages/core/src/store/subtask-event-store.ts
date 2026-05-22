import { appendFileSync, existsSync, readFileSync } from 'node:fs'

import { ensureRequirementDir, subtaskEventsFilePath } from './paths.js'

export type SubtaskEventSource = 'skill' | 'manual'

export interface StoredSubtaskEvent {
  subtaskId: string
  fromDone: boolean
  toDone: boolean
  source: SubtaskEventSource
  at: string
}

export function listSubtaskEvents(jiraKey: string, root?: string): StoredSubtaskEvent[] {
  const file = subtaskEventsFilePath(jiraKey, root)
  if (!existsSync(file)) return []
  const out: StoredSubtaskEvent[] = []
  try {
    const raw = readFileSync(file, 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as StoredSubtaskEvent)
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

export function appendSubtaskEvent(
  jiraKey: string,
  event: Omit<StoredSubtaskEvent, 'at'> & { at?: string },
  root?: string
): StoredSubtaskEvent {
  ensureRequirementDir(jiraKey, root)
  const entry: StoredSubtaskEvent = {
    subtaskId: event.subtaskId,
    fromDone: Boolean(event.fromDone),
    toDone: Boolean(event.toDone),
    source: event.source,
    at: event.at ?? new Date().toISOString()
  }
  appendFileSync(subtaskEventsFilePath(jiraKey, root), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}
