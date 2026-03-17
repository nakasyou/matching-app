import { emitKeypressEvents } from 'node:readline'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from '@clack/prompts'
import pc from 'picocolors'
import {
  DEFAULT_RELAYS,
  createGeneratedCredentials,
  createNostrService,
  importCredentials,
  type NostrServiceOptions,
} from './nostr'
import {
  buildConversations,
  createDefaultProfile,
  formatConversationChoiceLabel,
  formatListingChoiceLabel,
  formatMatchChoiceLabel,
  getLikedYouConversations,
  maskSecret,
  rankDiscoverListings,
  recordSwipeDecision,
  type AppPreset,
  type ConversationRecord,
  type DiscoverListing,
  type ListingRecord,
  type MatchRecord,
  type ProfileConfig,
  type RankedDiscoverListing,
  type SwipeAction,
} from './protocol'
import { loadProfileStore } from './storage'

export interface MatchingCliOptions extends NostrServiceOptions {
  baseDir?: string
}

export interface MatchingCli {
  run(args?: string[]): Promise<void>
}

type CliFlagValue = string | boolean

export interface ParsedCliArgs {
  positionals: string[]
  flags: Record<string, CliFlagValue>
}

interface ProfileInputOptions {
  profileName?: string
  displayName?: string
  ageRange?: string
  region?: string
  bio?: string
  interests?: string
  lookingForAge?: string
  lookingForRegions?: string
  lookingForNotes?: string
  relays?: string
}

interface ListingInputOptions {
  listingRef?: string
  headline?: string
  summary?: string
  region?: string
  desiredTags?: string
}

