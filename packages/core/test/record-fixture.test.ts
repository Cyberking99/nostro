import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { recordFixture, stripLinks } from '../../../scripts/record-fixture.mjs'

const fixtures = new URL('../../../fixtures/horizon/pubnet/', import.meta.url)
const committed = JSON.parse(readFileSync(fileURLToPath(new URL('payment-text-memo.json', fixtures)), 'utf8')) as {
  operation: Record<string, unknown>
  effects: Record<string, unknown>[]
}
const withLinks = (value: Record<string, unknown>) => ({ ...value, _links: { self: { href: 'https://horizon.test/' } } })

const dir = mkdtempSync(join(tmpdir(), 'nostro-fixture-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('record-fixture', () => {
  it('re-records an existing fixture unchanged apart from Horizon links', async () => {
    const urls: string[] = []
    const fetchImpl = async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('?join=transactions')) return json(withLinks(committed.operation))
      if (url.includes('/effects')) return json({ _embedded: { records: committed.effects.map(withLinks) } })
      throw new Error(`unexpected ${url}`)
    }
    const file = await recordFixture({
      id: String(committed.operation.id),
      scenario: 'payment-text-memo',
      fetchImpl,
      outDir: dir,
      now: () => new Date('2026-11-06T12:00:00Z'),
    })
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(recorded.operation).toEqual(committed.operation)
    expect(recorded.effects).toEqual(committed.effects)
    expect(recorded).toMatchObject({
      scenario: 'payment-text-memo',
      network: 'public',
      horizon: 'https://horizon.stellar.org',
      capturedAt: '2026-11-06T12:00:00+00:00',
      sources: [
        `https://horizon.stellar.org/operations/${committed.operation.id}?join=transactions`,
        `https://horizon.stellar.org/operations/${committed.operation.id}/effects`,
      ],
    })
    expect(urls).toHaveLength(2)
  })

  it('reads every page of effects, then refuses to overwrite the file', async () => {
    const seen: (string | null)[] = []
    const page = (n: number) => ({ paging_token: `${n}`, type: 'account_credited', account: 'GTEST' })
    const fetchImpl = async (input: unknown) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/effects')) {
        seen.push(url.searchParams.get('cursor'))
        const cursor = url.searchParams.get('cursor')
        const records = cursor === null ? Array.from({ length: 200 }, (_, i) => page(i)) : [page(200)]
        return json({ _embedded: { records } })
      }
      return json({ id: '123', _links: {} })
    }
    const args = { id: '123', scenario: 'paged', outDir: dir, fetchImpl }
    const file = await recordFixture(args)
    expect(seen).toEqual([null, '199'])
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as { effects: unknown[]; sources: string[] }
    expect(recorded.effects).toHaveLength(201)
    // Every page fetched is recorded, so a replay can fetch the same URLs.
    expect(recorded.sources).toHaveLength(3)
    expect(recorded.sources[2]).toContain('cursor=199')
    await expect(recordFixture(args)).rejects.toThrow(/already exists/)
  })

  it('uses testnet endpoints when asked', async () => {
    const urls: string[] = []
    const fetchImpl = async (input: unknown) => {
      urls.push(String(input))
      return String(input).includes('?join=transactions')
        ? json({ id: '123' })
        : json({ _embedded: { records: [] } })
    }
    await recordFixture({ id: '123', scenario: 'testnet-one', testnet: true, fetchImpl, outDir: dir })
    expect(urls[0]).toBe('https://horizon-testnet.stellar.org/operations/123?join=transactions')
    expect(urls[1]).toContain('https://horizon-testnet.stellar.org/operations/123/effects')
  })

  it('strips only _links, at every depth', () => {
    expect(stripLinks({ a: [{ _links: 1, b: 2 }], _links: 3, c: 4 })).toEqual({ a: [{ b: 2 }], c: 4 })
  })
})
