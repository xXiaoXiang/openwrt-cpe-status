import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProfileCache, type ProfileReply } from '../frontend/src/api/profileCache.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import type { StatusSnapshot } from '../shared/status-snapshot.ts'

const reply = (key: string): ProfileReply => ({ status: 'ok', profile_key: key, data: rm500qProfile })
const snapshot = (key: string) => ({ profile_key: key, raw: {}, sampled: {} }) as StatusSnapshot

test('initial concurrent reads and repeated snapshots share one profile fetch', async () => {
  const cache = createProfileCache()
  let requests = 0
  const load = async () => { requests++; return reply('a') }
  const [profile, value] = await Promise.all([cache.get(load), cache.hydrate(snapshot('a'), load)])
  assert.equal(profile.data, rm500qProfile)
  assert.equal(value.adapter, rm500qProfile)
  await cache.hydrate(snapshot('a'), load)
  assert.equal(requests, 1)
})

test('a changed fingerprint reloads once and notifies capability consumers', async () => {
  const cache = createProfileCache()
  await cache.get(async () => reply('a'))
  let requests = 0, changes = 0
  const unsubscribe = cache.subscribe(() => { changes++ })
  const changed = { ...rm500qProfile, id: 'changed-profile' }
  const load = async () => { requests++; return { ...reply('b'), data: changed } }
  const results = await Promise.all([cache.hydrate(snapshot('b'), load), cache.hydrate(snapshot('b'), load)])
  assert.ok(results.every(value => value.adapter === changed))
  assert.equal(requests, 1)
  assert.equal(changes, 1)
  unsubscribe()
})

test('mismatched snapshots are deferred rather than parsed with different rules', async () => {
  const cache = createProfileCache()
  await assert.rejects(cache.hydrate(snapshot('a'), async () => reply('b')), /ModemReadDeferred/)
  const value = await cache.hydrate(snapshot('b'), async () => { throw new Error('must reuse b') })
  assert.equal(value.adapter, rm500qProfile)
})

test('failed/invalid profile reads can retry; legacy and error snapshots remain usable', async () => {
  const cache = createProfileCache()
  await assert.rejects(cache.get(async () => { throw new Error('offline') }), /offline/)
  await assert.rejects(cache.get(async () => ({ status: 'ok' })), /无效/)
  assert.equal((await cache.get(async () => reply('a'))).data, rm500qProfile)
  const legacy = { ...snapshot('legacy'), adapter: rm500qProfile }
  const deferred = { error: 'ModemReadDeferred' } as StatusSnapshot
  const neverLoad = async (): Promise<ProfileReply> => { throw new Error('must not load') }
  assert.equal(await cache.hydrate(legacy, neverLoad), legacy)
  assert.equal(await cache.hydrate(deferred, neverLoad), deferred)
})
