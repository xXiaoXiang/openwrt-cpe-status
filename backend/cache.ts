import type { Reading } from '../shared/adapter.ts'

interface Entry { reading?: Reading; pending?: Promise<Reading>; retryAt: number; revision: number }

// Demand-driven: no browser means no recurring AT reads. Expired successes are
// served during one background refresh; failed refreshes never become fresh data.
export class ReadCache {
  private entries = new Map<string, Entry>()
  constructor(private clock = Date.now) {}
  invalidate(keys?: string[]) {
    for (const [key, entry] of this.entries) if (!keys || keys.includes(key)) {
      entry.revision++
      entry.reading = undefined
      entry.retryAt = 0
    }
  }
  async get(key: string, ttl: number, staleMs: number, load: () => Promise<Reading>): Promise<Reading> {
    let entry = this.entries.get(key)
    if (!entry) { entry = { retryAt: 0, revision: 0 }; this.entries.set(key, entry) }
    const previous = entry.reading
    const age = previous ? this.clock() - previous.sampledAt : Infinity
    if (previous && age < ttl) return { ...previous, stale: false }
    const usable = previous && age < ttl + staleMs
    if (!entry.pending && this.clock() >= entry.retryAt) {
      const revision = entry.revision
      const current = entry
      current.pending = load().then(reading => {
        if (current.revision !== revision) throw new Error('State changed during read')
        current.reading = reading
        return reading
      }).catch(error => { current.retryAt = this.clock() + 6000; throw error }).finally(() => { current.pending = undefined })
      // Stale responses return immediately. Always observe the refresh failure.
      void current.pending.catch(() => {})
    }
    if (usable) return { ...previous, stale: true, warning: '正在更新；保留上次成功结果' }
    if (entry.pending) return entry.pending
    throw new Error('ModemReadDeferred: query cooling down after failure')
  }
}
