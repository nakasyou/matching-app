import { createHash } from 'node:crypto'
import type { Event, EventTemplate } from 'nostr-tools'

export const MATCHING_APP_ID = 'create-matching'
export const MATCHING_CONVERSATION_SUBJECT = 'create-matching-chat'

export const MatchingKinds = Object.freeze({
  metadata: 0,
  dmInboxRelays: 10050,
  giftWrap: 1059,
  privateMessage: 14,
  matchingProfile: 31210,
  matchingListing: 31211,
})

export const MatchingTags = Object.freeze([
  'd',
  'a',
  'p',
  'alt',
  't',
  'app',
  'code',
  'profile',
  'listing',
  'role',
  'target',
  'region',
])

export type Brand = 'create-kanojo' | 'create-kareshi'
export type Role = 'male' | 'female'
export type ListingStatus = 'open' | 'closed'
export type PrivateActionCode = 'like.v1' | 'match.v1' | 'chat.v1'

export interface AppPreset {
  brand: Brand
  role: Role
  target: Role
}

export interface LookingFor {
  ageRange: string
  regions: string[]
  notes: string
}

export interface NostrCredentials {
  pubkey: string
  nsec: string
}

export interface UiPreferences {
  accent: string
  locale: 'ja'
}

export interface ListingRecord {
  id: string
  dTag: string
  address: string
  authorPubkey: string
  profileName: string
  headline: string
  summary: string
  region: string
  desiredTags: string[]
  status: ListingStatus
  createdAt: number
  updatedAt: number
  role: Role
  target: Role
}

export interface DiscoverListing extends ListingRecord {
  profileDisplayName: string
  profileBio: string
  interests: string[]
  lookingFor: LookingFor
  inboxRelays: string[]
}

export type SwipeAction = 'yes' | 'no'

export interface SwipeDecision {
  listingAddress: string
  authorPubkey: string
  profileDisplayName: string
  region: string
  desiredTags: string[]
  interests: string[]
  action: SwipeAction
  createdAt: number
}

export interface RankedDiscoverListing extends DiscoverListing {
  score: number
  reasons: string[]
}

export interface ProfileCache {
  listings: ListingRecord[]
  likesSent: LikeRecord[]
  likesReceived: LikeRecord[]
  matches: MatchRecord[]
  chatMessages: ChatEnvelope[]
  swipeHistory: SwipeDecision[]
  seenGiftWrapIds: string[]
  seenRumorIds: string[]
  lastInboxSyncAt: number | null
  lastListingSyncAt: number | null
}

export interface ProfileConfig {
  version: 1
  profileName: string
  brand: Brand
  role: Role
  target: Role
  displayName: string
  bio: string
  region: string
  ageRange: string
  interests: string[]
  lookingFor: LookingFor
  nostr: NostrCredentials
  relays: string[]
  ui: UiPreferences
  cache: ProfileCache
}

export interface BaseEnvelope {
  code: PrivateActionCode
  matchId: string
  rumorId: string
  senderPubkey: string
  recipientPubkey: string
  createdAt: number
  relayHints: string[]
}

export interface LikeRecord extends BaseEnvelope {
  code: 'like.v1'
  fromListing: string
  toListing: string
  fromProfileName: string
}

export interface MatchNotice extends BaseEnvelope {
  code: 'match.v1'
  fromListing: string
  toListing: string
}

export interface ChatEnvelope extends BaseEnvelope {
  code: 'chat.v1'
  body: string
  replyToId?: string
}

export interface MatchRecord {
  matchId: string
  ownListing: string
  peerListing: string
  peerPubkey: string
  peerProfileName: string
  peerRelays: string[]
  createdAt: number
  updatedAt: number
  messages: ChatEnvelope[]
}

export type ConversationSource = 'liked-you' | 'you-liked' | 'matched' | 'chat'

export interface ConversationRecord {
  threadId: string
  peerPubkey: string
  peerProfileName: string
  peerRelays: string[]
  ownListing: string
  peerListing: string
  createdAt: number
  updatedAt: number
  source: ConversationSource
  messages: ChatEnvelope[]
}

export interface PendingMatchAck {
  matchId: string
  recipientPubkey: string
  recipientRelays: string[]
  fromListing: string
  toListing: string
}

export interface MatchingProfileContent {
  displayName: string
  ageRange: string
  region: string
  bio: string
  interests: string[]
  lookingFor: LookingFor
  updatedAt: number
}

export interface MatchingListingContent {
  headline: string
  summary: string
  region: string
  desiredTags: string[]
  status: ListingStatus
  createdAt: number
  updatedAt: number
}

export interface LikePayload {
  code: 'like.v1'
  matchId: string
  fromListing: string
  toListing: string
  fromProfileName: string
  sentAt: number
}