export function createMatchingCli(preset: AppPreset, options: MatchingCliOptions = {}): MatchingCli {
  const store = loadProfileStore(options.baseDir)
  const service = createNostrService(options)
  const theme = createTheme(preset)
  let plainOutput = false

  return {
    async run(rawArgs = process.argv.slice(2)) {
      await store.ensure()

      try {
        const parsed = extractProfileOverride(rawArgs)
        const command = parseCommandFlags(parsed.args)
        const [rootCommand] = command.positionals
        plainOutput =
          command.positionals.length > 0 || Boolean(command.flags.help) || !process.stdout.isTTY

        showIntro()

        if (command.flags.help || rootCommand === 'help') {
          showText(renderCliUsage(preset))
          return
        }

        await dispatchCommand(command, parsed.profileName)
        showOutro('Connected quietly. Ready for the next good match.')
      } catch (error) {
        if (error instanceof CancelledFlowError) {
          showCancelled('Operation cancelled.')
          return
        }

        showError(error instanceof Error ? error.message : 'Unexpected error.')
      } finally {
        service.close()
      }
    },
  }

  function showIntro(): void {
    if (!plainOutput) {
      intro(theme.banner(` ${preset.brand} `))
    }
  }

  function showOutro(message: string): void {
    if (!plainOutput) {
      outro(theme.accent(message))
    }
  }

  function showCancelled(message: string): void {
    if (plainOutput) {
      process.stderr.write(`${message}\n`)
      return
    }
    cancel(message)
  }

  function showText(message: string): void {
    process.stdout.write(`${message}\n`)
  }

  function showSection(body: string, title: string): void {
    if (plainOutput) {
      showText(`${title}\n${body}`)
      return
    }
    note(body, title)
  }

  function showInfo(message: string): void {
    if (plainOutput) {
      showText(message)
      return
    }
    log.info(message)
  }

  function showSuccess(message: string): void {
    if (plainOutput) {
      showText(message)
      return
    }
    log.success(message)
  }

  function showWarn(message: string): void {
    if (plainOutput) {
      process.stderr.write(`${message}\n`)
      return
    }
    log.warn(message)
  }

  function showStep(message: string): void {
    if (plainOutput) {
      showText(message)
      return
    }
    log.step(message)
  }

  function showError(message: string): void {
    if (plainOutput) {
      process.stderr.write(`Error: ${message}\n`)
      return
    }
    log.error(message)
  }

  async function runWithSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
    return withSpinner(message, task, plainOutput)
  }

  async function dispatchCommand(parsedArgs: ParsedCliArgs, profileOverride: string | null): Promise<void> {
    const [command, subcommand, ...rest] = parsedArgs.positionals

    if (!command) {
      await runHome(profileOverride)
      return
    }

    if (command === 'profile') {
      await runProfileCommand(subcommand, rest, parsedArgs.flags, profileOverride)
      return
    }

    if (command === 'listing') {
      await runListingCommand(subcommand, rest, parsedArgs.flags, profileOverride)
      return
    }

    if (command === 'discover') {
      await runDiscoverCommand(subcommand, rest, parsedArgs.flags, profileOverride)
      return
    }

    if (command === 'likes') {
      await runLikes(profileOverride)
      return
    }

    if (command === 'matches') {
      await runMatches(profileOverride)
      return
    }

    if (command === 'chat') {
      await runChat(profileOverride, subcommand, rest, parsedArgs.flags)
      return
    }

    if (command === 'config') {
      await runConfigCommand(subcommand, parsedArgs.flags, profileOverride)
      return
    }

    if (command === 'inbox') {
      await runInbox(profileOverride)
      return
    }

    if (command === 'watch') {
      await runWatch(profileOverride, parsedArgs.flags)
      return
    }

    throw new Error(`Unknown command: ${command}`)
  }

  async function runHome(profileOverride: string | null): Promise<void> {
    let profile = await ensureProfile(profileOverride)

    while (true) {
      profile = await service.syncInbox(profile)
      await store.saveProfile(profile)
      await store.setActiveProfile(preset.brand, profile.profileName)

      showSection(renderProfileCard(profile), 'Current Profile')
      const action = await askSelect({
        message: 'What do you want to do next?',
        options: [
          { value: 'listing-publish', label: 'Publish Listing', hint: 'Create a new listing' },
          { value: 'discover', label: 'Discover', hint: 'Browse active listings' },
          { value: 'likes', label: 'Likes', hint: 'Review sent and received likes' },
          { value: 'matches', label: 'Matches', hint: 'Open matched conversations' },
          { value: 'profile-show', label: 'Profile Details', hint: 'Check bio and storage' },
          { value: 'switch-profile', label: 'Switch Profile', hint: 'Change active profile' },
          { value: 'config', label: 'Advanced Config', hint: 'Inspect relays and keys' },
          { value: 'exit', label: 'Exit', hint: 'Close the CLI' },
        ],
      })

      if (action === 'listing-publish') {
        profile = await handlePublishListing(profile)
        continue
      }
      if (action === 'discover') {
        profile = await handleDiscover(profile)
        continue
      }
      if (action === 'likes') {
        profile = await handleLikes(profile)
        continue
      }
      if (action === 'matches') {
        profile = await handleMatches(profile)
        continue
      }
      if (action === 'profile-show') {
        showSection(renderProfileCard(profile, true), 'Profile Details')
        continue
      }
      if (action === 'switch-profile') {
        profile = await promptProfileUse()
        continue
      }
      if (action === 'config') {
        profile = await promptConfig(profile)
        continue
      }
      return
    }
  }

  async function runProfileCommand(
    subcommand: string | undefined,
    args: string[],
    flags: Record<string, CliFlagValue>,
    profileOverride: string | null,
  ): Promise<void> {
    if (subcommand === 'create') {
      await promptProfileCreate({
        profileName: getStringFlag(flags, 'name', 'profile-name'),
        displayName: getStringFlag(flags, 'display-name'),
        ageRange: getStringFlag(flags, 'age-range'),
        region: getStringFlag(flags, 'region'),
        bio: getStringFlag(flags, 'bio'),
        interests: getStringFlag(flags, 'interests'),
        lookingForAge: getStringFlag(flags, 'looking-age', 'looking-age-range'),
        lookingForRegions: getStringFlag(flags, 'looking-regions'),
        lookingForNotes: getStringFlag(flags, 'looking-notes'),
        relays: getStringFlag(flags, 'relays'),
      })
      return
    }

    if (subcommand === 'import') {
      await promptProfileImport({
        profileName: getStringFlag(flags, 'name', 'profile-name'),
        displayName: getStringFlag(flags, 'display-name'),
        ageRange: getStringFlag(flags, 'age-range'),
        region: getStringFlag(flags, 'region'),
        bio: getStringFlag(flags, 'bio'),
        interests: getStringFlag(flags, 'interests'),
        lookingForAge: getStringFlag(flags, 'looking-age', 'looking-age-range'),
        lookingForRegions: getStringFlag(flags, 'looking-regions'),
        lookingForNotes: getStringFlag(flags, 'looking-notes'),
        relays: getStringFlag(flags, 'relays'),
        nsec: getStringFlag(flags, 'nsec'),
        publish: Boolean(flags.publish),
      })
      return
    }

    if (subcommand === 'use') {
      await promptProfileUse(args[0] ?? profileOverride)
      return
    }

    if (subcommand === 'list') {
      const profiles = await store.listProfiles()
      const active = await store.getActiveProfileName(preset.brand)
      if (profiles.length === 0) {
        showInfo('No profiles yet. Start with `profile create`.')
        return
      }
      showSection(
        profiles.map((name) => `${name === active ? '●' : '○'} ${name}`).join('\n'),
        'Profiles',
      )
      return
    }

    if (subcommand === 'show') {
      const profile = await ensureProfile(profileOverride)
      showSection(renderProfileCard(profile, true), 'Profile Details')
      return
    }

    if (subcommand === 'edit') {
      const profile = await ensureProfile(profileOverride)
      await promptProfileEdit(profile, {
        displayName: getStringFlag(flags, 'display-name'),
        ageRange: getStringFlag(flags, 'age-range'),
        region: getStringFlag(flags, 'region'),
        bio: getStringFlag(flags, 'bio'),
        interests: getStringFlag(flags, 'interests'),
        lookingForAge: getStringFlag(flags, 'looking-age', 'looking-age-range'),
        lookingForRegions: getStringFlag(flags, 'looking-regions'),
        lookingForNotes: getStringFlag(flags, 'looking-notes'),
      })
      return
    }

    throw new Error('Use `profile create|import|edit|use|list|show`.')
  }

  async function runListingCommand(
    subcommand: string | undefined,
    _args: string[],
    flags: Record<string, CliFlagValue>,
    profileOverride: string | null,
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)

    if (subcommand === 'publish') {
      await handlePublishListing(profile, {
        headline: getStringFlag(flags, 'title', 'headline'),
        summary: getStringFlag(flags, 'summary'),
        region: getStringFlag(flags, 'region'),
        desiredTags: getStringFlag(flags, 'tags', 'desired-tags'),
      })
      return
    }

    if (subcommand === 'list') {
      const refreshed = await service.refreshOwnListings(profile)
      await store.saveProfile(refreshed)
      showSection(renderListings(refreshed.cache.listings), 'Your Listings')
      return
    }

    if (subcommand === 'close') {
      const refreshed = await service.refreshOwnListings(profile)
      const openListings = refreshed.cache.listings.filter((listing) => listing.status === 'open')
      if (openListings.length === 0) {
        showInfo('There are no open listings to close.')
        return
      }
      const listingIdArg = getStringFlag(flags, 'id', 'listing-id')
      const listingAddressArg = getStringFlag(flags, 'address', 'listing-address')
      const selectedListing =
        openListings.find((listing) => listing.id === listingIdArg || listing.address === listingAddressArg) ?? null
      if ((listingIdArg || listingAddressArg) && !selectedListing) {
        throw new Error('Listing not found. Use `listing list` to check the id or address.')
      }
      const listingId =
        selectedListing?.id ??
        (await askSelect({
          message: 'Choose a listing to close.',
          options: openListings.map((listing) => ({
            value: listing.id,
            label: listing.headline,
            hint: listing.region,
          })),
        }))
      const nextProfile = await runWithSpinner('Closing listing...', () =>
        service.closeListing(refreshed, listingId),
      )
      await store.saveProfile(nextProfile)
      showSuccess('Listing closed.')
      return
    }

    if (subcommand === 'edit') {
      const refreshed = await service.refreshOwnListings(profile)
      await store.saveProfile(refreshed)
      await promptListingEdit(refreshed, {
        listingRef: getStringFlag(flags, 'id', 'listing-id', 'address', 'listing-address') ?? _args[0],
        headline: getStringFlag(flags, 'title', 'headline'),
        summary: getStringFlag(flags, 'summary'),
        region: getStringFlag(flags, 'region'),
        desiredTags: getStringFlag(flags, 'tags', 'desired-tags'),
      })
      return
    }

    if (subcommand === 'reopen') {
      const refreshed = await service.refreshOwnListings(profile)
      await store.saveProfile(refreshed)
      await reopenListing(refreshed, getStringFlag(flags, 'id', 'listing-id', 'address', 'listing-address') ?? _args[0])
      return
    }

    throw new Error('Use `listing publish|list|close|edit|reopen`.')
  }

  async function runDiscoverCommand(
    subcommand: string | undefined,
    args: string[],
    flags: Record<string, CliFlagValue>,
    profileOverride: string | null,
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)

    if (!subcommand) {
      await handleDiscover(profile)
      return
    }

    if (subcommand === 'list') {
      await showDiscoverList(profile)
      return
    }

    if (subcommand === 'like') {
      await likeDiscoveredListing(profile, args[0] ?? getStringFlag(flags, 'id', 'listing', 'address'), flags)
      return
    }

    if (subcommand === 'pass') {
      await passDiscoveredListing(profile, args[0] ?? getStringFlag(flags, 'id', 'listing', 'address'))
      return
    }

    throw new Error('Use `discover`, `discover list`, `discover like <listing>`, or `discover pass <listing>`.')
  }

  async function runLikes(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleLikes(profile)
  }

  async function runMatches(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleMatches(profile)
  }

  async function runChat(
    profileOverride: string | null,
    chatArg?: string,
    args: string[] = [],
    flags: Record<string, CliFlagValue> = {},
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    const message = getStringFlag(flags, 'message')

    if (chatArg === 'list') {
      await showConversationList(profile)
      return
    }

    if (chatArg === 'show') {
      await showConversationHistory(profile, args[0] ?? getStringFlag(flags, 'thread-id'))
      return
    }

    if (chatArg && message === undefined) {
      await showConversationHistory(profile, chatArg)
      return
    }

    await handleChat(profile, chatArg, undefined, message)
  }

  async function runConfigCommand(
    subcommand: string | undefined,
    flags: Record<string, CliFlagValue>,
    profileOverride: string | null,
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    if (subcommand === 'show') {
      showSection(renderProfileCard(profile, true), 'Advanced Config')
      return
    }
    if (subcommand === 'relays') {
      const nextProfile = await promptRelayConfig(profile, getStringFlag(flags, 'relays'))
      await store.saveProfile(nextProfile)
      showSuccess('Relay list updated.')
      return
    }
    throw new Error('Use `config show|relays`.')
  }

  async function runInbox(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await showInbox(profile)
  }

  async function runWatch(
    profileOverride: string | null,
    flags: Record<string, CliFlagValue>,
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    const intervalSeconds = Number.parseInt(getStringFlag(flags, 'interval') ?? '10', 10)
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error('Interval must be a positive number of seconds.')
    }
    await watchInbox(profile, intervalSeconds)
  }

  async function ensureProfile(profileOverride: string | null): Promise<ProfileConfig> {
    const explicit = profileOverride ? await store.readProfile(profileOverride) : null
    if (explicit) {
      return explicit
    }

    const active = await store.loadActiveProfile(preset.brand)
    if (active) {
      return active
    }

    const profiles = await store.listProfiles()
    if (profiles.length === 1) {
      const singleName = profiles[0]
      if (!singleName) {
        throw new Error('Profile not found.')
      }
      const single = await store.readProfile(singleName)
      if (!single) {
        throw new Error('Failed to load profile.')
      }
      await store.setActiveProfile(preset.brand, single.profileName)
      return single
    }

    if (profiles.length > 1) {
      return promptProfileUse()
    }

    return promptProfileCreate()
  }

  async function promptProfileCreate(initial: ProfileInputOptions = {}): Promise<ProfileConfig> {
    const draft = await collectProfileDraft(initial)
    const credentials = createGeneratedCredentials()
    const profile = createDefaultProfile(preset, {
      profileName: draft.profileName,
      displayName: draft.displayName,
      bio: draft.bio,
      region: draft.region,
      ageRange: draft.ageRange,
      interests: splitComma(draft.interests),
      lookingFor: {
        ageRange: draft.lookingForAge,
        regions: splitComma(draft.lookingForRegions),
        notes: draft.lookingForNotes,
      },
      nostr: credentials,
      relays: draft.relays,
    })

    return saveProfileAndOptionallyPublish(profile, 'Preparing profile...', 'Profile Created', true)
  }

  async function promptProfileImport(
    initial: ProfileInputOptions & {
      nsec?: string
      publish?: boolean
    } = {},
  ): Promise<ProfileConfig> {
    const draft = await collectProfileDraft(initial)
    const providedNsec = await resolveRequiredInput(initial.nsec, {
      message: 'Enter the nsec to import.',
      placeholder: 'nsec1...',
      validate(value) {
        try {
          importCredentials(value ?? '')
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid nsec value.'
        }
      },
    })
    const credentials = importCredentials(providedNsec)
    const profile = createDefaultProfile(preset, {
      profileName: draft.profileName,
      displayName: draft.displayName,
      bio: draft.bio,
      region: draft.region,
      ageRange: draft.ageRange,
      interests: splitComma(draft.interests),
      lookingFor: {
        ageRange: draft.lookingForAge,
        regions: splitComma(draft.lookingForRegions),
        notes: draft.lookingForNotes,
      },
      nostr: credentials,
      relays: draft.relays,
    })

    return saveProfileAndOptionallyPublish(
      profile,
      'Importing profile...',
      initial.publish ? 'Profile Imported & Published' : 'Profile Imported',
      Boolean(initial.publish),
    )
  }

  async function promptProfileEdit(
    profile: ProfileConfig,
    initial: Omit<ProfileInputOptions, 'profileName' | 'relays'> = {},
  ): Promise<ProfileConfig> {
    const displayName = await resolveRequiredInput(initial.displayName, {
      message: 'What display name should we show?',
      placeholder: preset.brand === 'create-kanojo' ? 'たくみ' : 'あや',
      defaultValue: profile.displayName,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Display name is required.'
      },
    })
    const ageRange = await resolveRequiredInput(initial.ageRange, {
      message: 'How would you describe your age range?',
      placeholder: '20代後半',
      defaultValue: profile.ageRange,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Age range is required.'
      },
    })
    const region = await resolveRequiredInput(initial.region, {
      message: 'Which area do you usually meet in?',
      placeholder: '東京',
      defaultValue: profile.region,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Region is required.'
      },
    })
    const bio = await resolveRequiredInput(initial.bio, {
      message: 'Write a short intro.',
      placeholder: '映画とコーヒーが好きです。',
      defaultValue: profile.bio,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Bio is required.'
      },
    })
    const interests = await resolveOptionalInput(initial.interests, {
      message: 'List interests or vibe tags, comma separated.',
      defaultValue: profile.interests.join(', '),
      placeholder: '映画, カフェ, 散歩',
    })
    const lookingForAge = await resolveOptionalInput(initial.lookingForAge, {
      message: 'What age range are you looking for?',
      defaultValue: profile.lookingFor.ageRange,
      placeholder: '20代',
    })
    const lookingForRegions = await resolveOptionalInput(initial.lookingForRegions, {
      message: 'Which regions do you want to meet in? Use commas.',
      defaultValue: profile.lookingFor.regions.join(', '),
      placeholder: region,
    })
    const lookingForNotes = await resolveOptionalInput(initial.lookingForNotes, {
      message: 'What kind of person feels right for you?',
      defaultValue: profile.lookingFor.notes,
      placeholder: '落ち着いて話せる人',
    })

    const nextProfile: ProfileConfig = {
      ...profile,
      displayName,
      ageRange,
      region,
      bio,
      interests: splitComma(interests),
      lookingFor: {
        ageRange: lookingForAge,
        regions: splitComma(lookingForRegions),
        notes: lookingForNotes,
      },
    }

    return saveProfileAndOptionallyPublish(nextProfile, 'Updating profile...', 'Profile Updated', true)
  }

  async function collectProfileDraft(initial: ProfileInputOptions): Promise<{
    profileName: string
    displayName: string
    ageRange: string
    region: string
    bio: string
    interests: string
    lookingForAge: string
    lookingForRegions: string
    lookingForNotes: string
    relays: string[]
  }> {
    const profileName = await resolveRequiredInput(initial.profileName, {
      message: 'Choose a profile name.',
      placeholder: 'main',
      defaultValue: 'main',
      validate(value) {
        const normalized = value?.trim() ?? ''
        if (!normalized) return 'Profile name is required.'
        if (!/^[a-z0-9-]+$/.test(normalized)) return 'Use lowercase letters, digits, and hyphens only.'
      },
    })

    const displayName = await resolveRequiredInput(initial.displayName, {
      message: 'What display name should we show?',
      placeholder: preset.brand === 'create-kanojo' ? 'たくみ' : 'あや',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Display name is required.'
      },
    })
    const ageRange = await resolveRequiredInput(initial.ageRange, {
      message: 'How would you describe your age range?',
      placeholder: '20代後半',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Age range is required.'
      },
    })
    const region = await resolveRequiredInput(initial.region, {
      message: 'Which area do you usually meet in?',
      placeholder: '東京',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Region is required.'
      },
    })
    const bio = await resolveRequiredInput(initial.bio, {
      message: 'Write a short intro.',
      placeholder: '映画とコーヒーが好きです。',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Bio is required.'
      },
    })
    const interests = await resolveOptionalInput(initial.interests, {
      message: 'List interests or vibe tags, comma separated.',
      placeholder: '映画, カフェ, 散歩',
    })
    const lookingForAge = await resolveOptionalInput(initial.lookingForAge, {
      message: 'What age range are you looking for?',
      placeholder: '20代',
    })
    const lookingForRegions = await resolveOptionalInput(initial.lookingForRegions, {
      message: 'Which regions do you want to meet in? Use commas.',
      placeholder: region,
    })
    const lookingForNotes = await resolveOptionalInput(initial.lookingForNotes, {
      message: 'What kind of person feels right for you?',
      placeholder: '落ち着いて話せる人',
    })
    const relays = initial.relays ? normalizeRelayList(initial.relays) : DEFAULT_RELAYS

    return {
      profileName,
      displayName,
      ageRange,
      region,
      bio,
      interests,
      lookingForAge,
      lookingForRegions,
      lookingForNotes,
      relays,
    }
  }

  async function saveProfileAndOptionallyPublish(
    profile: ProfileConfig,
    spinnerMessage: string,
    title: string,
    publish: boolean,
  ): Promise<ProfileConfig> {
    const nextProfile = publish
      ? await runWithSpinner(spinnerMessage, async () => {
          await service.publishProfile(profile)
          return profile
        })
      : profile
    await store.saveProfile(nextProfile)
    await store.setActiveProfile(preset.brand, nextProfile.profileName)
    showSection(renderProfileCard(nextProfile), title)
    return nextProfile
  }

  async function promptProfileUse(profileNameArg?: string | null): Promise<ProfileConfig> {
    const profiles = await store.listProfiles()
    if (profiles.length === 0) {
      return promptProfileCreate()
    }

    const selectedName =
      profileNameArg && profiles.includes(profileNameArg)
        ? profileNameArg
        : await askSelect({
            message: 'Choose a profile to use.',
            options: [
              ...profiles.map((name) => ({ value: name, label: name })),
              { value: '__create__', label: 'Create New Profile', hint: 'Start a fresh profile' },
            ],
          })

    if (selectedName === '__create__') {
      return promptProfileCreate()
    }

    const profile = await store.readProfile(selectedName)
    if (!profile) {
      throw new Error(`Profile not found: ${selectedName}`)
    }
    await store.setActiveProfile(preset.brand, selectedName)
    showSection(renderProfileCard(profile), 'Active Profile')
    return profile
  }

  async function handlePublishListing(
    profile: ProfileConfig,
    initial: Omit<ListingInputOptions, 'listingRef'> = {},
  ): Promise<ProfileConfig> {
    const headline = await resolveRequiredInput(initial.headline, {
      message: 'Enter the listing title.',
      placeholder: '週末に一緒に映画を見に行ける人',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Title is required.'
      },
    })
    const summary = await resolveRequiredInput(initial.summary, {
      message: 'Write a short summary.',
      placeholder: 'まずはお茶からゆっくり話したいです。',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Summary is required.'
      },
    })
    const region = await resolveOptionalInput(initial.region, {
      message: 'Which region is this listing for?',
      defaultValue: profile.region,
    })
    const desiredTags = await resolveOptionalInput(initial.desiredTags, {
      message: 'Enter tags, comma separated.',
      placeholder: '映画, 落ち着き, 夜カフェ',
    })

    const nextProfile = await runWithSpinner('Publishing listing...', () =>
      service.publishListing(profile, {
        headline,
        summary,
        region,
        desiredTags: splitComma(desiredTags),
      }),
    )
    await store.saveProfile(nextProfile)
    showSuccess('Listing published.')
    return nextProfile
  }

  async function promptListingEdit(
    profile: ProfileConfig,
    initial: ListingInputOptions = {},
  ): Promise<ProfileConfig> {
    const listing = await resolveOwnListing(profile, initial.listingRef, false)
    const headline = await resolveRequiredInput(initial.headline, {
      message: 'Enter the listing title.',
      placeholder: '週末に一緒に映画を見に行ける人',
      defaultValue: listing.headline,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Title is required.'
      },
    })
    const summary = await resolveRequiredInput(initial.summary, {
      message: 'Write a short summary.',
      placeholder: 'まずはお茶からゆっくり話したいです。',
      defaultValue: listing.summary,
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Summary is required.'
      },
    })
    const region = await resolveOptionalInput(initial.region, {
      message: 'Which region is this listing for?',
      defaultValue: listing.region,
    })
    const desiredTags = await resolveOptionalInput(initial.desiredTags, {
      message: 'Enter tags, comma separated.',
      defaultValue: listing.desiredTags.join(', '),
      placeholder: '映画, 落ち着き, 夜カフェ',
    })

    const nextProfile = await runWithSpinner('Updating listing...', () =>
      service.updateListing(profile, {
        listingId: listing.id,
        headline,
        summary,
        region,
        desiredTags: splitComma(desiredTags),
      }),
    )
    await store.saveProfile(nextProfile)
    showSuccess('Listing updated.')
    return nextProfile
  }

  async function reopenListing(profile: ProfileConfig, listingRef?: string): Promise<ProfileConfig> {
    const listing = await resolveOwnListing(profile, listingRef, true)
    const nextProfile = await runWithSpinner('Reopening listing...', () =>
      service.updateListing(profile, {
        listingId: listing.id,
        status: 'open',
      }),
    )
    await store.saveProfile(nextProfile)
    showSuccess('Listing reopened.')
    return nextProfile
  }

  async function resolveOwnListing(
    profile: ProfileConfig,
    listingRef?: string,
    closedOnly = false,
  ): Promise<ListingRecord> {
    const listings = profile.cache.listings.filter((listing) =>
      closedOnly ? listing.status === 'closed' : true,
    )
    if (listings.length === 0) {
      throw new Error(closedOnly ? 'There are no closed listings to reopen.' : 'There are no listings yet.')
    }

    const selected =
      (listingRef
        ? listings.find((listing) => listing.id === listingRef || listing.address === listingRef)
        : null) ?? null
    if (listingRef && !selected) {
      throw new Error('Listing not found. Use `listing list` to check the id or address.')
    }

    if (selected) {
      return selected
    }

    const listingId = await askSelect({
      message: closedOnly ? 'Choose a listing to reopen.' : 'Choose a listing to edit.',
      options: listings.map((listing) => ({
        value: listing.id,
        label: listing.headline,
        hint: `${listing.region} | ${listing.status}`,
      })),
    })
    const listing = listings.find((item) => item.id === listingId)
    if (!listing) {
      throw new Error('Listing not found.')
    }
    return listing
  }

  async function handleDiscover(profile: ProfileConfig): Promise<ProfileConfig> {
    const refreshed = await loadDiscoverState(profile)
    if (refreshed.listings.length === 0) {
      showInfo('No listings found right now. Try again later.')
      return refreshed.profile
    }

    const ownListingAddress = await resolveOwnOpenListingAddress(refreshed.profile)

    showSection(
      [
        'y: send like',
        'n: pass for now',
        'q: quit discover',
        '',
        'Next candidates are re-ranked from your y / n history.',
      ].join('\n'),
      'Swipe Mode',
    )

    let nextProfile = refreshed.profile
    let queue = refreshed.listings
    let likedCount = 0
    let skippedCount = 0

    while (queue.length > 0) {
      const current = queue[0]
      if (!current) {
        break
      }

      showSection(renderDiscoverCard(current, queue.length), 'Next Candidate')
      const action = await askSwipeAction()
      if (action === 'quit') {
        break
      }

      if (action === 'yes') {
        nextProfile = await sendLikeToDiscoveredListing(nextProfile, current, ownListingAddress)
        likedCount += 1
        showSuccess(`Sent a like to ${current.profileDisplayName}.`)
      } else {
        nextProfile = recordSwipeDecision(nextProfile, current, action)
        skippedCount += 1
        showStep(`Passed on ${current.profileDisplayName} for now.`)
      }

      await store.saveProfile(nextProfile)
      queue = rankDiscoverListings(nextProfile, refreshed.listings)
    }

    showSection(
      [`Likes: ${likedCount}`, `Passes: ${skippedCount}`, `Remaining: ${queue.length}`].join('\n'),
      'Discover Summary',
    )
    return nextProfile
  }

  async function showDiscoverList(profile: ProfileConfig): Promise<void> {
    const refreshed = await loadDiscoverState(profile)
    if (refreshed.listings.length === 0) {
      showInfo('No listings found right now. Try again later.')
      return
    }
    showSection(renderDiscoverListings(refreshed.listings), 'Discover')
  }

  async function likeDiscoveredListing(
    profile: ProfileConfig,
    listingRef: string | undefined,
    flags: Record<string, CliFlagValue>,
  ): Promise<void> {
    if (!listingRef) {
      throw new Error('Use `discover like <listing-id|address>`.')
    }
    const refreshed = await loadDiscoverState(profile)
    const listing = resolveDiscoveredListing(refreshed.listings, listingRef)
    const ownListingAddress = await resolveOwnOpenListingAddress(
      refreshed.profile,
      getStringFlag(flags, 'from', 'from-listing'),
    )
    const nextProfile = await sendLikeToDiscoveredListing(refreshed.profile, listing, ownListingAddress)
    await store.saveProfile(nextProfile)
    showSection(renderDiscoverCard(listing, refreshed.listings.length), 'Liked')
    showSuccess(`Sent a like to ${listing.profileDisplayName}.`)
  }

  async function passDiscoveredListing(profile: ProfileConfig, listingRef: string | undefined): Promise<void> {
    if (!listingRef) {
      throw new Error('Use `discover pass <listing-id|address>`.')
    }
    const refreshed = await loadDiscoverState(profile)
    const listing = resolveDiscoveredListing(refreshed.listings, listingRef)
    const nextProfile = recordSwipeDecision(refreshed.profile, listing, 'no')
    await store.saveProfile(nextProfile)
    showSection(renderDiscoverCard(listing, refreshed.listings.length), 'Passed')
    showSuccess(`Passed on ${listing.profileDisplayName}.`)
  }

  async function loadDiscoverState(
    profile: ProfileConfig,
  ): Promise<{ profile: ProfileConfig; listings: RankedDiscoverListing[] }> {
    const refreshed = await runWithSpinner('Looking for people...', async () => {
      const synced = await service.syncInbox(profile)
      const withListings = await service.refreshOwnListings(synced)
      const listings = await service.discoverListings(withListings)
      return { profile: withListings, listings: rankDiscoverListings(withListings, listings) }
    })

    await store.saveProfile(refreshed.profile)
    return refreshed
  }

  async function resolveOwnOpenListingAddress(
    profile: ProfileConfig,
    listingRef?: string,
  ): Promise<string> {
    const openListings = profile.cache.listings.filter((item) => item.status === 'open')
    if (openListings.length === 0) {
      throw new Error('Publish at least one open listing first.')
    }

    const selected =
      (listingRef
        ? openListings.find((item) => item.id === listingRef || item.address === listingRef)
        : null) ?? null
    if (listingRef && !selected) {
      throw new Error('Own listing not found. Use `listing list` to check the id or address.')
    }
    if (selected) {
      return selected.address
    }
    if (openListings.length === 1) {
      return openListings[0]!.address
    }

    const listingAddress = await askSelect({
      message: 'Which of your listings should send the like?',
      options: openListings.map((item) => ({
        value: item.address,
        label: item.headline,
        hint: item.region,
      })),
    })
    return listingAddress
  }

  function resolveDiscoveredListing(
    listings: RankedDiscoverListing[],
    listingRef: string,
  ): RankedDiscoverListing {
    const listing = listings.find((item) => item.id === listingRef || item.address === listingRef)
    if (!listing) {
      throw new Error('Discover target not found. Use `discover list` to inspect available listings.')
    }
    return listing
  }

  async function sendLikeToDiscoveredListing(
    profile: ProfileConfig,
    listing: RankedDiscoverListing,
    ownListingAddress: string,
  ): Promise<ProfileConfig> {
    const withDecision = recordSwipeDecision(profile, listing, 'yes')
    return runWithSpinner('Sending like...', () =>
      service.sendLike(withDecision, {
        fromListing: ownListingAddress,
        toListing: listing.address,
        fromProfileName: withDecision.profileName,
        recipientPubkey: listing.authorPubkey,
        recipientRelays: listing.inboxRelays,
      }),
    )
  }

  async function showInbox(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await syncInboxState(profile)
    showSection(renderInboxSummary(nextProfile), 'Inbox')
    const conversations = buildConversations(nextProfile)
    if (conversations.length > 0) {
      showSection(renderConversationList(conversations.slice(0, 5)), 'Recent Conversations')
    }
    return nextProfile
  }

  async function watchInbox(profile: ProfileConfig, intervalSeconds: number): Promise<void> {
    let current = await showInbox(profile)
    showInfo(`Watching inbox every ${intervalSeconds}s. Press Ctrl+C to stop.`)

    let stopped = false
    const onSigint = () => {
      stopped = true
    }
    process.once('SIGINT', onSigint)

    try {
      while (!stopped) {
        await sleep(intervalSeconds * 1000)
        if (stopped) {
          break
        }

        const nextProfile = await syncInboxState(current)
        if (!hasInboxChanged(current, nextProfile)) {
          continue
        }

        current = nextProfile
        showSection(renderInboxSummary(current), 'Inbox Update')
        const conversations = buildConversations(current)
        if (conversations.length > 0) {
          showSection(renderConversationList(conversations.slice(0, 3)), 'Recent Conversations')
        }
      }
    } finally {
      process.off('SIGINT', onSigint)
      showInfo('Stopped watching inbox.')
    }
  }

  async function syncInboxState(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await runWithSpinner('Syncing inbox...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)
    return nextProfile
  }

  function hasInboxChanged(previous: ProfileConfig, next: ProfileConfig): boolean {
    if (previous.cache.likesReceived.length !== next.cache.likesReceived.length) return true
    if (previous.cache.matches.length !== next.cache.matches.length) return true
    if (previous.cache.chatMessages.length !== next.cache.chatMessages.length) return true
    return previous.cache.lastInboxSyncAt !== next.cache.lastInboxSyncAt
  }

  async function handleLikes(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await runWithSpinner('Syncing likes...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)
    showSection(renderLikes(nextProfile), 'Likes')

    const conversations = getLikedYouConversations(nextProfile)
    if (conversations.length === 0) {
      return nextProfile
    }

    const openConversation = await askConfirm({
      message: 'Open a DM with someone who liked you?',
      initialValue: true,
    })
    if (!openConversation) {
      return nextProfile
    }

    return handleChat(nextProfile, undefined, conversations)
  }

  async function handleMatches(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await runWithSpinner('Syncing matches...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)

    if (nextProfile.cache.matches.length === 0) {
      showInfo('No matches yet. Mutual likes will appear here.')
      return nextProfile
    }

    showSection(renderMatches(nextProfile.cache.matches), 'Matches')
    const openChat = await askConfirm({
      message: 'Open one now?',
      initialValue: true,
    })
    if (openChat) {
      return handleChat(
        nextProfile,
        undefined,
        buildConversations(nextProfile).filter((conversation) => conversation.source === 'matched'),
      )
    }
    return nextProfile
  }

  async function handleChat(
    profile: ProfileConfig,
    threadIdArg?: string,
    availableConversations?: ConversationRecord[],
    initialMessage?: string,
  ): Promise<ProfileConfig> {
    let nextProfile = profile
    if (!availableConversations) {
      nextProfile = await runWithSpinner('Syncing conversation...', () => service.syncInbox(profile))
      await store.saveProfile(nextProfile)
    }
    const conversations = availableConversations ?? buildConversations(nextProfile)
    if (conversations.length === 0) {
      showInfo('There are no conversations yet.')
      return nextProfile
    }

    const conversation =
      (threadIdArg ? conversations.find((item) => item.threadId === threadIdArg) : null) ??
      (await promptConversation(conversations))
    if (!conversation) {
      throw new Error('Conversation not found.')
    }

    if (initialMessage !== undefined) {
      const body = initialMessage.trim()
      if (!body) {
        throw new Error('Message is required.')
      }
      return sendChatMessage(nextProfile, conversation, body)
    }

    showSection(renderConversation(conversation), `chat | ${conversation.peerProfileName}`)
    while (true) {
      const body = await askText({
        message: 'Enter a message. Leave it blank to exit.',
        placeholder: 'こんにちは。まずはゆっくり話しませんか？',
        defaultValue: '',
      })
      if (!body.trim()) {
        return nextProfile
      }

      nextProfile = await sendChatMessage(nextProfile, conversation, body)

      const again = await askConfirm({
        message: 'Send another message?',
        initialValue: false,
      })
      if (!again) {
        return nextProfile
      }
    }
  }

  async function showConversationList(profile: ProfileConfig): Promise<void> {
    const nextProfile = await syncConversations(profile)
    const conversations = buildConversations(nextProfile)
    if (conversations.length === 0) {
      showInfo('There are no conversations yet.')
      return
    }
    showSection(renderConversationList(conversations), 'Conversations')
  }

  async function showConversationHistory(
    profile: ProfileConfig,
    threadIdArg?: string,
  ): Promise<void> {
    if (!threadIdArg) {
      throw new Error('Use `chat show <thread-id>` or `chat <thread-id>`.')
    }

    const nextProfile = await syncConversations(profile)
    const conversation = buildConversations(nextProfile).find((item) => item.threadId === threadIdArg)
    if (!conversation) {
      throw new Error('Conversation not found.')
    }

    showSection(renderConversation(conversation), `chat | ${conversation.peerProfileName}`)
  }

  async function syncConversations(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await runWithSpinner('Syncing conversation...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)
    return nextProfile
  }

  async function sendChatMessage(
    profile: ProfileConfig,
    conversation: ConversationRecord,
    body: string,
  ): Promise<ProfileConfig> {
    const nextProfile = await runWithSpinner('Sending message...', () =>
      service.sendChat(profile, {
        matchId: conversation.threadId,
        recipientPubkey: conversation.peerPubkey,
        recipientRelays: conversation.peerRelays,
        body,
      }),
    )
    await store.saveProfile(nextProfile)
    const refreshedConversation = buildConversations(nextProfile).find(
      (item) => item.threadId === conversation.threadId,
    )
    if (refreshedConversation) {
      showSection(renderConversation(refreshedConversation), `chat | ${refreshedConversation.peerProfileName}`)
    }
    showSuccess('Message sent.')
    return nextProfile
  }

  async function promptConfig(profile: ProfileConfig): Promise<ProfileConfig> {
    const action = await askSelect({
      message: 'Advanced config',
      options: [
        { value: 'show', label: 'Show current values', hint: 'Display storage, pubkey, and relays' },
        { value: 'relays', label: 'Edit relays', hint: 'Update 1-3 relay URLs' },
        { value: 'back', label: 'Back' },
      ],
    })

    if (action === 'show') {
      showSection(renderProfileCard(profile, true), 'Advanced Config')
      return profile
    }

    if (action === 'relays') {
      return promptRelayConfig(profile)
    }

    return profile
  }

  async function promptRelayConfig(profile: ProfileConfig, relayInputArg?: string): Promise<ProfileConfig> {
    showSection(profile.relays.join('\n'), 'Current Relays')
    const relayInput =
      relayInputArg ??
      (await askText({
        message: 'Enter new relays, comma separated.',
        defaultValue: profile.relays.join(', '),
        validate(value) {
          try {
            normalizeRelayList(value ?? '')
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid relay list.'
          }
        },
      }))

    const nextProfile = await runWithSpinner('Updating relays...', () =>
      service.updateRelays(profile, normalizeRelayList(relayInput)),
    )
    await store.saveProfile(nextProfile)
    return nextProfile
  }
}

class CancelledFlowError extends Error {}

function createTheme(preset: AppPreset) {
  const accent = preset.brand === 'create-kanojo' ? pc.cyan : pc.yellow
  return {
    accent,
    banner: (label: string) => accent(pc.inverse(label)),
  }
}

export function renderCliUsage(preset: AppPreset): string {
  const sampleDisplayName = preset.brand === 'create-kanojo' ? 'たくみ' : 'あや'
  return [
    `${preset.brand} [command] [options]`,
    '',
    'Interactive',
    `  ${preset.brand}`,
    '',
    'Quick commands',
    '  profile list',
    '  profile use <name>',
    '  profile show',
    '  profile edit --display-name "<name>" --bio "..."',
    '  profile import --name main --nsec nsec1... --publish',
    '  profile create --name main --display-name "<name>" --age-range "20代後半" --region 東京 --bio "映画とコーヒーが好きです。" --interests "映画, カフェ" --looking-age "20代" --looking-regions "東京, 神奈川" --looking-notes "落ち着いて話せる人"',
    '  listing publish --title "週末に一緒に映画を見に行ける人" --summary "まずはお茶からゆっくり話したいです。" --region 東京 --tags "映画, 夜カフェ"',
    '  listing edit <listing-id> --title "更新タイトル"',
    '  listing close --id <listing-id>',
    '  listing reopen <listing-id>',
    '  discover list',
    '  discover like <listing-id> --from <your-listing-id>',
    '  discover pass <listing-id>',
    '  inbox',
    '  watch --interval 10',
    '  chat list',
    '  chat show <thread-id>',
    '  chat <thread-id>',
    '  chat <thread-id> --message "こんにちは"',
    '  config relays --relays "wss://relay1.example,wss://relay2.example"',
    '',
    'Global options',
    '  --profile <name>   Use a specific profile',
    '  --help             Show this help',
    '',
    `Example: ${preset.brand} profile create --name main --display-name "${sampleDisplayName}" --age-range "20代後半" --region 東京 --bio "映画とコーヒーが好きです。"`,
  ].join('\n')
}

export function extractProfileOverride(args: string[]): { args: string[]; profileName: string | null } {
  const remaining: string[] = []
  let profileName: string | null = null

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? ''
    if (value === '--profile') {
      profileName = args[index + 1] ?? null
      index += 1
      continue
    }
    remaining.push(value)
  }

  return { args: remaining, profileName }
}

export function parseCommandFlags(args: string[]): ParsedCliArgs {
  const positionals: string[] = []
  const flags: Record<string, CliFlagValue> = {}

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? ''
    if (!value.startsWith('-') || value === '-') {
      positionals.push(value)
      continue
    }

    if (value === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }

    if (value === '-h') {
      flags.help = true
      continue
    }

    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }

    const trimmed = value.slice(2)
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex >= 0) {
      const name = trimmed.slice(0, separatorIndex).toLowerCase()
      flags[name] = trimmed.slice(separatorIndex + 1)
      continue
    }

    const name = trimmed.toLowerCase()
    const next = args[index + 1]
    if (next && !next.startsWith('-')) {
      flags[name] = next
      index += 1
      continue
    }

    flags[name] = true
  }

  return { positionals, flags }
}

