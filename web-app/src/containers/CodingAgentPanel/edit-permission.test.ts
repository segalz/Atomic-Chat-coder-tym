import { describe, expect, it } from 'vitest'
import { getEditPermissionForPrompt } from './edit-permission'

describe('getEditPermissionForPrompt', () => {
  it('allows explicit code edits', () => {
    expect(getEditPermissionForPrompt('fix the login bug in code', 'manual')).toBe('allowed')
    expect(getEditPermissionForPrompt('תתקן את הקוד של ההתחברות', 'manual')).toBe('allowed')
  })

  it('denies clear questions and calculations', () => {
    expect(getEditPermissionForPrompt('2 * 1098383', 'manual')).toBe('denied')
    expect(getEditPermissionForPrompt('add 3 to it', 'manual')).toBe('denied')
    expect(getEditPermissionForPrompt('why did this happen?', 'manual')).toBe('denied')
    expect(getEditPermissionForPrompt('אתה זוכר מה ביקשתי?', 'manual')).toBe('denied')
  })

  it('asks for ambiguous edit-like requests', () => {
    expect(getEditPermissionForPrompt('make it better', 'manual')).toBe('ask')
    expect(getEditPermissionForPrompt('תשנה את זה', 'manual')).toBe('ask')
  })

  it('allows loop prompts because the repeated task was explicitly scheduled', () => {
    expect(getEditPermissionForPrompt('check and fix issues', 'loop')).toBe('allowed')
  })
})