export interface MatchPayload {
  code: 'match.v1'
  matchId: string
  fromListing: string
  toListing: string
  sentAt: number
}

export interface ChatPayload {
  code: 'chat.v1'
  matchId: string
  body: string
  sentAt: number
  replyToId?: string
}

export type PrivatePayload = LikePayload | MatchPayload | ChatPayload

export interface RumorEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export function createEmptyCache(): ProfileCache {
  return {
    listings: [],
    likesSent: [],
    likesReceived: [],
    matches: [],
    chatMessages: [],
    swipeHistory: [],
    seenGiftWrapIds: [],
    seenRumorIds: [],
    lastInboxSyncAt: null,
    lastListingSyncAt: null,
  }
}

export function createDefaultProfile(
  preset: AppPreset,
  input: {
    profileName: string
    displayName: string
    bio: string
    region: string
    ageRange: string
    interests: string[]
    lookingFor: LookingFor
    nostr: NostrCredentials
    relays: string[]
  },
): ProfileConfig {
  return {
    version: 1,
    profileName: input.profileName,
    brand: preset.brand,
    role: preset.role,
    target: preset.target,
    displayName: input.displayName,
    bio: input.bio,
    region: input.region,
    ageRange: input.ageRange,
    interests: uniqueStrings(input.interests),
    lookingFor: {
      ageRange: input.lookingFor.ageRange.trim(),
      regions: uniqueStrings(input.lookingFor.regions),
      notes: input.lookingFor.notes.trim(),
    },
    nostr: input.nostr,
    relays: uniqueStrings(input.relays),
    ui: {
      accent: preset.brand === 'create-kanojo' ? 'cyan' : 'yellow',
      locale: 'ja',
    },
    cache: createEmptyCache(),
  }
}

export function normalizeProfile(raw: unknown): ProfileConfig {
  const candidate = raw as Partial<ProfileConfig> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid profile payload.')
  }

  const cache = candidate.cache as Partial<ProfileCache> | undefined
  const lookingFor = candidate.lookingFor as Partial<LookingFor> | undefined
  const ui = candidate.ui as Partial<UiPreferences> | undefined
  const nostr = candidate.nostr as Partial<NostrCredentials> | undefined

  return {
    version: 1,
    profileName: stringValue(candidate.profileName),
    brand: brandValue(candidate.brand),
    role: roleValue(candidate.role),
    target: roleValue(candidate.target),
    displayName: stringValue(candidate.displayName),
    bio: stringValue(candidate.bio),
    region: stringValue(candidate.region),
    ageRange: stringValue(candidate.ageRange),
    interests: arrayOfStrings(candidate.interests),
    lookingFor: {
      ageRange: stringValue(lookingFor?.ageRange),
      regions: arrayOfStrings(lookingFor?.regions),
      notes: stringValue(lookingFor?.notes),
    },
    nostr: {
      pubkey: stringValue(nostr?.pubkey),
      nsec: stringValue(nostr?.nsec),
    },
    relays: arrayOfStrings(candidate.relays),
    ui: {
      accent: stringValue(ui?.accent, 'cyan'),
      locale: 'ja',
    },
    cache: {
      listings: Array.isArray(cache?.listings) ? cache!.listings.map(normalizeListingRecord) : [],
      likesSent: Array.isArray(cache?.likesSent) ? cache!.likesSent.map(normalizeLikeRecord) : [],
      likesReceived: Array.isArray(cache?.likesReceived) ? cache!.likesReceived.map(normalizeLikeRecord) : [],
      matches: Array.isArray(cache?.matches) ? cache!.matches.map(normalizeMatchRecord) : [],
      chatMessages: Array.isArray(cache?.chatMessages) ? cache!.chatMessages.map(normalizeChatEnvelope) : [],
      swipeHistory: Array.isArray(cache?.swipeHistory) ? cache!.swipeHistory.map(normalizeSwipeDecision) : [],
      seenGiftWrapIds: arrayOfStrings(cache?.seenGiftWrapIds),
      seenRumorIds: arrayOfStrings(cache?.seenRumorIds),
      lastInboxSyncAt: numberOrNull(cache?.lastInboxSyncAt),
      lastListingSyncAt: numberOrNull(cache?.lastListingSyncAt),
    },
  }
}