async function askText(options: Parameters<typeof text>[0]): Promise<string> {
  const answer = await text(options)
  if (isCancel(answer)) {
    throw new CancelledFlowError()
  }
  return String(answer)
}

async function askSelect<T>(options: Parameters<typeof select<T>>[0]): Promise<T> {
  const answer = await select(options)
  if (isCancel(answer)) {
    throw new CancelledFlowError()
  }
  return answer as T
}

async function askConfirm(options: Parameters<typeof confirm>[0]): Promise<boolean> {
  const answer = await confirm(options)
  if (isCancel(answer)) {
    throw new CancelledFlowError()
  }
  return Boolean(answer)
}

async function withSpinner<T>(message: string, task: () => Promise<T>, plain = false): Promise<T> {
  if (plain) {
    return task()
  }

  const indicator = spinner()
  indicator.start(message)
  try {
    const result = await task()
    indicator.stop('Done.')
    return result
  } catch (error) {
    indicator.error('Failed.')
    throw error
  }
}

async function promptMatch(matches: MatchRecord[]): Promise<MatchRecord> {
  const matchId = await askSelect({
    message: 'Choose a conversation.',
    options: matches.map((match) => ({
      value: match.matchId,
      label: formatMatchChoiceLabel(match),
      hint: match.peerProfileName,
    })),
  })
  const match = matches.find((item) => item.matchId === matchId)
  if (!match) {
    throw new Error('Match not found.')
  }
  return match
}

