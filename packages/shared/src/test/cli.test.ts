import { describe, expect, test } from 'bun:test'
import { extractProfileOverride, parseCommandFlags, renderCliUsage } from '../cli'

describe('cli argument helpers', () => {
  test('extracts a global profile override and preserves command args', () => {
    expect(
      extractProfileOverride([
        'listing',
        'publish',
        '--profile',
        'main',
        '--title',
        'hello',
      ]),
    ).toEqual({
      args: ['listing', 'publish', '--title', 'hello'],
      profileName: 'main',
    })
  })

  test('parses positionals and long flags', () => {
    expect(
      parseCommandFlags([
        'profile',
        'create',
        '--name',
        'main',
        '--display-name=たくみ',
        '--age-range',
        '20代後半',
      ]),
    ).toEqual({
      positionals: ['profile', 'create'],
      flags: {
        name: 'main',
        'display-name': 'たくみ',
        'age-range': '20代後半',
      },
    })
  })

  test('supports -h as a help flag', () => {
    expect(parseCommandFlags(['-h'])).toEqual({
      positionals: [],
      flags: { help: true },
    })
  })

  test('renders usage with direct command examples', () => {
    const usage = renderCliUsage({
      brand: 'create-kanojo',
      role: 'male',
      target: 'female',
    })

    expect(usage).toContain('profile create --name main')
    expect(usage).toContain('profile import --name main --nsec nsec1... --publish')
    expect(usage).toContain('profile edit --display-name')
    expect(usage).toContain('listing edit <listing-id>')
    expect(usage).toContain('listing reopen <listing-id>')
    expect(usage).toContain('discover list')
    expect(usage).toContain('discover like <listing-id>')
    expect(usage).toContain('discover pass <listing-id>')
    expect(usage).toContain('inbox')
    expect(usage).toContain('watch --interval 10')
    expect(usage).toContain('listing publish --title')
    expect(usage).toContain('chat list')
    expect(usage).toContain('chat show <thread-id>')
    expect(usage).toContain('chat <thread-id>')
    expect(usage).toContain('chat <thread-id> --message "こんにちは"')
  })
})