export function normalizeListingRecord(raw: unknown): ListingRecord {
  const candidate = raw as Partial<ListingRecord> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid listing payload.')
  }

  return {
    id: stringValue(candidate.id),
    dTag: stringValue(candidate.dTag),
    address: stringValue(candidate.address),
    authorPubkey: stringValue(candidate.authorPubkey),
    profileName: stringValue(candidate.profileName),
    headline: stringValue(candidate.headline),
    summary: stringValue(candidate.summary),
    region: stringValue(candidate.region),
    desiredTags: arrayOfStrings(candidate.desiredTags),
    status: listingStatusValue(candidate.status),
    createdAt: numberValue(candidate.createdAt),
    updatedAt: numberValue(candidate.updatedAt),
    role: roleValue(candidate.role),
    target: roleValue(candidate.target),
  }
}

export function normalizeLikeRecord(raw: unknown): LikeRecord {
  const candidate = raw as Partial<LikeRecord> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid like payload.')
  }

  return {
    code: 'like.v1',
    matchId: stringValue(candidate.matchId),
    rumorId: stringValue(candidate.rumorId),
    senderPubkey: stringValue(candidate.senderPubkey),
    recipientPubkey: stringValue(candidate.recipientPubkey),
    createdAt: numberValue(candidate.createdAt),
    relayHints: arrayOfStrings(candidate.relayHints),
    fromListing: stringValue(candidate.fromListing),
    toListing: stringValue(candidate.toListing),
    fromProfileName: stringValue(candidate.fromProfileName),
  }
}

export function normalizeChatEnvelope(raw: unknown): ChatEnvelope {
  const candidate = raw as Partial<ChatEnvelope> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid chat payload.')
  }

  return {
    code: 'chat.v1',
    matchId: stringValue(candidate.matchId),
    rumorId: stringValue(candidate.rumorId),
    senderPubkey: stringValue(candidate.senderPubkey),
    recipientPubkey: stringValue(candidate.recipientPubkey),
    createdAt: numberValue(candidate.createdAt),
    relayHints: arrayOfStrings(candidate.relayHints),
    body: stringValue(candidate.body),
    replyToId: optionalString(candidate.replyToId),
  }
}

export function normalizeMatchRecord(raw: unknown): MatchRecord {
  const candidate = raw as Partial<MatchRecord> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid match payload.')
  }

  return {
    matchId: stringValue(candidate.matchId),
    ownListing: stringValue(candidate.ownListing),
    peerListing: stringValue(candidate.peerListing),
    peerPubkey: stringValue(candidate.peerPubkey),
    peerProfileName: stringValue(candidate.peerProfileName),
    peerRelays: arrayOfStrings(candidate.peerRelays),
    createdAt: numberValue(candidate.createdAt),
    updatedAt: numberValue(candidate.updatedAt),
    messages: Array.isArray(candidate.messages) ? candidate.messages.map(normalizeChatEnvelope) : [],
  }
}

export function normalizeSwipeDecision(raw: unknown): SwipeDecision {
  const candidate = raw as Partial<SwipeDecision> | null | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Invalid swipe decision payload.')
  }

  return {
    listingAddress: stringValue(candidate.listingAddress),
    authorPubkey: stringValue(candidate.authorPubkey),
    profileDisplayName: stringValue(candidate.profileDisplayName),
    region: stringValue(candidate.region),
    desiredTags: arrayOfStrings(candidate.desiredTags),
    interests: arrayOfStrings(candidate.interests),
    action: candidate.action === 'yes' ? 'yes' : 'no',
    createdAt: numberValue(candidate.createdAt),
  }
}

export function createProfileDTag(profileName: string): string {
  return `profile:${profileName}`
}

export function createListingDTag(listingId: string): string {
  return `listing:${listingId}`
}

export function createAddress(kind: number, pubkey: string, dTag: string): string {
  return `${kind}:${pubkey}:${dTag}`
}

export function createMatchId(senderListing: string, targetListing: string): string {
  return createHash('sha256')
    .update([senderListing, targetListing].sort().join('|'))
    .digest('hex')
}

export function maskSecret(secret: string): string {
  if (secret.length <= 10) {
    return '********'
  }

  return `${secret.slice(0, 6)}…${secret.slice(-4)}`
}

export function serializeMetadataEvent(profile: ProfileConfig): EventTemplate {
  return {
    kind: MatchingKinds.metadata,
    created_at: nowInSeconds(),
    tags: [
      ['alt', `create-matching metadata for ${profile.displayName}`],
      ['app', MATCHING_APP_ID],
    ],
    content: JSON.stringify({
      name: profile.displayName,
      display_name: profile.displayName,
      about: profile.bio,
    }),
  }
}

export function serializeInboxRelayEvent(relays: string[]): EventTemplate {
  return {
    kind: MatchingKinds.dmInboxRelays,
    created_at: nowInSeconds(),
    tags: uniqueStrings(relays).map((relay) => ['relay', relay]),
    content: '',
  }
}

