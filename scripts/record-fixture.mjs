#!/usr/bin/env node
/**
 * Usage: node scripts/record-fixture.mjs <operation-id> --scenario <name> [--testnet]
 *
 * Capture one Horizon operation (`?join=transactions`) and every page of its
 * effects into fixtures/horizon/<pubnet|testnet>/<name>.json, in the format
 * described in fixtures/horizon/README.md: `_links` removed, nothing else
 * changed. An existing file is never overwritten.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const SCENARIO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Remove Horizon's HAL links, preserving every other field and its order. */
export function stripLinks(value) {
  if (Array.isArray(value)) return value.map(stripLinks)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (key !== '_links') out[key] = stripLinks(item)
    }
    return out
  }
  return value
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`)
  return response.json()
}

/**
 * Record one operation and return the path written. Inject `fetchImpl`,
 * `outDir` and `now` to exercise this offline.
 */
export async function recordFixture({
  id,
  scenario,
  testnet = false,
  fetchImpl = globalThis.fetch,
  outDir,
  now = () => new Date(),
}) {
  if (!/^\d+$/.test(String(id))) throw new Error(`operation id must be digits, not ${JSON.stringify(id)}`)
  if (!SCENARIO.test(scenario)) {
    throw new Error(`scenario must be kebab-case, not ${JSON.stringify(scenario)}`)
  }

  const network = testnet ? 'testnet' : 'public'
  const horizon = testnet ? 'https://horizon-testnet.stellar.org' : 'https://horizon.stellar.org'
  const output = outDir ?? join(root, 'fixtures/horizon', testnet ? 'testnet' : 'pubnet')
  const operationUrl = `${horizon}/operations/${id}?join=transactions`
  const effectsUrl = `${horizon}/operations/${id}/effects`

  const operation = stripLinks(await getJson(fetchImpl, operationUrl))
  if (String(operation.id) !== String(id)) {
    throw new Error(`Horizon returned operation ${operation.id} for ${id}`)
  }

  const effects = []
  const effectSources = [effectsUrl]
  let cursor = null
  for (let page = 0; page < 1_000; page++) {
    const params = new URLSearchParams({ order: 'asc', limit: '200' })
    if (cursor !== null) params.set('cursor', cursor)
    const pageUrl = `${effectsUrl}?${params}`
    if (cursor !== null) effectSources.push(pageUrl)
    const body = await getJson(fetchImpl, pageUrl)
    const records = body?._embedded?.records
    if (!Array.isArray(records)) throw new Error(`Expected an effects collection from ${effectsUrl}`)
    effects.push(...records.map(stripLinks))
    if (records.length < 200) break
    const last = records[records.length - 1]
    if (last?.paging_token === undefined || last.paging_token === cursor) break
    cursor = last.paging_token
  }

  const fixture = {
    scenario,
    network,
    horizon,
    capturedAt: `${now().toISOString().slice(0, 19)}+00:00`,
    sources: [operationUrl, ...effectSources],
    operation,
    effects,
  }

  const file = join(output, `${scenario}.json`)
  if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite it.`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`)
  return file
}

async function main() {
  const argv = process.argv.slice(2)
  const id = argv.find((a) => !a.startsWith('--'))
  const at = argv.indexOf('--scenario')
  const scenario = at === -1 ? undefined : argv[at + 1]
  if (id === undefined || scenario === undefined || scenario.startsWith('--')) {
    throw new Error('Usage: node scripts/record-fixture.mjs <operation-id> --scenario <name> [--testnet]')
  }
  const file = await recordFixture({ id, scenario, testnet: argv.includes('--testnet') })
  process.stdout.write(`Wrote ${relative(root, file)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`nostro: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  })
}
