import { describe, expect, test } from 'bun:test'
import {
  buildConversations,
  createChatPayload,
  createDefaultProfile,
  createLikePayload,
  createListingRecord,
  createMatchId,
  integrateInboxRecords,
  maskSecret,
  rankDiscoverListings,
  recordSwipeDecision,
  type DiscoverListing,
} from '../protocol'

describe('protocol helpers', () => {
  test('createMatchId is stable regardless of order', () => {
    const left = createMatchId('31211:alice:listing:a', '31211:bob:listing:b')
    const right = createMatchId('31211:bob:listing:b', '31211:alice:listing:a')
    expect(left).toBe(right)
  })

  test('maskSecret keeps the head and tail only', () => {
    expect(maskSecret('nsec1234567890abcdef')).toBe('nsec12…cdef')
  })

  test('integrateInboxRecords creates a match from reciprocal likes and threads chat', () => {
    const alice = createDefaultProfile(
      { brand: 'create-kanojo', role: 'male', target: 'female' },
      {
        profileName: 'alice',
        displayName: 'Alice',
        bio: 'coffee',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'slow' },
        nostr: { pubkey: 'alice-pub', nsec: 'nsecalice' },
        relays: ['wss://relay.test'],
      },
    )
    const aliceListing = createListingRecord(alice, {
      id: 'alice-listing',
      headline: 'movie',
      summary: 'movie night',
      desiredTags: ['movie'],
    })
    const bobListingAddress = '31211:bob-pub:listing:bob-listing'
    const matchId = createMatchId(aliceListing.address, bobListingAddress)

    const { profile } = integrateInboxRecords(alice, [
      {
        ...createLikePayload({
          matchId,
          fromListing: aliceListing.address,
          toListing: bobListingAddress,
          fromProfileName: 'alice',
          sentAt: 10,
        }),
        rumorId: 'r-sent-like',
        senderPubkey: 'alice-pub',
        recipientPubkey: 'bob-pub',
        createdAt: 10,
        relayHints: ['wss://relay.test'],
      },
      {
        ...createLikePayload({
          matchId,
          fromListing: bobListingAddress,
          toListing: aliceListing.address,
          fromProfileName: 'bob',
          sentAt: 11,
        }),
        rumorId: 'r-received-like',
        senderPubkey: 'bob-pub',
        recipientPubkey: 'alice-pub',
        createdAt: 11,
        relayHints: ['wss://relay.test'],
      },
      {
        ...createChatPayload({
          matchId,
          body: 'こんにちは',
          sentAt: 12,
        }),
        rumorId: 'r-chat',
        senderPubkey: 'bob-pub',
        recipientPubkey: 'alice-pub',
        createdAt: 12,
        relayHints: ['wss://relay.test'],
      },
    ])

    expect(profile.cache.matches).toHaveLength(1)
    expect(profile.cache.matches[0]?.peerProfileName).toBe('bob')
    expect(profile.cache.matches[0]?.messages[0]?.body).toBe('こんにちは')
  })

  test('rankDiscoverListings learns from y/n history and excludes classified listings', () => {
    const profile = createDefaultProfile(
      { brand: 'create-kanojo', role: 'male', target: 'female' },
      {
        profileName: 'main',
        displayName: 'Main',
        bio: 'coffee',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee', 'movie'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'slow' },
        nostr: { pubkey: 'me', nsec: 'nsecme' },
        relays: ['wss://relay.test'],
      },
    )

    const listings: DiscoverListing[] = [
      {
        id: 'one',
        dTag: 'listing:one',
        address: '31211:one:listing:one',
        authorPubkey: 'one',
        profileName: 'one',
        headline: 'coffee',
        summary: 'coffee',
        region: 'Tokyo',
        desiredTags: ['coffee'],
        status: 'open',
        createdAt: 1,
        updatedAt: 10,
        role: 'female',
        target: 'male',
        profileDisplayName: 'One',
        profileBio: 'coffee',
        interests: ['movie'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: '' },
        inboxRelays: ['wss://relay.test'],
      },
      {
        id: 'two',
        dTag: 'listing:two',
        address: '31211:two:listing:two',
        authorPubkey: 'two',
        profileName: 'two',
        headline: 'club',
        summary: 'club',
        region: 'Osaka',
        desiredTags: ['club'],
        status: 'open',
        createdAt: 1,
        updatedAt: 11,
        role: 'female',
        target: 'male',
        profileDisplayName: 'Two',
        profileBio: 'club',
        interests: ['party'],
        lookingFor: { ageRange: '20s', regions: ['Osaka'], notes: '' },
        inboxRelays: ['wss://relay.test'],
      },
    ]

    const afterYes = recordSwipeDecision(profile, listings[0]!, 'yes')
    const ranked = rankDiscoverListings(afterYes, listings)

    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.address).toBe(listings[1]?.address)
    expect(ranked[0]?.score).toBeLessThanOrEqual(0)
  })

  test('buildConversations includes threads from received likes before a match exists', () => {
    const profile = createDefaultProfile(
      { brand: 'create-kareshi', role: 'female', target: 'male' },
      {
        profileName: 'main',
        displayName: 'Main',
        bio: 'bio',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'kind' },
        nostr: { pubkey: 'me', nsec: 'nsec' },
        relays: ['wss://relay.test'],
      },
    )

    const withInbox = integrateInboxRecords(profile, [
      {
        ...createLikePayload({
          matchId: 'thread-1',
          fromListing: '31211:peer:listing:1',
          toListing: '31211:me:listing:1',
          fromProfileName: 'Peer',
          sentAt: 11,
        }),
        rumorId: 'like-1',
        senderPubkey: 'peer-pub',
        recipientPubkey: 'me',
        createdAt: 11,
        relayHints: ['wss://relay.test'],
      },
      {
        ...createChatPayload({
          matchId: 'thread-1',
          body: 'hello',
          sentAt: 12,
        }),
        rumorId: 'chat-1',
        senderPubkey: 'peer-pub',
        recipientPubkey: 'me',
        createdAt: 12,
        relayHints: ['wss://relay.test'],
      },
    ]).profile

    const conversations = buildConversations(withInbox)
    expect(conversations).toHaveLength(1)
    expect(conversations[0]?.source).toBe('liked-you')
    expect(conversations[0]?.messages[0]?.body).toBe('hello')
  })
})
