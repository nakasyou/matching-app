# create-kareshi

女性ユーザー向けの CLI 入口です。実装本体は `@repo/shared` にあり、この package は以下の preset で起動します。

- `brand: create-kareshi`
- `role: female`
- `target: male`

```bash
bun packages/create-kareshi/src/index.ts
```

公開用 bundle は `bun run --filter create-kareshi build` で `dist/index.mjs` に出力されます。
