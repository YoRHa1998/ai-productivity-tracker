import { describe, expect, it } from 'vitest'

import { extractIssueKey } from './git.js'

describe('extractIssueKey', () => {
  it('extracts issue key from common branch names', () => {
    expect(extractIssueKey('feature/INSTANT-1234-add-oauth')).toBe('INSTANT-1234')
    expect(extractIssueKey('hotfix/INSTANT-5678-fix-upload')).toBe('INSTANT-5678')
    expect(extractIssueKey('ABC-42')).toBe('ABC-42')
    expect(extractIssueKey('chore/EVOTO-777')).toBe('EVOTO-777')
  })

  it('returns null when no issue key', () => {
    expect(extractIssueKey('main')).toBeNull()
    expect(extractIssueKey('develop')).toBeNull()
    expect(extractIssueKey('feature/add-oauth')).toBeNull()
    expect(extractIssueKey('feature/ISSUE_NOT_MATCH')).toBeNull()
  })

  it('requires uppercase prefix and numeric suffix', () => {
    expect(extractIssueKey('feature/instant-1234')).toBeNull()
    expect(extractIssueKey('INSTANT-ABCD')).toBeNull()
  })
})