async function promptConversation(conversations: ConversationRecord[]): Promise<ConversationRecord> {
  const threadId = await askSelect({
    message: 'Choose a conversation.',
    options: conversations.map((conversation) => ({
      value: conversation.threadId,
      label: formatConversationChoiceLabel(conversation),
      hint: conversation.peerPubkey.slice(0, 12),
    })),
  })
  const conversation = conversations.find((item) => item.threadId === threadId)
  if (!conversation) {
    throw new Error('Conversation not found.')
  }
  return conversation
}

function renderProfileCard(profile: ProfileConfig, advanced = false): string {
  const base = [
    `Name: ${profile.displayName}`,
    `role: ${profile.role} -> ${profile.target}`,
    `Region: ${profile.region}`,
    `Age Range: ${profile.ageRange}`,
    `Bio: ${profile.bio}`,
    `Interests: ${profile.interests.join(', ') || 'Not set'}`,
    `Looking For: ${profile.lookingFor.ageRange || 'Not set'} / ${profile.lookingFor.regions.join(', ') || 'Not set'}`,
  ]

  if (!advanced) {
    return base.join('\n')
  }

  return [
    ...base,
    '',
    `profile: ${profile.profileName}`,
    `pubkey: ${profile.nostr.pubkey}`,
    `nsec: ${maskSecret(profile.nostr.nsec)}`,
    `relay:\n${profile.relays.map((relay) => `  - ${relay}`).join('\n')}`,
    `likes sent/received: ${profile.cache.likesSent.length}/${profile.cache.likesReceived.length}`,
    `matches: ${profile.cache.matches.length}`,
  ].join('\n')
}

