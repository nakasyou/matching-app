import { createHash } from 'node:crypto'
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip59,
  type Event,
  type EventTemplate,
  type Filter,
} from 'nostr-tools'
import {
  MATCHING_CONVERSATION_SUBJECT,
  MATCHING_APP_ID,
  MatchingKinds,
  createAddress,
  createChatPayload,
  createEmptyCache,
  createLikePayload,
  createListingDTag,
  createListingRecord,
  createMatchPayload,
  createProfileDTag,
  createMatchId,
  getRelayTags,
  getTagValue,
  integrateInboxRecords,
  nowInSeconds,
  parseMatchingListingEvent,
  parseMatchingProfileEvent,
  parsePrivatePayloadFromRumor,
  serializeInboxRelayEvent,
  serializeMatchingListingEvent,
  serializeMatchingProfileEvent,
  serializeMetadataEvent,
  type ChatEnvelope,
  type DiscoverListing,
  type LikePayload,
  type ListingRecord,
  type ListingStatus,
  type MatchPayload,
  type PendingMatchAck,
  type PrivatePayload,
  type ProfileConfig,
  type RumorEvent,
} from './protocol'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
]

export interface GeneratedCredentials {
  pubkey: string
  nsec: string
}

export interface NostrTransport {
  publish(relays: string[], events: Event[]): Promise<void>
  query(relays: string[], filter: Filter): Promise<Event[]>
  close(): void
}

export interface NostrServiceOptions {
  transport?: NostrTransport
  now?: () => number
}

export interface NostrService {
  transport: NostrTransport
  createGeneratedCredentials(): GeneratedCredentials
  publishProfile(profile: ProfileConfig): Promise<void>
  publishListing(
    profile: ProfileConfig,
    input: {
      headline: string
      summary: string
      region?: string
      desiredTags: string[]
    },
  ): Promise<ProfileConfig>
  refreshOwnListings(profile: ProfileConfig): Promise<ProfileConfig>
  closeListing(profile: ProfileConfig, listingId: string): Promise<ProfileConfig>
  updateListing(
    profile: ProfileConfig,
    input: {
      listingId: string
      headline?: string
      summary?: string
      region?: string
      desiredTags?: string[]
      status?: ListingStatus
    },
  ): Promise<ProfileConfig>
  discoverListings(profile: ProfileConfig): Promise<DiscoverListing[]>
  syncInbox(profile: ProfileConfig): Promise<ProfileConfig>
  sendLike(
    profile: ProfileConfig,
    input: {
      fromListing: string
      toListing: string
      fromProfileName: string
      recipientPubkey: string
      recipientRelays?: string[]
    },
  ): Promise<ProfileConfig>
  sendChat(
    profile: ProfileConfig,
    input: {
      matchId: string
      recipientPubkey: string
      recipientRelays?: string[]
      body: string
      replyToId?: string
    },
  ): Promise<ProfileConfig>
  updateRelays(profile: ProfileConfig, relays: string[]): Promise<ProfileConfig>
  close(): void
}