export function serializeMatchingProfileEvent(profile: ProfileConfig): EventTemplate {
  const dTag = createProfileDTag(profile.profileName)
  const content: MatchingProfileContent = {
    displayName: profile.displayName,
    ageRange: profile.ageRange,
    region: profile.region,
    bio: profile.bio,
    interests: uniqueStrings(profile.interests),
    lookingFor: {
      ageRange: profile.lookingFor.ageRange,
      regions: uniqueStrings(profile.lookingFor.regions),
      notes: profile.lookingFor.notes,
    },
    updatedAt: nowInSeconds(),
  }

  return {
    kind: MatchingKinds.matchingProfile,
    created_at: content.updatedAt,
    tags: [
      ['d', dTag],
      ['alt', `${profile.displayName} matching profile`],
      ['app', MATCHING_APP_ID],
      ['code', 'profile.v1'],
      ['profile', profile.profileName],
      ['role', profile.role],
      ['target', profile.target],
      ['region', profile.region],
      ['t', MATCHING_APP_ID],
      ['t', 'profile'],
    ],
    content: JSON.stringify(content),
  }
}

export function serializeMatchingListingEvent(
  profile: ProfileConfig,
  listing: ListingRecord,
): EventTemplate {
  const content: MatchingListingContent = {
    headline: listing.headline,
    summary: listing.summary,
    region: listing.region,
    desiredTags: uniqueStrings(listing.desiredTags),
    status: listing.status,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  }

  return {
    kind: MatchingKinds.matchingListing,
    created_at: listing.updatedAt,
    tags: [
      ['d', listing.dTag],
      ['a', createAddress(MatchingKinds.matchingProfile, profile.nostr.pubkey, createProfileDTag(profile.profileName))],
      ['alt', `${listing.headline} listing by ${profile.displayName}`],
      ['app', MATCHING_APP_ID],
      ['code', 'listing.v1'],
      ['profile', profile.profileName],
      ['listing', listing.id],
      ['role', profile.role],
      ['target', profile.target],
      ['region', listing.region],
      ['t', MATCHING_APP_ID],
      ...uniqueStrings(listing.desiredTags).map((tag) => ['t', tag]),
    ],
    content: JSON.stringify(content),
  }
}

export function parseMatchingProfileEvent(event: Event): MatchingProfileContent | null {
  if (event.kind !== MatchingKinds.matchingProfile) {
    return null
  }

  return parseJson<MatchingProfileContent>(event.content)
}

export function parseMatchingListingEvent(event: Event): ListingRecord | null {
  if (event.kind !== MatchingKinds.matchingListing) {
    return null
  }

  const content = parseJson<MatchingListingContent>(event.content)
  if (!content) {
    return null
  }

  const listingId = getTagValue(event.tags, 'listing') ?? getTagValue(event.tags, 'd')?.replace(/^listing:/, '')
  const profileName = getTagValue(event.tags, 'profile')
  const dTag = getTagValue(event.tags, 'd')
  const role = getTagValue(event.tags, 'role')
  const target = getTagValue(event.tags, 'target')

  if (!listingId || !profileName || !dTag || !role || !target) {
    return null
  }

  return {
    id: listingId,
    dTag,
    address: createAddress(MatchingKinds.matchingListing, event.pubkey, dTag),
    authorPubkey: event.pubkey,
    profileName,
    headline: content.headline,
    summary: content.summary,
    region: content.region,
    desiredTags: uniqueStrings(content.desiredTags),
    status: content.status,
    createdAt: content.createdAt,
    updatedAt: content.updatedAt,
    role: roleValue(role),
    target: roleValue(target),
  }
}

export function getRelayTags(event: Event): string[] {
  return uniqueStrings(
    event.tags.filter((tag) => tag[0] === 'relay').map((tag) => tag[1]).filter(Boolean) as string[],
  )
}

export function getTagValue(tags: string[][], tagName: string): string | undefined {
  return tags.find((tag) => tag[0] === tagName)?.[1]
}

export function getTagValues(tags: string[][], tagName: string): string[] {
  return uniqueStrings(
    tags.filter((tag) => tag[0] === tagName).map((tag) => tag[1]).filter(Boolean) as string[],
  )
}

export function getPTagRelayHints(tags: string[][]): string[] {
  return uniqueStrings(
    tags
      .filter((tag) => tag[0] === 'p' && typeof tag[2] === 'string')
      .map((tag) => tag[2] as string)
      .filter(Boolean),
  )
}

