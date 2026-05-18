import { describe, it, expect } from 'vitest'
import { slugify } from '../src/util/slugify.js'

describe('slugify', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugify('Fix CORS Header')).toBe('fix-cors-header')
  })

  it('removes non-alphanumeric characters', () => {
    expect(slugify('Add user@email.com support!')).toBe('add-useremailcom-support')
  })

  it('collapses multiple spaces and dashes', () => {
    expect(slugify('hello   world--foo')).toBe('hello-world-foo')
  })

  it('truncates at maxLen (default 40)', () => {
    const long = 'a'.repeat(50)
    expect(slugify(long).length).toBeLessThanOrEqual(40)
  })

  it('respects custom maxLen', () => {
    expect(slugify('hello world', 5)).toBe('hello')
  })

  it('strips trailing dashes after truncation', () => {
    // 'hello-' at boundary → should trim trailing dash
    expect(slugify('hello-world', 6)).toBe('hello')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })

  it('handles string that is only special characters', () => {
    expect(slugify('!@#$%')).toBe('')
  })
})