export function createNostrService(options: NostrServiceOptions = {}): NostrService {
  const transport = options.transport ?? createSimplePoolTransport()
  const now = options.now ?? nowInSeconds

  async function publishProfile(profile: ProfileConfig): Promise<void> {
    const secretKey = decodeNsec(profile.nostr.nsec)
    const events = [
      finalizeEvent(serializeMetadataEvent(profile), secretKey),
      finalizeEvent(serializeInboxRelayEvent(profile.relays), secretKey),
      finalizeEvent(serializeMatchingProfileEvent(profile), secretKey),
    ]
    await transport.publish(profile.relays, events)
  }

  async function publishListing(
    profile: ProfileConfig,
    input: {
      headline: string
      summary: string
      region?: string
      desiredTags: string[]
    },
  ): Promise<ProfileConfig> {
    const listing = createListingRecord(profile, {
      headline: input.headline,
      summary: input.summary,
      region: input.region,
      desiredTags: input.desiredTags,
      status: 'open',
      createdAt: now(),
      updatedAt: now(),
    })
    const secretKey = decodeNsec(profile.nostr.nsec)
    const signed = finalizeEvent(serializeMatchingListingEvent(profile, listing), secretKey)
    await transport.publish(profile.relays, [signed])

    return {
      ...profile,
      cache: {
        ...profile.cache,
        listings: [listing, ...profile.cache.listings.filter((item) => item.id !== listing.id)],
        lastListingSyncAt: now(),
      },
    }
  }

  async function refreshOwnListings(profile: ProfileConfig): Promise<ProfileConfig> {
    const events = await transport.query(profile.relays, {
      kinds: [MatchingKinds.matchingListing],
      authors: [profile.nostr.pubkey],
      limit: 200,
    })

    const listings = events
      .map(parseMatchingListingEvent)
      .filter((listing): listing is NonNullable<typeof listing> => Boolean(listing))
      .sort((left, right) => right.updatedAt - left.updatedAt)

    return {
      ...profile,
      cache: {
        ...profile.cache,
        listings,
        lastListingSyncAt: now(),
      },
    }
  }

  async function closeListing(profile: ProfileConfig, listingId: string): Promise<ProfileConfig> {
    return updateListing(profile, { listingId, status: 'closed' })
  }

  async function updateListing(
    profile: ProfileConfig,
    input: {
      listingId: string
      headline?: string
      summary?: string
      region?: string
      desiredTags?: string[]
      status?: ListingStatus
    },
  ): Promise<ProfileConfig> {
    const listing = profile.cache.listings.find((item) => item.id === input.listingId)
    if (!listing) {
      throw new Error(`Listing not found: ${input.listingId}`)
    }

    const nextListing: ListingRecord = {
      ...listing,
      headline: input.headline?.trim() ?? listing.headline,
      summary: input.summary?.trim() ?? listing.summary,
      region: input.region?.trim() ?? listing.region,
      desiredTags: uniqueStrings(input.desiredTags ?? listing.desiredTags),
      status: input.status ?? listing.status,
      updatedAt: now(),
    }

    const secretKey = decodeNsec(profile.nostr.nsec)
    const signed = finalizeEvent(serializeMatchingListingEvent(profile, nextListing), secretKey)
    await transport.publish(profile.relays, [signed])

    return {
      ...profile,
      cache: {
        ...profile.cache,
        listings: [nextListing, ...profile.cache.listings.filter((item) => item.id !== nextListing.id)],
        lastListingSyncAt: now(),
      },
    }
  }

  async function discoverListings(profile: ProfileConfig): Promise<DiscoverListing[]> {
    const [listingEvents, profileEvents] = await Promise.all([
      transport.query(profile.relays, {
        kinds: [MatchingKinds.matchingListing],
        limit: 200,
      }),
      transport.query(profile.relays, {
        kinds: [MatchingKinds.matchingProfile],
        limit: 200,
      }),
    ])

    const profilesByPubkey = new Map(
      profileEvents
        .map((event) => [event.pubkey, parseMatchingProfileEvent(event)] as const)
        .filter((entry): entry is [string, NonNullable<ReturnType<typeof parseMatchingProfileEvent>>] => Boolean(entry[1])),
    )

    const listings = listingEvents
      .map(parseMatchingListingEvent)
      .filter((listing): listing is NonNullable<typeof listing> => Boolean(listing))
      .filter((listing) => listing.status === 'open')
      .filter((listing) => listing.authorPubkey !== profile.nostr.pubkey)
      .filter((listing) => listing.role === profile.target && listing.target === profile.role)

    const uniqueAuthors = [...new Set(listings.map((listing) => listing.authorPubkey))]
    const relayEvents =
      uniqueAuthors.length > 0
        ? await transport.query(profile.relays, {
            kinds: [MatchingKinds.dmInboxRelays],
            authors: uniqueAuthors,
            limit: uniqueAuthors.length * 3,
          })
        : []
    const relayMap = new Map(uniqueAuthors.map((pubkey) => [pubkey, [] as string[]]))
    for (const event of relayEvents) {
      const relays = getRelayTags(event)
      if (relays.length > 0) {
        relayMap.set(event.pubkey, relays)
      }
    }

    return listings
      .map((listing) => {
        const remoteProfile = profilesByPubkey.get(listing.authorPubkey)
        return {
          ...listing,
          profileDisplayName: remoteProfile?.displayName ?? listing.profileName,
          profileBio: remoteProfile?.bio ?? '',
          interests: remoteProfile?.interests ?? [],
          lookingFor: remoteProfile?.lookingFor ?? { ageRange: '', regions: [], notes: '' },
          inboxRelays: relayMap.get(listing.authorPubkey) ?? profile.relays,
        } satisfies DiscoverListing
      })
      .sort((left, right) => {
        if (left.region === profile.region && right.region !== profile.region) {
          return -1
        }
        if (right.region === profile.region && left.region !== profile.region) {
          return 1
        }
        return right.updatedAt - left.updatedAt
      })
  }

  async function syncInbox(profile: ProfileConfig): Promise<ProfileConfig> {
    const secretKey = decodeNsec(profile.nostr.nsec)
    const wraps = await transport.query(profile.relays, {
      kinds: [MatchingKinds.giftWrap],
      '#p': [profile.nostr.pubkey],
      limit: 500,
    })

    const unseenWraps = wraps.filter((wrap) => !profile.cache.seenGiftWrapIds.includes(wrap.id))
    if (unseenWraps.length === 0) {
      return profile
    }

    const parsedRecords: Array<ReturnType<typeof parsePrivatePayloadFromRumor>> = []
    const seenGiftWrapIds = [...profile.cache.seenGiftWrapIds]

    for (const wrap of unseenWraps) {
      try {
        const rumor = nip59.unwrapEvent(wrap, secretKey) as RumorEvent
        const parsed = parsePrivatePayloadFromRumor(rumor, profile.nostr.pubkey)
        seenGiftWrapIds.push(wrap.id)
        if (parsed) {
          parsedRecords.push(parsed)
        }
      } catch {
        seenGiftWrapIds.push(wrap.id)
      }
    }

    let nextProfile = {
      ...profile,
      cache: {
        ...profile.cache,
        seenGiftWrapIds: [...new Set(seenGiftWrapIds)],
      },
    }

    const { profile: integrated, pendingAcks } = integrateInboxRecords(
      nextProfile,
      parsedRecords.filter((record): record is Exclude<typeof record, null> => Boolean(record)),
    )
    nextProfile = integrated

    for (const ack of pendingAcks) {
      nextProfile = await sendPrivatePayload(nextProfile, ack.recipientPubkey, ack.recipientRelays, createMatchPayload(ack))
    }

    return nextProfile
  }

  async function sendLike(
    profile: ProfileConfig,
    input: {
      fromListing: string
      toListing: string
      fromProfileName: string
      recipientPubkey: string
      recipientRelays?: string[]
    },
  ): Promise<ProfileConfig> {
    const matchId = createMatchId(input.fromListing, input.toListing)
    const payload = createLikePayload({
      matchId,
      fromListing: input.fromListing,
      toListing: input.toListing,
      fromProfileName: input.fromProfileName,
    })

    return sendPrivatePayload(profile, input.recipientPubkey, input.recipientRelays, payload)
  }

  async function sendChat(
    profile: ProfileConfig,
    input: {
      matchId: string
      recipientPubkey: string
      recipientRelays?: string[]
      body: string
      replyToId?: string
    },
  ): Promise<ProfileConfig> {
    return sendPrivatePayload(
      profile,
      input.recipientPubkey,
      input.recipientRelays,
      createChatPayload({
        matchId: input.matchId,
        body: input.body,
        replyToId: input.replyToId,
      }),
      input.replyToId,
    )
  }

  async function updateRelays(profile: ProfileConfig, relays: string[]): Promise<ProfileConfig> {
    const nextProfile: ProfileConfig = {
      ...profile,
      relays: uniqueStrings(relays).slice(0, 3),
    }
    await publishProfile(nextProfile)
    return nextProfile
  }

  async function sendPrivatePayload(
    profile: ProfileConfig,
    recipientPubkey: string,
    recipientRelays: string[] | undefined,
    payload: PrivatePayload,
    replyToId?: string,
  ): Promise<ProfileConfig> {
    const relayHints = uniqueStrings((recipientRelays?.length ? recipientRelays : await resolveRecipientRelays(profile, recipientPubkey)).slice(0, 3))
    const secretKey = decodeNsec(profile.nostr.nsec)
    const unsignedEvent = createPrivateEvent(recipientPubkey, relayHints, payload, replyToId)
    const recipientWrap = nip59.wrapEvent(unsignedEvent, secretKey, recipientPubkey)
    const selfWrap = nip59.wrapEvent(unsignedEvent, secretKey, profile.nostr.pubkey)
    await Promise.all([
      transport.publish(relayHints, [recipientWrap]),
      transport.publish(profile.relays, [selfWrap]),
    ])

    const localRumor = nip59.unwrapEvent(selfWrap, secretKey) as RumorEvent
    const parsed = parsePrivatePayloadFromRumor(localRumor, profile.nostr.pubkey)
    if (!parsed) {
      return profile
    }

    return integrateInboxRecords(profile, [parsed]).profile
  }

  async function resolveRecipientRelays(profile: ProfileConfig, recipientPubkey: string): Promise<string[]> {
    const relayEvents = await transport.query(profile.relays, {
      kinds: [MatchingKinds.dmInboxRelays],
      authors: [recipientPubkey],
      limit: 3,
    })

    for (const event of relayEvents) {
      const relays = getRelayTags(event)
      if (relays.length > 0) {
        return relays
      }
    }

    return profile.relays
  }

  return {
    transport,
    createGeneratedCredentials,
    publishProfile,
    publishListing,
    refreshOwnListings,
    closeListing,
    updateListing,
    discoverListings,
    syncInbox,
    sendLike,
    sendChat,
    updateRelays,
    close() {
      transport.close()
    },
  }
}