function renderListings(listings: ListingRecord[]): string {
  if (listings.length === 0) {
    return 'No listings yet.'
  }

  return listings
    .map(
      (listing) =>
        `${formatListingChoiceLabel(listing)}\n  id: ${listing.id}\n  updated: ${formatTimestamp(listing.updatedAt)}\n  ${listing.summary}\n  ${listing.address}`,
    )
    .join('\n\n')
}

function renderDiscoverCard(listing: RankedDiscoverListing, remainingCount: number): string {
  return [
    `id: ${listing.id}`,
    `address: ${listing.address}`,
    `score: ${listing.score}`,
    `Remaining: ${remainingCount}`,
    `${listing.profileDisplayName} | ${listing.region}`,
    listing.headline,
    listing.summary,
    `Interests: ${listing.interests.join(', ') || 'Not set'}`,
    `Looking For: ${listing.lookingFor.ageRange || 'Not set'} / ${listing.lookingFor.regions.join(', ') || 'Not set'}`,
    `Tags: ${listing.desiredTags.join(', ') || 'None'}`,
    `Why: ${listing.reasons.join(' / ') || 'Exploring new patterns'}`,
  ].join('\n')
}

function renderDiscoverListings(listings: RankedDiscoverListing[]): string {
  return listings
    .map(
      (listing, index) =>
        `${index + 1}. ${listing.profileDisplayName} | ${listing.headline}\n  id: ${listing.id}\n  address: ${listing.address}\n  region: ${listing.region}\n  score: ${listing.score}\n  tags: ${listing.desiredTags.join(', ') || 'None'}\n  why: ${listing.reasons.join(' / ') || 'Exploring new patterns'}`,
    )
    .join('\n\n')
}

