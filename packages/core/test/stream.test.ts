/**
 * Tests for the SSE stream watcher (#26).
 *
 * No real network, no real timers. All tests use injected fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamWatcher } from '../src/ingest/stream.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE response whose body is a ReadableStream fed line by line. */
function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** A fake fetch that serves a fixed sequence of responses in order. */
function makeFetch(...responses: Response[]): typeof globalThis.fetch {
  const queue = [...responses]
  return (async () => queue.shift() ?? sseResponse([], 503)) as typeof globalThis.fetch
}

/** Collect timer callbacks so tests can fire them manually. */
function makeTimers() {
  const timers: { fn: () => void; ms: number; id: number }[] = []
  let nextId = 1
  const setT = (fn: () => void, ms: number) => {
    const id = nextId++
    timers.push({ fn, ms, id })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const clearT = (id: ReturnType<typeof setTimeout>) => {
    const idx = timers.findIndex((t) => t.id === (id as unknown as number))
    if (idx >= 0) timers.splice(idx, 1)
  }
  const flush = () => {
    const pending = [...timers]
    timers.length = 0
    for (const t of pending) t.fn()
  }
  return { setT, clearT, flush, timers }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamWatcher', () => {
  let wakes: number[]
  let timers: ReturnType<typeof makeTimers>

  beforeEach(() => {
    wakes = []
    timers = makeTimers()
  })

  afterEach(() => {
    // Nothing to clean up — all resources are mocked.
  })

  it('fires onWake when a data event arrives', async () => {
    const fetch = makeFetch(
      sseResponse([
        'retry: 1000',
        'event: open',
        'data: "hello"',
        '',
        'data: {"id":"65546501","paging_token":"65546501"}',
        '',
      ]),
      // Second response is an empty stream so the loop idles after the first.
      sseResponse([], 200),
    )

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => wakes.push(Date.now()),
      fetch,
      reconnectMs: 1,
      coalesceMs: 0,
      setTimeout: timers.setT,
      clearTimeout: timers.clearT,
    })

    watcher.start()
    // Let microtasks run so the first connect() completes.
    await new Promise<void>((r) => setTimeout(r, 20))
    // Fire any coalesce / reconnect timers.
    timers.flush()
    await new Promise<void>((r) => setTimeout(r, 10))

    watcher.stop()
    // At least one wake fired for the data event.
    expect(wakes.length).toBeGreaterThanOrEqual(1)
  })

  it('coalesces a burst of events into one wake', async () => {
    // Three data lines in quick succession.
    const fetch = makeFetch(
      sseResponse([
        'data: {"id":"1"}',
        '',
        'data: {"id":"2"}',
        '',
        'data: {"id":"3"}',
        '',
      ]),
      sseResponse([], 200),
    )

    let coalesceResolved = false
    const coalesceTimers: Array<() => void> = []
    const setT = (fn: () => void, _ms: number) => {
      coalesceTimers.push(fn)
      return coalesceTimers.length as unknown as ReturnType<typeof setTimeout>
    }
    const clearT = (_id: ReturnType<typeof setTimeout>) => { /* noop */ }

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => { wakes.push(1); coalesceResolved = true },
      fetch,
      reconnectMs: 1,
      coalesceMs: 500,
      setTimeout: setT,
      clearTimeout: clearT,
    })

    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    // Fire coalesce timers.
    for (const fn of coalesceTimers) fn()
    await new Promise<void>((r) => setTimeout(r, 10))
    watcher.stop()

    // Only one wake despite three data events (burst coalesced).
    expect(wakes.length).toBe(1)
    expect(coalesceResolved).toBe(true)
  })

  it('does not fire onWake for the SSE open "hello" event', async () => {
    const fetch = makeFetch(
      sseResponse(['event: open', 'data: "hello"', '']),
      sseResponse([], 200),
    )

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => wakes.push(1),
      fetch,
      reconnectMs: 1,
      coalesceMs: 0,
      setTimeout: timers.setT,
      clearTimeout: timers.clearT,
    })

    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    timers.flush()
    await new Promise<void>((r) => setTimeout(r, 10))
    watcher.stop()

    expect(wakes.length).toBe(0)
  })

  it('reconnects after a dropped stream and still delivers subsequent events', async () => {
    // First response: immediate close (stream dropped mid-way).
    // Second response: contains a real data event.
    const fetch = makeFetch(
      sseResponse([]),                                                   // dropped
      sseResponse(['data: {"id":"65546502"}', '']),                      // real event
      sseResponse([], 200),                                              // idle
    )

    const fireTimers: Array<() => void> = []
    const setT = (fn: () => void, _ms: number) => {
      fireTimers.push(fn)
      return fireTimers.length as unknown as ReturnType<typeof setTimeout>
    }
    const clearT = () => { /* noop */ }

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => wakes.push(1),
      fetch,
      reconnectMs: 1,
      coalesceMs: 0,
      setTimeout: setT,
      clearTimeout: clearT,
    })

    watcher.start()
    // Let first (dropped) connection settle.
    await new Promise<void>((r) => setTimeout(r, 20))
    // Fire the reconnect delay timer.
    for (const fn of [...fireTimers]) fn()
    await new Promise<void>((r) => setTimeout(r, 30))
    // Fire any coalesce timers.
    for (const fn of [...fireTimers]) fn()
    await new Promise<void>((r) => setTimeout(r, 10))

    watcher.stop()
    // Event from the second connection was delivered.
    expect(wakes.length).toBeGreaterThanOrEqual(1)
  })

  it('honours the SSE retry: field for reconnect delay', async () => {
    const fetch = makeFetch(
      sseResponse(['retry: 9999', '']),
      sseResponse([], 200),
    )

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => wakes.push(1),
      fetch,
      reconnectMs: 1_000,
      coalesceMs: 0,
      setTimeout: timers.setT,
      clearTimeout: timers.clearT,
    })

    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 30))
    watcher.stop()

    // The reconnect timer should have been set with >=9999 ms (from retry: field).
    const reconnectTimer = timers.timers.find((t) => t.ms >= 9_999)
    expect(reconnectTimer).toBeDefined()
  })

  it('stop() cancels the coalesce timer so onWake is not called after stop', async () => {
    const fetch = makeFetch(sseResponse(['data: {"id":"1"}', '']))

    const fireTimers: Array<{ fn: () => void; id: number }> = []
    let nextId = 1
    const setT = (fn: () => void, _ms: number) => {
      const id = nextId++
      fireTimers.push({ fn, id })
      return id as unknown as ReturnType<typeof setTimeout>
    }
    const clearT = (id: ReturnType<typeof setTimeout>) => {
      const idx = fireTimers.findIndex((t) => t.id === (id as unknown as number))
      if (idx >= 0) fireTimers.splice(idx, 1)
    }

    const watcher = new StreamWatcher({
      horizonUrl: 'https://horizon.test',
      onWake: () => wakes.push(1),
      fetch,
      reconnectMs: 1,
      coalesceMs: 500,
      setTimeout: setT,
      clearTimeout: clearT,
    })

    watcher.start()
    await new Promise<void>((r) => setTimeout(r, 20))
    // stop() before the coalesce timer fires.
    watcher.stop()
    // Fire whatever timers remain — none should trigger onWake.
    for (const { fn } of [...fireTimers]) fn()

    expect(wakes.length).toBe(0)
  })
})