export function parsePrivatePayloadFromRumor(
  rumor: RumorEvent,
  ownPubkey: string,
): LikeRecord | MatchNotice | ChatEnvelope | null {
  if (rumor.kind !== MatchingKinds.privateMessage) {
    return null
  }

  const payload = parseJson<PrivatePayload>(rumor.content)
  if (!payload || !isPrivateCode(payload.code)) {
    return null
  }

  const recipientPubkey = getTagValue(rumor.tags, 'p')
  if (!recipientPubkey) {
    return null
  }

  const relayHints = getPTagRelayHints(rumor.tags)
  const base = {
    matchId: payload.matchId,
    rumorId: rumor.id,
    senderPubkey: rumor.pubkey,
    recipientPubkey,
    createdAt: payload.sentAt ?? rumor.created_at,
    relayHints,
  }

  if (payload.code === 'like.v1') {
    return {
      code: 'like.v1',
      ...base,
      fromListing: payload.fromListing,
      toListing: payload.toListing,
      fromProfileName: payload.fromProfileName,
    }
  }

  if (payload.code === 'match.v1') {
    return {
      code: 'match.v1',
      ...base,
      fromListing: payload.fromListing,
      toListing: payload.toListing,
    }
  }

  const chat: ChatEnvelope = {
    code: 'chat.v1',
    ...base,
    body: payload.body,
    replyToId: payload.replyToId,
  }

  if (chat.senderPubkey === ownPubkey || chat.recipientPubkey === ownPubkey) {
    return chat
  }

  return null
}

export function createLikePayload(input: Omit<LikePayload, 'code' | 'sentAt'> & { sentAt?: number }): LikePayload {
  return {
    code: 'like.v1',
    matchId: input.matchId,
    fromListing: input.fromListing,
    toListing: input.toListing,
    fromProfileName: input.fromProfileName,
    sentAt: input.sentAt ?? nowInSeconds(),
  }
}

export function createMatchPayload(
  input: Omit<MatchPayload, 'code' | 'sentAt'> & { sentAt?: number },
): MatchPayload {
  return {
    code: 'match.v1',
    matchId: input.matchId,
    fromListing: input.fromListing,
    toListing: input.toListing,
    sentAt: input.sentAt ?? nowInSeconds(),
  }
}

export function createChatPayload(input: Omit<ChatPayload, 'code' | 'sentAt'> & { sentAt?: number }): ChatPayload {
  return {
    code: 'chat.v1',
    matchId: input.matchId,
    body: input.body.trim(),
    sentAt: input.sentAt ?? nowInSeconds(),
    replyToId: input.replyToId,
  }
}

export function createListingRecord(
  profile: ProfileConfig,
  input: {
    id?: string
    headline: string
    summary: string
    region?: string
    desiredTags: string[]
    status?: ListingStatus
    createdAt?: number
    updatedAt?: number
  },
): ListingRecord {
  const id = input.id ?? crypto.randomUUID()
  const dTag = createListingDTag(id)
  const createdAt = input.createdAt ?? nowInSeconds()
  const updatedAt = input.updatedAt ?? createdAt

  return {
    id,
    dTag,
    address: createAddress(MatchingKinds.matchingListing, profile.nostr.pubkey, dTag),
    authorPubkey: profile.nostr.pubkey,
    profileName: profile.profileName,
    headline: input.headline.trim(),
    summary: input.summary.trim(),
    region: (input.region ?? profile.region).trim(),
    desiredTags: uniqueStrings(input.desiredTags),
    status: input.status ?? 'open',
    createdAt,
    updatedAt,
    role: profile.role,
    target: profile.target,
  }
}

export function upsertListings(cache: ProfileCache, listings: ListingRecord[]): ProfileCache {
  const next = new Map(cache.listings.map((listing) => [listing.id, listing]))
  for (const listing of listings) {
    next.set(listing.id, listing)
  }

  return {
    ...cache,
    listings: [...next.values()].sort((left, right) => right.updatedAt - left.updatedAt),
  }
}

