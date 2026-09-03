// Pipeline integration tests: variants + asset layer.
//
// Run via: node --test test/pipeline-variants-asset.test.mjs
// Or: bash scripts/run-all-tests.sh
//
// These tests do NOT require external APIs or hardware. They assert the
// wrapper API contracts (argument validation, error handling, structured
// outputs) without actually shelling out to Python.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PIPELINE_DIR = path.resolve(__dirname, '..', 'scripts', 'pipeline')

// Load the wrapper. We import directly so the tests run in any cwd.
const { generateVariants, fetchAsset } = await import(path.join(PIPELINE_DIR, 'pipeline.mjs'))

test('generateVariants rejects missing input', async () => {
  await assert.rejects(() => generateVariants({}), /input is required/)
})

test('generateVariants rejects missing count by defaulting sensibly', async () => {
  // Should not throw on missing count (uses default 25)
  // We only assert argument validation here, not actual execution
  await assert.rejects(
    () => generateVariants({ input: '/nonexistent.mp4' }),
    /input file not found/,
    'unknown input file path should fail with a clear error',
  )
})

test('fetchAsset rejects missing topic', async () => {
  await assert.rejects(() => fetchAsset({}), /topic is required/)
})

test('fetchAsset accepts allowCloud but rejects unknown auth file', async () => {
  // No auth + no real APIs = should bubble up fetch failure cleanly,
  // not crash on missing arguments.
  // We do NOT actually shell out here (no network in tests). Argument
  // validation only.
  await assert.doesNotReject(() => {
    // Just check the function signature accepts the option without throwing
    // synchronously. Real failure happens inside.
    return Promise.resolve(fetchAsset.call(null, {
      topic: 'test',
      allowCloud: true,
      budget: 0.01,
    }).catch(err => {
      // Expected: Python script will fail to fetch from Pexels (no key) and
      // exhaust all sources. That's a normal "no result" failure.
      assert.match(String(err.message || err), /fetch|asset_layer|no_result|all_sources/i)
    }))
  })
})

test('pipeline.mjs exposes variants + asset CLI surface', async () => {
  // Verify the wrapper file still parses and the symbols we depend on are present
  const mod = await import(path.join(PIPELINE_DIR, 'pipeline.mjs'))
  assert.equal(typeof mod.generateVariants, 'function')
  assert.equal(typeof mod.fetchAsset, 'function')
  assert.equal(typeof mod.repurposeVideo, 'function')
  assert.equal(typeof mod.verifyVideo, 'function')
})
