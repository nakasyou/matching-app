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
import { DEFAULT_RELAYS, createGeneratedCredentials, createNostrService, type NostrServiceOptions } from './nostr'
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

export function createMatchingCli(preset: AppPreset, options: MatchingCliOptions = {}): MatchingCli {
  const store = loadProfileStore(options.baseDir)
  const service = createNostrService(options)
  const theme = createTheme(preset)

  return {
    async run(rawArgs = process.argv.slice(2)) {
      await store.ensure()
      intro(theme.banner(` ${preset.brand} `))

      try {
        const parsed = extractProfileOverride(rawArgs)
        await dispatchCommand(parsed.args, parsed.profileName)
        outro(theme.accent('Connected quietly. Ready for the next good match.'))
      } catch (error) {
        if (error instanceof CancelledFlowError) {
          cancel('Operation cancelled.')
          return
        }

        log.error(error instanceof Error ? error.message : 'Unexpected error.')
      } finally {
        service.close()
      }
    },
  }

  async function dispatchCommand(args: string[], profileOverride: string | null): Promise<void> {
    const [command, subcommand, ...rest] = args

    if (!command) {
      await runHome(profileOverride)
      return
    }

    if (command === 'profile') {
      await runProfileCommand(subcommand, rest, profileOverride)
      return
    }

    if (command === 'listing') {
      await runListingCommand(subcommand, rest, profileOverride)
      return
    }

    if (command === 'discover') {
      await runDiscover(profileOverride)
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
      await runChat(profileOverride, subcommand)
      return
    }

    if (command === 'config') {
      await runConfigCommand(subcommand, profileOverride)
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

      note(renderProfileCard(profile), 'Current Profile')
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
        note(renderProfileCard(profile, true), 'Profile Details')
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
    profileOverride: string | null,
  ): Promise<void> {
    if (subcommand === 'create') {
      await promptProfileCreate()
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
        log.info('No profiles yet. Start with `profile create`.')
        return
      }
      note(
        profiles.map((name) => `${name === active ? '●' : '○'} ${name}`).join('\n'),
        'Profiles',
      )
      return
    }

    if (subcommand === 'show') {
      const profile = await ensureProfile(profileOverride)
      note(renderProfileCard(profile, true), 'Profile Details')
      return
    }

    throw new Error('Use `profile create|use|list|show`.')
  }

  async function runListingCommand(
    subcommand: string | undefined,
    _args: string[],
    profileOverride: string | null,
  ): Promise<void> {
    const profile = await ensureProfile(profileOverride)

    if (subcommand === 'publish') {
      await handlePublishListing(profile)
      return
    }

    if (subcommand === 'list') {
      const refreshed = await service.refreshOwnListings(profile)
      await store.saveProfile(refreshed)
      note(renderListings(refreshed.cache.listings), 'Your Listings')
      return
    }

    if (subcommand === 'close') {
      const refreshed = await service.refreshOwnListings(profile)
      const openListings = refreshed.cache.listings.filter((listing) => listing.status === 'open')
      if (openListings.length === 0) {
        log.info('There are no open listings to close.')
        return
      }
      const listingId = await askSelect({
        message: 'Choose a listing to close.',
        options: openListings.map((listing) => ({
          value: listing.id,
          label: listing.headline,
          hint: listing.region,
        })),
      })
      const nextProfile = await withSpinner('Closing listing...', () =>
        service.closeListing(refreshed, listingId),
      )
      await store.saveProfile(nextProfile)
      log.success('Listing closed.')
      return
    }

    throw new Error('Use `listing publish|list|close`.')
  }

  async function runDiscover(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleDiscover(profile)
  }

  async function runLikes(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleLikes(profile)
  }

  async function runMatches(profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleMatches(profile)
  }

  async function runChat(profileOverride: string | null, matchIdArg?: string): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    await handleChat(profile, matchIdArg)
  }

  async function runConfigCommand(subcommand: string | undefined, profileOverride: string | null): Promise<void> {
    const profile = await ensureProfile(profileOverride)
    if (subcommand === 'show') {
      note(renderProfileCard(profile, true), 'Advanced Config')
      return
    }
    if (subcommand === 'relays') {
      const nextProfile = await promptRelayConfig(profile)
      await store.saveProfile(nextProfile)
      log.success('Relay list updated.')
      return
    }
    throw new Error('Use `config show|relays`.')
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

  async function promptProfileCreate(): Promise<ProfileConfig> {
    const profileName = await askText({
      message: 'Choose a profile name.',
      placeholder: 'main',
      defaultValue: 'main',
      validate(value) {
        const normalized = value?.trim() ?? ''
        if (!normalized) return 'Profile name is required.'
        if (!/^[a-z0-9-]+$/.test(normalized)) return 'Use lowercase letters, digits, and hyphens only.'
      },
    })

    const displayName = await askText({
      message: 'What display name should we show?',
      placeholder: preset.brand === 'create-kanojo' ? 'たくみ' : 'あや',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Display name is required.'
      },
    })
    const ageRange = await askText({
      message: 'How would you describe your age range?',
      placeholder: '20代後半',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Age range is required.'
      },
    })
    const region = await askText({
      message: 'Which area do you usually meet in?',
      placeholder: '東京',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Region is required.'
      },
    })
    const bio = await askText({
      message: 'Write a short intro.',
      placeholder: '映画とコーヒーが好きです。',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Bio is required.'
      },
    })
    const interests = await askText({
      message: 'List interests or vibe tags, comma separated.',
      placeholder: '映画, カフェ, 散歩',
    })
    const lookingForAge = await askText({
      message: 'What age range are you looking for?',
      placeholder: '20代',
    })
    const lookingForRegions = await askText({
      message: 'Which regions do you want to meet in? Use commas.',
      placeholder: region,
    })
    const lookingForNotes = await askText({
      message: 'What kind of person feels right for you?',
      placeholder: '落ち着いて話せる人',
    })

    const credentials = createGeneratedCredentials()
    const profile = createDefaultProfile(preset, {
      profileName,
      displayName,
      bio,
      region,
      ageRange,
      interests: splitComma(interests),
      lookingFor: {
        ageRange: lookingForAge,
        regions: splitComma(lookingForRegions),
        notes: lookingForNotes,
      },
      nostr: credentials,
      relays: DEFAULT_RELAYS,
    })

    const published = await withSpinner('Preparing profile...', async () => {
      await service.publishProfile(profile)
      return profile
    })
    await store.saveProfile(published)
    await store.setActiveProfile(preset.brand, published.profileName)
    note(renderProfileCard(published), 'Profile Created')
    return published
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
    note(renderProfileCard(profile), 'Active Profile')
    return profile
  }

  async function handlePublishListing(profile: ProfileConfig): Promise<ProfileConfig> {
    const headline = await askText({
      message: 'Enter the listing title.',
      placeholder: '週末に一緒に映画を見に行ける人',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Title is required.'
      },
    })
    const summary = await askText({
      message: 'Write a short summary.',
      placeholder: 'まずはお茶からゆっくり話したいです。',
      validate(value) {
        if (!(value?.trim() ?? '')) return 'Summary is required.'
      },
    })
    const region = await askText({
      message: 'Which region is this listing for?',
      defaultValue: profile.region,
    })
    const desiredTags = await askText({
      message: 'Enter tags, comma separated.',
      placeholder: '映画, 落ち着き, 夜カフェ',
    })

    const nextProfile = await withSpinner('Publishing listing...', () =>
      service.publishListing(profile, {
        headline,
        summary,
        region,
        desiredTags: splitComma(desiredTags),
      }),
    )
    await store.saveProfile(nextProfile)
    log.success('Listing published.')
    return nextProfile
  }

  async function handleDiscover(profile: ProfileConfig): Promise<ProfileConfig> {
    const refreshed = await withSpinner('Looking for people...', async () => {
      const synced = await service.syncInbox(profile)
      const withListings = await service.refreshOwnListings(synced)
      const listings = await service.discoverListings(withListings)
      return { profile: withListings, listings: rankDiscoverListings(withListings, listings) }
    })

    await store.saveProfile(refreshed.profile)
    if (refreshed.listings.length === 0) {
      log.info('No listings found right now. Try again later.')
      return refreshed.profile
    }

    const openListings = refreshed.profile.cache.listings.filter((item) => item.status === 'open')
    if (openListings.length === 0) {
      log.warn('Publish at least one open listing first.')
      return refreshed.profile
    }

    const ownListingAddress =
      openListings.length === 1
        ? openListings[0]!.address
        : await askSelect({
            message: 'Which of your listings should send the like?',
            options: openListings.map((item) => ({
              value: item.address,
              label: item.headline,
              hint: item.region,
            })),
          })

    note(
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

      note(renderDiscoverCard(current, queue.length), 'Next Candidate')
      const action = await askSwipeAction()
      if (action === 'quit') {
        break
      }

      nextProfile = recordSwipeDecision(nextProfile, current, action)

      if (action === 'yes') {
        nextProfile = await withSpinner('Sending like...', () =>
          service.sendLike(nextProfile, {
            fromListing: ownListingAddress,
            toListing: current.address,
            fromProfileName: nextProfile.profileName,
            recipientPubkey: current.authorPubkey,
            recipientRelays: current.inboxRelays,
          }),
        )
        likedCount += 1
        log.success(`Sent a like to ${current.profileDisplayName}.`)
      } else {
        skippedCount += 1
        log.step(`Passed on ${current.profileDisplayName} for now.`)
      }

      await store.saveProfile(nextProfile)
      queue = rankDiscoverListings(nextProfile, refreshed.listings)
    }

    note(
      [`Likes: ${likedCount}`, `Passes: ${skippedCount}`, `Remaining: ${queue.length}`].join('\n'),
      'Discover Summary',
    )
    return nextProfile
  }

  async function handleLikes(profile: ProfileConfig): Promise<ProfileConfig> {
    const nextProfile = await withSpinner('Syncing likes...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)
    note(renderLikes(nextProfile), 'Likes')

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
    const nextProfile = await withSpinner('Syncing matches...', () => service.syncInbox(profile))
    await store.saveProfile(nextProfile)

    if (nextProfile.cache.matches.length === 0) {
      log.info('No matches yet. Mutual likes will appear here.')
      return nextProfile
    }

    note(renderMatches(nextProfile.cache.matches), 'Matches')
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
  ): Promise<ProfileConfig> {
    let nextProfile = profile
    if (!availableConversations) {
      nextProfile = await withSpinner('Syncing conversation...', () => service.syncInbox(profile))
      await store.saveProfile(nextProfile)
    }
    const conversations = availableConversations ?? buildConversations(nextProfile)
    if (conversations.length === 0) {
      log.info('There are no conversations yet.')
      return nextProfile
    }

    const conversation =
      (threadIdArg ? conversations.find((item) => item.threadId === threadIdArg) : null) ??
      (await promptConversation(conversations))
    if (!conversation) {
      throw new Error('Conversation not found.')
    }

    note(renderConversation(conversation), `chat | ${conversation.peerProfileName}`)
    while (true) {
      const body = await askText({
        message: 'Enter a message. Leave it blank to exit.',
        placeholder: 'こんにちは。まずはゆっくり話しませんか？',
        defaultValue: '',
      })
      if (!body.trim()) {
        return nextProfile
      }

      nextProfile = await withSpinner('Sending message...', () =>
        service.sendChat(nextProfile, {
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
        note(renderConversation(refreshedConversation), `chat | ${refreshedConversation.peerProfileName}`)
      }

      const again = await askConfirm({
        message: 'Send another message?',
        initialValue: false,
      })
      if (!again) {
        return nextProfile
      }
    }
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
      note(renderProfileCard(profile, true), 'Advanced Config')
      return profile
    }

    if (action === 'relays') {
      return promptRelayConfig(profile)
    }

    return profile
  }

  async function promptRelayConfig(profile: ProfileConfig): Promise<ProfileConfig> {
    note(profile.relays.join('\n'), 'Current Relays')
    const relayInput = await askText({
      message: 'Enter new relays, comma separated.',
      defaultValue: profile.relays.join(', '),
      validate(value) {
        const items = splitComma(value ?? '')
        if (items.length === 0) return 'At least one relay is required.'
        if (items.length > 3) return 'Use up to 3 relays.'
        if (!items.every((item) => item.startsWith('wss://'))) return 'Relay URLs must start with wss://.'
      },
    })

    const nextProfile = await withSpinner('Updating relays...', () =>
      service.updateRelays(profile, splitComma(relayInput)),
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

function extractProfileOverride(args: string[]): { args: string[]; profileName: string | null } {
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

async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
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
    .map((listing) => `${formatListingChoiceLabel(listing)}\n  ${listing.summary}\n  ${listing.address}`)
    .join('\n\n')
}

function renderDiscoverCard(listing: RankedDiscoverListing, remainingCount: number): string {
  return [
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

function renderLikes(profile: ProfileConfig): string {
  const sent = profile.cache.likesSent
    .map((like) => `→ ${like.toListing}\n  ${like.fromProfileName} / ${new Date(like.createdAt * 1000).toLocaleString('en-US')}`)
    .join('\n\n')
  const likedYouMap = new Map(getLikedYouConversations(profile).map((conversation) => [conversation.threadId, conversation]))
  const received = profile.cache.likesReceived
    .map((like) => {
      const conversation = likedYouMap.get(like.matchId)
      const dmState = conversation ? `DM ready (${conversation.messages.length} msgs)` : 'DM ready'
      return `← ${like.fromProfileName}\n  ${like.fromListing}\n  ${new Date(like.createdAt * 1000).toLocaleString('en-US')}\n  ${dmState}`
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
    .map((match) => `${match.peerProfileName}\n  ${match.matchId}\n  Updated: ${new Date(match.updatedAt * 1000).toLocaleString('en-US')}`)
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
      return `${speaker}: ${message.body}`
    })
    .join('\n')

  return [
    `Conversation with ${conversation.peerProfileName}`,
    `Thread: ${conversation.threadId}`,
    `Source: ${conversation.source}`,
    '',
    messages || 'No messages yet.',
  ].join('\n')
}

function splitComma(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
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
