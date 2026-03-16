# create-kanojo

男性ユーザー向けの CLI 入口です。実装本体は `@repo/shared` にあり、この package は以下の preset で起動します。

- `brand: create-kanojo`
- `role: male`
- `target: female`

```bash
bun packages/create-kanojo/src/index.ts
```

公開用 bundle は `bun run --filter create-kanojo build` で `dist/index.mjs` に出力されます。
