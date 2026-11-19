export interface RecordFixtureOptions {
  readonly id: string | number
  readonly scenario: string
  readonly testnet?: boolean
  readonly fetchImpl?: (input: unknown, init?: unknown) => Promise<Response>
  readonly outDir?: string
  readonly now?: () => Date
}

export function stripLinks<T>(value: T): T
export function recordFixture(options: RecordFixtureOptions): Promise<string>
