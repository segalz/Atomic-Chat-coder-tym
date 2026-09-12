import { describe, it, expect } from 'vitest'
import { isRtlText, getTextDirection } from '../textDirection'

describe('isRtlText', () => {
  it('returns true for pure Hebrew text', () => {
    expect(isRtlText('שלום עולם')).toBe(true)
  })

  it('returns true for mixed Hebrew and English', () => {
    expect(isRtlText('תתקן את הפונקציה login_user ב-auth.ts')).toBe(true)
  })

  it('returns false for pure English text', () => {
    expect(isRtlText('Hello world')).toBe(false)
  })

  it('returns true for a Markdown heading with Hebrew', () => {
    expect(isRtlText('### שלום עולם')).toBe(true)
  })

  it('returns true for a numbered list item in Hebrew', () => {
    expect(isRtlText('1. סעיף ראשון')).toBe(true)
  })

  it('returns false for code-only strings', () => {
    expect(isRtlText('const x = 1;')).toBe(false)
  })

  it('returns false for null, undefined, and empty string', () => {
    expect(isRtlText(null)).toBe(false)
    expect(isRtlText(undefined)).toBe(false)
    expect(isRtlText('')).toBe(false)
  })
})

describe('getTextDirection', () => {
  it("returns 'rtl' for pure Hebrew text", () => {
    expect(getTextDirection('שלום עולם')).toBe('rtl')
  })

  it("returns 'rtl' for mixed Hebrew and English", () => {
    expect(getTextDirection('תתקן את הפונקציה login_user ב-auth.ts')).toBe('rtl')
  })

  it("returns 'ltr' for pure English text", () => {
    expect(getTextDirection('Hello world')).toBe('ltr')
  })

  it("returns 'rtl' for a Markdown heading with Hebrew", () => {
    expect(getTextDirection('### שלום עולם')).toBe('rtl')
  })

  it("returns 'rtl' for a numbered list item in Hebrew", () => {
    expect(getTextDirection('1. סעיף ראשון')).toBe('rtl')
  })

  it("returns 'ltr' for code-only strings", () => {
    expect(getTextDirection('const x = 1;')).toBe('ltr')
  })

  it("returns 'ltr' for null, undefined, and empty string", () => {
    expect(getTextDirection(null)).toBe('ltr')
    expect(getTextDirection(undefined)).toBe('ltr')
    expect(getTextDirection('')).toBe('ltr')
  })
})
