import { chmod, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Brand, ProfileConfig } from './protocol'
import { normalizeProfile } from './protocol'

export interface ProfileStoreState {
  version: 1
  activeProfiles: Partial<Record<Brand, string>>
  updatedAt: number
}

export interface ProfileStore {
  baseDir: string
  ensure(): Promise<void>
  listProfiles(): Promise<string[]>
  readProfile(profileName: string): Promise<ProfileConfig | null>
  saveProfile(profile: ProfileConfig): Promise<void>
  getActiveProfileName(brand: Brand): Promise<string | null>
  loadActiveProfile(brand: Brand): Promise<ProfileConfig | null>
  setActiveProfile(brand: Brand, profileName: string): Promise<void>
}

export function resolveConfigDir(baseDir?: string): string {
  return baseDir ?? process.env.CREATE_MATCHING_CONFIG_DIR ?? path.join(homedir(), '.config', 'create-matching')
}

export function createProfilePath(baseDir: string, profileName: string): string {
  return path.join(baseDir, `${profileName}.json`)
}

export function createStatePath(baseDir: string): string {
  return path.join(baseDir, 'state.json')
}

export function loadProfileStore(baseDir?: string): ProfileStore {
  const resolvedBaseDir = resolveConfigDir(baseDir)

  return {
    baseDir: resolvedBaseDir,
    async ensure() {
      await mkdir(resolvedBaseDir, { recursive: true, mode: 0o700 })
      await ensureStateFile(resolvedBaseDir)
    },
    async listProfiles() {
      await mkdir(resolvedBaseDir, { recursive: true, mode: 0o700 })
      const entries = await readdir(resolvedBaseDir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'state.json')
        .map((entry) => entry.name.replace(/\.json$/, ''))
        .sort((left, right) => left.localeCompare(right, 'ja'))
    },
    async readProfile(profileName) {
      await mkdir(resolvedBaseDir, { recursive: true, mode: 0o700 })
      const filePath = createProfilePath(resolvedBaseDir, profileName)
      const data = await readJsonFile(filePath)
      if (!data) {
        return null
      }
      return normalizeProfile(data)
    },
    async saveProfile(profile) {
      await mkdir(resolvedBaseDir, { recursive: true, mode: 0o700 })
      const filePath = createProfilePath(resolvedBaseDir, profile.profileName)
      await writeJsonAtomic(filePath, profile)
    },
    async getActiveProfileName(brand) {
      const state = await readState(resolvedBaseDir)
      return state.activeProfiles[brand] ?? null
    },
    async loadActiveProfile(brand) {
      const activeName = await this.getActiveProfileName(brand)
      if (!activeName) {
        return null
      }
      return this.readProfile(activeName)
    },
    async setActiveProfile(brand, profileName) {
      const state = await readState(resolvedBaseDir)
      state.activeProfiles[brand] = profileName
      state.updatedAt = Math.floor(Date.now() / 1000)
      await writeJsonAtomic(createStatePath(resolvedBaseDir), state)
    },
  }
}

async function ensureStateFile(baseDir: string): Promise<void> {
  const filePath = createStatePath(baseDir)
  const state = await readJsonFile(filePath)
  if (!state) {
    await writeJsonAtomic(filePath, {
      version: 1,
      activeProfiles: {},
      updatedAt: Math.floor(Date.now() / 1000),
    } satisfies ProfileStoreState)
  }
}

async function readState(baseDir: string): Promise<ProfileStoreState> {
  await ensureStateFile(baseDir)
  const state = (await readJsonFile(createStatePath(baseDir))) as Partial<ProfileStoreState> | null
  return {
    version: 1,
    activeProfiles: state?.activeProfiles ?? {},
    updatedAt: typeof state?.updatedAt === 'number' ? state.updatedAt : Math.floor(Date.now() / 1000),
  }
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, JSON.stringify(value, null, 2))
  await chmod(tmpPath, 0o600)
  await rename(tmpPath, filePath)
  await chmod(filePath, 0o600)
}