export function createGeneratedCredentials(): GeneratedCredentials {
  const secretKey = generateSecretKey()
  return {
    pubkey: getPublicKey(secretKey),
    nsec: nip19.nsecEncode(secretKey),
  }
}

export function importCredentials(nsec: string): GeneratedCredentials {
  const secretKey = decodeNsec(nsec.trim())
  return {
    pubkey: getPublicKey(secretKey),
    nsec: nip19.nsecEncode(secretKey),
  }
}

export function createSimplePoolTransport(): NostrTransport {
  const pool = new SimplePool()

  return {
    async publish(relays, events) {
      const uniqueRelays = uniqueStrings(relays)
      await Promise.all(
        events.flatMap((event) =>
          pool.publish(uniqueRelays, event).map((promise) => promise.catch(() => 'failed')),
        ),
      )
    },
    async query(relays, filter) {
      return pool.querySync(uniqueStrings(relays), filter, { maxWait: 1500 })
    },
    close() {
      pool.destroy()
    },
  }
}

export function createMemoryTransport(): NostrTransport {
  const events = new Map<string, Event>()
  const seenOn = new Map<string, Set<string>>()

  return {
    async publish(relays, publishedEvents) {
      const relaySet = new Set(uniqueStrings(relays))
      for (const event of publishedEvents) {
        events.set(event.id, event)
        const known = seenOn.get(event.id) ?? new Set<string>()
        for (const relay of relaySet) {
          known.add(relay)
        }
        seenOn.set(event.id, known)
      }
    },
    async query(relays, filter) {
      const relaySet = new Set(uniqueStrings(relays))
      const matched = [...events.values()].filter((event) => {
        const relaysForEvent = seenOn.get(event.id)
        if (!relaysForEvent || [...relaySet].every((relay) => !relaysForEvent.has(relay))) {
          return false
        }
        return matchesFilter(event, filter)
      })

      matched.sort((left, right) => right.created_at - left.created_at)
      return typeof filter.limit === 'number' ? matched.slice(0, filter.limit) : matched
    },
    close() {},
  }
}