function renderLikes(profile: ProfileConfig): string {
  const sent = profile.cache.likesSent
    .map((like) => `→ ${like.toListing}\n  ${like.fromProfileName} / ${formatTimestamp(like.createdAt)}`)
    .join('\n\n')
  const likedYouMap = new Map(getLikedYouConversations(profile).map((conversation) => [conversation.threadId, conversation]))
  const received = profile.cache.likesReceived
    .map((like) => {
      const conversation = likedYouMap.get(like.matchId)
      const dmState = conversation ? `DM ready (${conversation.messages.length} msgs)` : 'DM ready'
      return `← ${like.fromProfileName}\n  ${like.fromListing}\n  ${formatTimestamp(like.createdAt)}\n  ${dmState}`
    })
    .join('\n\n')

  return [
    'Sent Likes',
    sent || 'None yet.',
    '',
    'Received Likes',
    received || 'None yet.',
  ].join('\n')
}

function renderMatches(matches: MatchRecord[]): string {
  return matches
    .map((match) => `${match.peerProfileName}\n  ${match.matchId}\n  Updated: ${formatTimestamp(match.updatedAt)}`)
    .join('\n\n')
}

function renderChat(match: MatchRecord): string {
  const messages = match.messages
    .map((message) => {
      const speaker = message.senderPubkey === match.peerPubkey ? match.peerProfileName : 'You'
      return `${speaker}: ${message.body}`
    })
    .join('\n')

  return [
    `Conversation with ${match.peerProfileName}`,
    `matchId: ${match.matchId}`,
    '',
    messages || 'No messages yet.',
  ].join('\n')
}

