#!/usr/bin/env bun

import { createMatchingCli } from '@repo/shared'

await createMatchingCli({
  brand: 'create-kareshi',
  role: 'female',
  target: 'male',
}).run()