function createPrivateEvent(
  recipientPubkey: string,
  recipientRelays: string[],
  payload: PrivatePayload,
  replyToId?: string,
): EventTemplate {
  const tags: string[][] = [
    ['p', recipientPubkey, recipientRelays[0] ?? ''],
    ['subject', `${MATCHING_CONVERSATION_SUBJECT}:${payload.matchId}`],
    ['app', MATCHING_APP_ID],
    ['code', payload.code],
  ]

  if (replyToId) {
    tags.push(['e', replyToId, recipientRelays[0] ?? '', 'reply'])
  }

  return {
    kind: MatchingKinds.privateMessage,
    created_at: payload.sentAt,
    tags,
    content: JSON.stringify(payload),
  }
}

function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec)
  if (decoded.type !== 'nsec') {
    throw new Error('Invalid nsec value.')
  }
  return decoded.data as Uint8Array
}

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false
  }

  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false
  }

  if (filter.ids && !filter.ids.includes(event.id)) {
    return false
  }

  if (typeof filter.since === 'number' && event.created_at < filter.since) {
    return false
  }

  if (typeof filter.until === 'number' && event.created_at > filter.until) {
    return false
  }

  const entries = Object.entries(filter as Record<string, unknown>)
  for (const [key, value] of entries) {
    if (!key.startsWith('#') || !Array.isArray(value) || key.length !== 2) {
      continue
    }

    const tagName = key.slice(1)
    const allowed = new Set(value.filter((item): item is string => typeof item === 'string'))
    if (allowed.size === 0) {
      continue
    }

    const actualValues = event.tags
      .filter((tag) => tag[0] === tagName)
      .map((tag) => tag[1])
      .filter((tag): tag is string => typeof tag === 'string')
    if (!actualValues.some((item) => allowed.has(item))) {
      return false
    }
  }

  return true
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