export function integrateInboxRecords(
  profile: ProfileConfig,
  records: Array<LikeRecord | MatchNotice | ChatEnvelope>,
): { profile: ProfileConfig; pendingAcks: PendingMatchAck[] } {
  const cache: ProfileCache = {
    ...profile.cache,
    listings: [...profile.cache.listings],
    likesSent: [...profile.cache.likesSent],
    likesReceived: [...profile.cache.likesReceived],
    matches: [...profile.cache.matches],
    chatMessages: [...profile.cache.chatMessages],
    seenGiftWrapIds: uniqueStrings(profile.cache.seenGiftWrapIds),
    seenRumorIds: uniqueStrings(profile.cache.seenRumorIds),
  }

  for (const record of records) {
    if (cache.seenRumorIds.includes(record.rumorId)) {
      continue
    }

    cache.seenRumorIds.push(record.rumorId)
    if (record.code === 'like.v1') {
      const bucket = record.senderPubkey === profile.nostr.pubkey ? cache.likesSent : cache.likesReceived
      if (!bucket.some((item) => item.rumorId === record.rumorId)) {
        bucket.push(record)
      }
      continue
    }

    if (record.code === 'chat.v1') {
      if (!cache.chatMessages.some((item) => item.rumorId === record.rumorId)) {
        cache.chatMessages.push(record)
      }
      continue
    }
  }

  const matchNotices = records.filter((record): record is MatchNotice => record.code === 'match.v1')
  const sentMatches = new Set(
    matchNotices.filter((record) => record.senderPubkey === profile.nostr.pubkey).map((record) => record.matchId),
  )

  const sentByMatch = new Map(cache.likesSent.map((record) => [record.matchId, record]))
  const receivedByMatch = new Map(cache.likesReceived.map((record) => [record.matchId, record]))
  const messagesByMatch = groupBy(cache.chatMessages, (message) => message.matchId)
  const currentMatches = new Map(profile.cache.matches.map((match) => [match.matchId, match]))

  const pendingAcks: PendingMatchAck[] = []
  const unionIds = uniqueStrings([...sentByMatch.keys(), ...receivedByMatch.keys(), ...matchNotices.map((record) => record.matchId)])

  for (const matchId of unionIds) {
    const sent = sentByMatch.get(matchId)
    const received = receivedByMatch.get(matchId)
    if (!sent || !received) {
      continue
    }

    const peerPubkey = sent.recipientPubkey
    const ownListing = sent.fromListing
    const peerListing = sent.toListing
    const peerProfileName = received.fromProfileName
    const peerRelays = uniqueStrings([...sent.relayHints, ...received.relayHints])
    const messages = [...(messagesByMatch.get(matchId) ?? [])].sort((left, right) => left.createdAt - right.createdAt)
    const existing = currentMatches.get(matchId)
    currentMatches.set(matchId, {
      matchId,
      ownListing,
      peerListing,
      peerPubkey,
      peerProfileName,
      peerRelays,
      createdAt: existing?.createdAt ?? Math.min(sent.createdAt, received.createdAt),
      updatedAt: Math.max(
        existing?.updatedAt ?? 0,
        sent.createdAt,
        received.createdAt,
        ...messages.map((message) => message.createdAt),
      ),
      messages,
    })

    if (!sentMatches.has(matchId)) {
      pendingAcks.push({
        matchId,
        recipientPubkey: peerPubkey,
        recipientRelays: peerRelays,
        fromListing: ownListing,
        toListing: peerListing,
      })
    }
  }

  const nextProfile: ProfileConfig = {
    ...profile,
    cache: {
      ...cache,
      likesSent: cache.likesSent.sort((left, right) => right.createdAt - left.createdAt),
      likesReceived: cache.likesReceived.sort((left, right) => right.createdAt - left.createdAt),
      chatMessages: cache.chatMessages.sort((left, right) => left.createdAt - right.createdAt),
      matches: [...currentMatches.values()].sort((left, right) => right.updatedAt - left.updatedAt),
      seenRumorIds: uniqueStrings(cache.seenRumorIds),
      lastInboxSyncAt: nowInSeconds(),
    },
  }

  return {
    profile: nextProfile,
    pendingAcks: pendingAcks.filter((ack, index, list) => list.findIndex((item) => item.matchId === ack.matchId) === index),
  }
}

export function formatListingChoiceLabel(listing: ListingRecord): string {
  return `${listing.headline} | ${listing.region} | ${listing.status === 'open' ? '募集中' : '終了'}`
}

export function formatMatchChoiceLabel(match: MatchRecord): string {
  return `${match.peerProfileName} | ${match.messages.length}件 | ${new Date(match.updatedAt * 1000).toLocaleString('ja-JP')}`
}

export function formatConversationChoiceLabel(conversation: ConversationRecord): string {
  return `${conversation.peerProfileName} | ${describeConversationSource(conversation.source)} | ${conversation.messages.length}件`
}