function renderConversation(conversation: ConversationRecord): string {
  const messages = conversation.messages
    .map((message) => {
      const speaker = message.senderPubkey === conversation.peerPubkey ? conversation.peerProfileName : 'You'
      return `[${formatTimestamp(message.createdAt)}] ${speaker} (${message.rumorId}): ${message.body}`
    })
    .join('\n')

  return [
    `Conversation with ${conversation.peerProfileName}`,
    `Thread: ${conversation.threadId}`,
    `Source: ${conversation.source}`,
    `Messages: ${conversation.messages.length}`,
    `Updated: ${formatTimestamp(conversation.updatedAt)}`,
    '',
    messages || 'No messages yet.',
  ].join('\n')
}

function renderConversationList(conversations: ConversationRecord[]): string {
  return conversations
    .map(
      (conversation) =>
        `${conversation.peerProfileName}\n  ${conversation.threadId}\n  Source: ${conversation.source}\n  Messages: ${conversation.messages.length}\n  Updated: ${formatTimestamp(conversation.updatedAt)}`,
    )
    .join('\n\n')
}

function renderInboxSummary(profile: ProfileConfig): string {
  const latestConversation = buildConversations(profile)[0]
  return [
    `Last Sync: ${profile.cache.lastInboxSyncAt ? formatTimestamp(profile.cache.lastInboxSyncAt) : 'Never'}`,
    `Likes Received: ${profile.cache.likesReceived.length}`,
    `Matches: ${profile.cache.matches.length}`,
    `Messages: ${profile.cache.chatMessages.length}`,
    `Latest Thread: ${latestConversation ? `${latestConversation.peerProfileName} (${formatTimestamp(latestConversation.updatedAt)})` : 'None'}`,
  ].join('\n')
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('ja-JP')
}

