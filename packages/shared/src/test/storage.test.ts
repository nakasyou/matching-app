import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDefaultProfile } from '../protocol'
import { createProfilePath, createStatePath, loadProfileStore } from '../storage'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('profile store', () => {
  test('saves profiles, tracks active profile, and applies restrictive permissions', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'matching-storage-'))
    tempDirs.push(baseDir)

    const store = loadProfileStore(baseDir)
    const profile = createDefaultProfile(
      { brand: 'create-kanojo', role: 'male', target: 'female' },
      {
        profileName: 'main',
        displayName: 'Main',
        bio: 'bio',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'kind' },
        nostr: { pubkey: 'pubkey', nsec: 'nsec' },
        relays: ['wss://relay.test'],
      },
    )

    await store.ensure()
    await store.saveProfile(profile)
    await store.setActiveProfile('create-kanojo', profile.profileName)

    const loaded = await store.loadActiveProfile('create-kanojo')
    expect(loaded?.profileName).toBe('main')
    expect(await store.listProfiles()).toEqual(['main'])

    const profileMode = (await stat(createProfilePath(baseDir, 'main'))).mode & 0o777
    const stateMode = (await stat(createStatePath(baseDir))).mode & 0o777
    expect(profileMode).toBe(0o600)
    expect(stateMode).toBe(0o600)
  })
})
