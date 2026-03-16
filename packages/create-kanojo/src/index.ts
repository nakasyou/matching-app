#!/usr/bin/env bun

import { createMatchingCli } from '@repo/shared'

await createMatchingCli({
  brand: 'create-kanojo',
  role: 'male',
  target: 'female',
}).run()
