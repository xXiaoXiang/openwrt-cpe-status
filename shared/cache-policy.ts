// Demand-triggered caches. Keeping stale successes is independent of this TTL.
export const cacheSeconds = {
  host: 1, system: 86400, status: 2, cells: 5, temperature: 4, identity: 86400, sim: 86400,
  radio: 86400, roaming: 86400, mode: 86400, bands: 86400, bandCapabilities: 86400, cellLocks: 86400, failure: 6,
} as const