function splitComma(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
}

function getStringFlag(flags: Record<string, CliFlagValue>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = flags[name]
    if (typeof value === 'string') {
      return value
    }
    if (value === true) {
      return ''
    }
  }
  return undefined
}

async function resolveRequiredInput(
  providedValue: string | undefined,
  options: Parameters<typeof text>[0],
): Promise<string> {
  if (providedValue !== undefined) {
    const normalized = providedValue.trim()
    const validation = options.validate?.(normalized)
    if (validation) {
      throw new Error(String(validation))
    }
    return normalized
  }
  return askText(options)
}

async function resolveOptionalInput(
  providedValue: string | undefined,
  options: Parameters<typeof text>[0],
): Promise<string> {
  if (providedValue !== undefined) {
    const normalized = providedValue.trim()
    const validation = options.validate?.(normalized)
    if (validation) {
      throw new Error(String(validation))
    }
    return normalized
  }
  return askText(options)
}

function normalizeRelayList(value: string): string[] {
  const items = splitComma(value)
  if (items.length === 0) {
    throw new Error('At least one relay is required.')
  }
  if (items.length > 3) {
    throw new Error('Use up to 3 relays.')
  }
  if (!items.every((item) => item.startsWith('wss://'))) {
    throw new Error('Relay URLs must start with wss://.')
  }
  return items
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function askSwipeAction(): Promise<SwipeAction | 'quit'> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const fallback = await askText({
      message: '[y] like / [n] pass / [q] quit',
      placeholder: 'y',
      validate(value) {
        const normalized = (value ?? '').trim().toLowerCase()
        if (!['y', 'n', 'q'].includes(normalized)) {
          return 'Enter y, n, or q.'
        }
      },
    })
    const normalized = normalizeSwipeAction(fallback)
    if (!normalized) {
      throw new Error('Swipe action could not be determined.')
    }
    return normalized
  }

  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write(pc.dim('Controls: [y] like  [n] pass  [q] quit\n'))

  return new Promise<SwipeAction | 'quit'>((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode(false)
      process.stdout.write('\n')
    }

    const onKeypress = (value: string, key: { sequence?: string; ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        reject(new CancelledFlowError())
        return
      }

      const normalized = normalizeSwipeAction(value)
      if (!normalized) {
        return
      }

      cleanup()
      resolve(normalized)
    }

    process.stdin.on('keypress', onKeypress)
  })
}

function normalizeSwipeAction(value: string): SwipeAction | 'quit' | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'y') return 'yes'
  if (normalized === 'n') return 'no'
  if (normalized === 'q') return 'quit'
  return null
}