export function stringifyPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function buildConversations(profile: ProfileConfig): ConversationRecord[] {
  const sentByMatch = new Map(profile.cache.likesSent.map((record) => [record.matchId, record]))
  const receivedByMatch = new Map(profile.cache.likesReceived.map((record) => [record.matchId, record]))
  const matchById = new Map(profile.cache.matches.map((match) => [match.matchId, match]))
  const messagesByMatch = groupBy(profile.cache.chatMessages, (message) => message.matchId)

  const threadIds = uniqueStrings([
    ...receivedByMatch.keys(),
    ...matchById.keys(),
    ...messagesByMatch.keys(),
  ])

  return threadIds
    .map((threadId) => {
      const match = matchById.get(threadId)
      if (match) {
        return {
          threadId: match.matchId,
          peerPubkey: match.peerPubkey,
          peerProfileName: match.peerProfileName,
          peerRelays: uniqueStrings(match.peerRelays),
          ownListing: match.ownListing,
          peerListing: match.peerListing,
          createdAt: match.createdAt,
          updatedAt: match.updatedAt,
          source: 'matched',
          messages: [...match.messages].sort((left, right) => left.createdAt - right.createdAt),
        } satisfies ConversationRecord
      }

      const received = receivedByMatch.get(threadId)
      const sent = sentByMatch.get(threadId)
      const messages = [...(messagesByMatch.get(threadId) ?? [])].sort((left, right) => left.createdAt - right.createdAt)
      const peerPubkey =
        received?.senderPubkey ??
        sent?.recipientPubkey ??
        findPeerPubkeyFromMessages(profile, messages)
      if (!peerPubkey) {
        return null
      }

      const createdAt = Math.min(
        received?.createdAt ?? Number.MAX_SAFE_INTEGER,
        sent?.createdAt ?? Number.MAX_SAFE_INTEGER,
        messages[0]?.createdAt ?? Number.MAX_SAFE_INTEGER,
      )
      const updatedAt = Math.max(
        received?.createdAt ?? 0,
        sent?.createdAt ?? 0,
        ...messages.map((message) => message.createdAt),
      )

      return {
        threadId,
        peerPubkey,
        peerProfileName:
          received?.fromProfileName ??
          guessPeerNameFromMessages(profile, peerPubkey, messages) ??
          shortPubkey(peerPubkey),
        peerRelays: uniqueStrings([
          ...(received?.relayHints ?? []),
          ...(sent?.relayHints ?? []),
          ...messages.flatMap((message) => message.relayHints),
        ]),
        ownListing: received?.toListing ?? sent?.fromListing ?? '',
        peerListing: received?.fromListing ?? sent?.toListing ?? '',
        createdAt: createdAt === Number.MAX_SAFE_INTEGER ? nowInSeconds() : createdAt,
        updatedAt,
        source: received ? 'liked-you' : messages.length > 0 ? 'chat' : 'you-liked',
        messages,
      } satisfies ConversationRecord
    })
    .filter((conversation): conversation is ConversationRecord => Boolean(conversation))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getLikedYouConversations(profile: ProfileConfig): ConversationRecord[] {
  return buildConversations(profile).filter(
    (conversation) => conversation.source === 'liked-you' || conversation.source === 'matched',
  )
}

export function recordSwipeDecision(
  profile: ProfileConfig,
  listing: DiscoverListing,
  action: SwipeAction,
): ProfileConfig {
  const decision: SwipeDecision = {
    listingAddress: listing.address,
    authorPubkey: listing.authorPubkey,
    profileDisplayName: listing.profileDisplayName,
    region: listing.region,
    desiredTags: uniqueStrings(listing.desiredTags),
    interests: uniqueStrings(listing.interests),
    action,
    createdAt: nowInSeconds(),
  }

  return {
    ...profile,
    cache: {
      ...profile.cache,
      swipeHistory: [
        decision,
        ...profile.cache.swipeHistory.filter((item) => item.listingAddress !== listing.address),
      ],
    },
  }
}

export function rankDiscoverListings(
  profile: ProfileConfig,
  listings: DiscoverListing[],
): RankedDiscoverListing[] {
  const alreadyLiked = new Set(profile.cache.likesSent.map((item) => item.toListing))
  const alreadyMatched = new Set(profile.cache.matches.map((item) => item.peerListing))
  const alreadyClassified = new Set(profile.cache.swipeHistory.map((item) => item.listingAddress))
  const feedback = profile.cache.swipeHistory

  return listings
    .filter((listing) => !alreadyLiked.has(listing.address))
    .filter((listing) => !alreadyMatched.has(listing.address))
    .filter((listing) => !alreadyClassified.has(listing.address))
    .map((listing) => {
      const reasons: Array<{ label: string; weight: number }> = []
      let score = 0

      if (listing.region === profile.region) {
        score += 18
        reasons.push({ label: '同じ地域', weight: 18 })
      }

      if (profile.lookingFor.regions.includes(listing.region)) {
        score += 12
        reasons.push({ label: '希望地域に一致', weight: 12 })
      }

      const tagOverlap = overlap(profile.interests, listing.desiredTags)
      if (tagOverlap.length > 0) {
        const weight = tagOverlap.length * 8
        score += weight
        reasons.push({ label: `興味タグ一致: ${tagOverlap.join(', ')}`, weight })
      }

      const interestOverlap = overlap(profile.interests, listing.interests)
      if (interestOverlap.length > 0) {
        const weight = interestOverlap.length * 6
        score += weight
        reasons.push({ label: `趣味一致: ${interestOverlap.join(', ')}`, weight })
      }

      if (listing.lookingFor.regions.includes(profile.region)) {
        score += 8
        reasons.push({ label: '相手の希望地域にも合う', weight: 8 })
      }

      const historicalTagDelta = calculateHistoricalDelta(
        feedback,
        uniqueStrings([...listing.desiredTags, ...listing.interests]),
      )
      if (historicalTagDelta !== 0) {
        score += historicalTagDelta
        reasons.push({
          label: historicalTagDelta > 0 ? '過去に好評な傾向' : '過去に見送った傾向',
          weight: historicalTagDelta,
        })
      }

      const historicalRegionDelta = feedback.reduce((total, entry) => {
        if (entry.region !== listing.region) {
          return total
        }
        return total + (entry.action === 'yes' ? 10 : -12)
      }, 0)
      if (historicalRegionDelta !== 0) {
        score += historicalRegionDelta
        reasons.push({
          label: historicalRegionDelta > 0 ? '好みの地域傾向' : '見送りが多い地域',
          weight: historicalRegionDelta,
        })
      }

      const authorDelta = feedback.reduce((total, entry) => {
        if (entry.authorPubkey !== listing.authorPubkey) {
          return total
        }
        return total + (entry.action === 'yes' ? 30 : -25)
      }, 0)
      if (authorDelta !== 0) {
        score += authorDelta
        reasons.push({
          label: authorDelta > 0 ? 'この相手を好評価済み' : 'この相手は以前見送り済み',
          weight: authorDelta,
        })
      }

      return {
        ...listing,
        score,
        reasons: reasons
          .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
          .slice(0, 3)
          .map((reason) => reason.label),
      } satisfies RankedDiscoverListing
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return right.updatedAt - left.updatedAt
    })
}

function isPrivateCode(code: string): code is PrivateActionCode {
  return code === 'like.v1' || code === 'match.v1' || code === 'chat.v1'
}

function describeConversationSource(source: ConversationSource): string {
  if (source === 'matched') return 'match'
  if (source === 'liked-you') return 'いいね受信'
  if (source === 'you-liked') return 'いいね送信'
  return 'DM'
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    const bucket = map.get(groupKey) ?? []
    bucket.push(item)
    map.set(groupKey, bucket)
  }
  return map
}

