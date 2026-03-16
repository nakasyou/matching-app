# matching-app

Nostr ベースの CLI マッチングアプリです。共通処理は `packages/shared` に集約し、`create-kanojo` は男性向け、`create-kareshi` は女性向けの薄い wrapper として動きます。

## Setup

```bash
bun install
```

## Build

```bash
bun run build
```

## Test

```bash
bun test
```

## Run

```bash
bun packages/create-kanojo/src/index.ts
bun packages/create-kareshi/src/index.ts
```

初回起動で `~/.config/create-matching/{profile}.json` に profile を作成し、kind `0`, `10050`, `31210`, `31211` と NIP-17 DM を使って profile / listing / like / match / chat を扱います。
