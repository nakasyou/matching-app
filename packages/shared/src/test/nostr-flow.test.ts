import { describe, expect, test } from 'bun:test'
import { DEFAULT_RELAYS, createMemoryTransport, createNostrService } from '../nostr'
import { buildConversations, createDefaultProfile } from '../protocol'

describe('nostr service flow', () => {
  test('publishes profiles/listings and completes like -> match -> chat on memory transport', async () => {
    const transport = createMemoryTransport()
    const service = createNostrService({ transport })

    let alice = createDefaultProfile(
      { brand: 'create-kanojo', role: 'male', target: 'female' },
      {
        profileName: 'alice',
        displayName: 'Alice',
        bio: 'coffee',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee', 'movies'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'slow' },
        nostr: service.createGeneratedCredentials(),
        relays: DEFAULT_RELAYS,
      },
    )
    let bob = createDefaultProfile(
      { brand: 'create-kareshi', role: 'female', target: 'male' },
      {
        profileName: 'bob',
        displayName: 'Bob',
        bio: 'music',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['music'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'fun' },
        nostr: service.createGeneratedCredentials(),
        relays: DEFAULT_RELAYS,
      },
    )

    await service.publishProfile(alice)
    await service.publishProfile(bob)
    alice = await service.publishListing(alice, {
      headline: '映画デート',
      summary: '静かなカフェも好きです。',
      desiredTags: ['movie', 'cafe'],
    })
    bob = await service.publishListing(bob, {
      headline: '音楽と散歩',
      summary: 'まずは気軽に話したいです。',
      desiredTags: ['music', 'walk'],
    })

    const aliceDiscoveries = await service.discoverListings(alice)
    const bobDiscoveries = await service.discoverListings(bob)
    expect(aliceDiscoveries).toHaveLength(1)
    expect(bobDiscoveries).toHaveLength(1)

    alice = await service.sendLike(alice, {
      fromListing: alice.cache.listings[0]!.address,
      toListing: aliceDiscoveries[0]!.address,
      fromProfileName: alice.profileName,
      recipientPubkey: bob.nostr.pubkey,
      recipientRelays: bob.relays,
    })
    bob = await service.sendLike(bob, {
      fromListing: bob.cache.listings[0]!.address,
      toListing: bobDiscoveries[0]!.address,
      fromProfileName: bob.profileName,
      recipientPubkey: alice.nostr.pubkey,
      recipientRelays: alice.relays,
    })

    alice = await service.syncInbox(alice)
    bob = await service.syncInbox(bob)
    expect(alice.cache.matches).toHaveLength(1)
    expect(bob.cache.matches).toHaveLength(1)

    alice = await service.sendChat(alice, {
      matchId: alice.cache.matches[0]!.matchId,
      recipientPubkey: bob.nostr.pubkey,
      recipientRelays: bob.relays,
      body: 'こんにちは、映画の話をしませんか？',
    })
    bob = await service.syncInbox(bob)

    expect(
      bob.cache.matches[0]?.messages.some((message) => message.body.includes('映画の話')),
    ).toBeTrue()
    expect(alice.cache.matches[0]?.messages).toHaveLength(1)

    service.close()
  })

  test('allows DM replies to someone who liked you before a match exists', async () => {
    const transport = createMemoryTransport()
    const service = createNostrService({ transport })

    let alice = createDefaultProfile(
      { brand: 'create-kanojo', role: 'male', target: 'female' },
      {
        profileName: 'alice',
        displayName: 'Alice',
        bio: 'coffee',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['coffee'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'slow' },
        nostr: service.createGeneratedCredentials(),
        relays: DEFAULT_RELAYS,
      },
    )
    let bob = createDefaultProfile(
      { brand: 'create-kareshi', role: 'female', target: 'male' },
      {
        profileName: 'bob',
        displayName: 'Bob',
        bio: 'music',
        region: 'Tokyo',
        ageRange: '20s',
        interests: ['music'],
        lookingFor: { ageRange: '20s', regions: ['Tokyo'], notes: 'fun' },
        nostr: service.createGeneratedCredentials(),
        relays: DEFAULT_RELAYS,
      },
    )

    await service.publishProfile(alice)
    await service.publishProfile(bob)
    alice = await service.publishListing(alice, {
      headline: 'coffee',
      summary: 'slow coffee',
      desiredTags: ['coffee'],
    })
    bob = await service.publishListing(bob, {
      headline: 'music',
      summary: 'talk first',
      desiredTags: ['music'],
    })

    const bobDiscoveries = await service.discoverListings(bob)
    bob = await service.sendLike(bob, {
      fromListing: bob.cache.listings[0]!.address,
      toListing: bobDiscoveries[0]!.address,
      fromProfileName: bob.profileName,
      recipientPubkey: alice.nostr.pubkey,
      recipientRelays: alice.relays,
    })

    alice = await service.syncInbox(alice)
    const thread = buildConversations(alice)[0]
    expect(thread?.source).toBe('liked-you')

    alice = await service.sendChat(alice, {
      matchId: thread!.threadId,
      recipientPubkey: thread!.peerPubkey,
      recipientRelays: thread!.peerRelays,
      body: 'Thanks for the like.',
    })

    bob = await service.syncInbox(bob)
    const bobThread = buildConversations(bob)[0]
    expect(bobThread?.messages[0]?.body).toBe('Thanks for the like.')
    expect(bob.cache.matches).toHaveLength(0)

    service.close()
  })
})