function findPeerPubkeyFromMessages(profile: ProfileConfig, messages: ChatEnvelope[]): string | null {
  for (const message of messages) {
    if (message.senderPubkey !== profile.nostr.pubkey) {
      return message.senderPubkey
    }
    if (message.recipientPubkey !== profile.nostr.pubkey) {
      return message.recipientPubkey
    }
  }
  return null
}

function guessPeerNameFromMessages(
  profile: ProfileConfig,
  peerPubkey: string,
  messages: ChatEnvelope[],
): string | null {
  const receivedLike = profile.cache.likesReceived.find((like) => like.senderPubkey === peerPubkey)
  if (receivedLike) {
    return receivedLike.fromProfileName
  }
  const sentLike = profile.cache.likesSent.find((like) => like.recipientPubkey === peerPubkey)
  if (sentLike) {
    return shortPubkey(peerPubkey)
  }
  return messages.length > 0 ? shortPubkey(peerPubkey) : null
}

function shortPubkey(pubkey: string): string {
  if (pubkey.length <= 12) {
    return pubkey
  }
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`
}

function calculateHistoricalDelta(history: SwipeDecision[], tags: string[]): number {
  const normalizedTags = uniqueStrings(tags)
  if (normalizedTags.length === 0) {
    return 0
  }

  return history.reduce((total, entry) => {
    const overlapCount =
      overlap(normalizedTags, uniqueStrings([...entry.desiredTags, ...entry.interests])).length
    if (overlapCount === 0) {
      return total
    }
    return total + overlapCount * (entry.action === 'yes' ? 7 : -9)
  }, 0)
}

function overlap(left: string[], right: string[]): string[] {
  const rightSet = new Set(uniqueStrings(right).map((item) => item.toLowerCase()))
  return uniqueStrings(left).filter((item) => rightSet.has(item.toLowerCase()))
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set(arrayOfStrings(values).map((value) => value.trim()).filter(Boolean))]
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown, fallback = nowInSeconds()): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roleValue(value: unknown): Role {
  return value === 'female' ? 'female' : 'male'
}

function brandValue(value: unknown): Brand {
  return value === 'create-kareshi' ? 'create-kareshi' : 'create-kanojo'
}

function listingStatusValue(value: unknown): ListingStatus {
  return value === 'closed' ? 'closed' : 'open'
}
