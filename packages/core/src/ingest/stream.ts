/**
 * SSE-based sync accelerator (#26).
 *
 * ADR 0005: "A durable polling loop owns the cursor. SSE, when enabled, only
 * nudges that loop awake — it is an accelerator and never the correctness path."
 *
 * `StreamWatcher` opens one SSE connection to Horizon's `/ledgers?cursor=now`
 * feed and watches for any new ledger event. When one arrives it wakes every
 * account in the watch list by calling `onWake`. The timed polling loop keeps
 * running regardless — the stream only shortens the wait.
 *
 * Design choices:
 * - One `/ledgers` stream covers all accounts cheaply, regardless of how many
 *   accounts are watched (scales to hundreds without opening per-account
 *   streams).
 * - Bursts are coalesced: many events within `coalesceMs` fire one wake, not
 *   one per event.
 * - On error or stall, the watcher reconnects after `reconnectMs` (honouring
 *   SSE `retry:` fields). A dropped stream loses nothing: the timed rounds
 *   keep running.
 * - No cursor or movement data comes from the stream. It is a hint only.
 */

export interface StreamWatcherOptions {
  /** Base Horizon URL, e.g. `https://horizon-testnet.stellar.org`. */
  readonly horizonUrl: string
  /**
   * Called when the watcher sees new ledger activity. May be called from any
   * microtask; callers must not hold locks when acting on it.
   */
  readonly onWake: () => void
  /**
   * Platform fetch. Defaults to `globalThis.fetch`.
   * Tests inject a fake that returns a ReadableStream of SSE lines.
   */
  readonly fetch?: typeof globalThis.fetch
  /**
   * Milliseconds to wait after a connection failure before reconnecting.
   * Default 5 000. Overridden by SSE `retry:` fields.
   */
  readonly reconnectMs?: number
  /**
   * Window in which multiple SSE events are collapsed into one wake.
   * Default 500.
   */
  readonly coalesceMs?: number
  /**
   * Injected for deterministic tests. Default `setTimeout`.
   */
  readonly setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout?: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * A live SSE watcher. Call `start()` to begin; call `stop()` to close the
 * connection and free resources.
 */
export class StreamWatcher {
  private readonly horizonUrl: string
  private readonly onWake: () => void
  private readonly fetchImpl: typeof globalThis.fetch
  private reconnectMs: number
  private readonly coalesceMs: number
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutImpl: (id: ReturnType<typeof setTimeout>) => void

  private abortController: AbortController | null = null
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: StreamWatcherOptions) {
    this.horizonUrl = options.horizonUrl.replace(/\/+$/, '')
    this.onWake = options.onWake
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.reconnectMs = options.reconnectMs ?? 5_000
    this.coalesceMs = options.coalesceMs ?? 500
    this.setTimeoutImpl = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutImpl = options.clearTimeout ?? ((id) => clearTimeout(id))
  }

  /** Begin watching. Returns immediately; the stream runs in the background. */
  start(): void {
    this.stopped = false
    void this.loop()
  }

  /** Close the stream and stop reconnecting. */
  stop(): void {
    this.stopped = true
    this.abortController?.abort()
    if (this.coalesceTimer !== null) {
      this.clearTimeoutImpl(this.coalesceTimer)
      this.coalesceTimer = null
    }
  }

  private scheduleWake(): void {
    if (this.coalesceTimer !== null) return // already scheduled — burst coalescence
    this.coalesceTimer = this.setTimeoutImpl(() => {
      this.coalesceTimer = null
      this.onWake()
    }, this.coalesceMs)
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connect()
      } catch {
        // Connection failed or was dropped. Wait before reconnecting.
      }
      if (!this.stopped) {
        await new Promise<void>((resolve) => {
          this.setTimeoutImpl(resolve, this.reconnectMs)
        })
      }
    }
  }

  private async connect(): Promise<void> {
    this.abortController = new AbortController()
    const url = `${this.horizonUrl}/ledgers?cursor=now`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'text/event-stream' },
        signal: this.abortController.signal,
      })
    } catch {
      // Transport error or abort.
      return
    }
    if (!response.ok || response.body === null) return

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          break
        }
        if (chunk.done) break

        buf += decoder.decode(chunk.value, { stream: true })
        // SSE lines are separated by \n; dispatch complete lines.
        const lines = buf.split('\n')
        buf = lines.pop()! // keep the incomplete trailing fragment
        for (const line of lines) {
          this.handleLine(line.trimEnd())
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith('retry:')) {
      const ms = parseInt(line.slice('retry:'.length).trim(), 10)
      if (!Number.isNaN(ms) && ms > 0) this.reconnectMs = ms
      return
    }
    if (line.startsWith('data:')) {
      const data = line.slice('data:'.length).trim()
      // Horizon sends `data: "hello"` as the open event; ignore that.
      // Any other data record means a new ledger closed.
      if (data !== '"hello"' && data !== '') {
        this.scheduleWake()
      }
    }
  }
}
