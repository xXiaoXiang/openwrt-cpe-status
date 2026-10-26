import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { ReadCache } from '../backend/cache.ts'
import { Engine } from '../backend/engine.ts'
import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { DemoTransport, DemoHost } from '../backend/demo.ts'
import { ModemService } from '../backend/service.ts'
import { exampleConfig } from '../backend/config.ts'
import type { Reading } from '../shared/adapter.ts'

test('cache coalesces simultaneous reads, has no idle polling, refreshes stale successes once', async () => {
  let time = 0, calls = 0
  const cache = new ReadCache(() => time)
  const loader = async (): Promise<Reading> => { calls++; await tick(); return { values: [{ sequence: calls }], sampledAt: time, stale: false } }
  await Promise.all(Array.from({ length: 15 }, () => cache.get('a', 100, 400, loader)))
  assert.equal(calls, 1)
  time = 101
  await tick()
  assert.equal(calls, 1, 'expiration alone must not query the modem')
  const stale = await cache.get('a', 100, 400, loader)
  assert.equal(stale.stale, true)
  assert.equal(stale.values[0].sequence, 1)
  await tick(); await tick()
  assert.equal(calls, 2)
  assert.equal((await cache.get('a', 100, 400, loader)).stale, false)
})

test('failed refresh retains bounded stale result with 6s failure backoff', async () => {
  let time = 0, failures = 0
  const cache = new ReadCache(() => time)
  await cache.get('a', 100, 400, async () => ({ values: [{ good: true }], sampledAt: time, stale: false }))
  time = 101
  const fail = async (): Promise<Reading> => { failures++; throw new Error('busy') }
  assert.equal((await cache.get('a', 100, 400, fail)).stale, true)
  await tick()
  assert.equal((await cache.get('a', 100, 400, fail)).values[0].good, true)
  assert.equal(failures, 1)
  time = 501
  await assert.rejects(cache.get('a', 100, 400, fail), /cooling down/)
  time = 6102
  await assert.rejects(cache.get('a', 100, 400, fail), /busy/)
  assert.equal(failures, 2)
})

test('invalidation prevents an earlier read from repopulating changed state', async () => {
  const cache = new ReadCache()
  let complete!: (value: Reading) => void
  const old = cache.get('a', 1000, 0, () => new Promise(resolve => { complete = resolve }))
  cache.invalidate(['a'])
  complete({ values: [], sampledAt: Date.now(), stale: false })
  await assert.rejects(old, /State changed/)
})

test('network, location and dashboard cells share QENG reads and serial queue', async () => {
  const transport = new DemoTransport()
  let active = 0, maxActive = 0
  const original = transport.exchange.bind(transport)
  transport.exchange = async (...args) => {
    active++; maxActive = Math.max(active, maxActive)
    try { await tick(); return await original(...args) } finally { active-- }
  }
  const service = new ModemService(new Engine(rm500q, transport, true), new DemoHost('wwan'), exampleConfig, true)
  await Promise.all(['/api/network', '/api/cells', '/api/location/cell-info', '/api/roaming', '/api/cells'].map(route => service.dispatch('GET', route)))
  assert.equal(maxActive, 1)
  assert.equal(transport.commands.filter(command => command === 'AT+QENG="servingcell"').length, 1)
  assert.equal(transport.commands.filter(command => command === 'AT+QENG="neighbourcell"').length, 1)
  const apn = await service.dispatch('GET', '/api/apn') as { data: { contexts: { active: boolean }[] } }
  assert.equal(apn.data.contexts[0].active, true)
})

test('controls confirm modem readback; failed readback cannot become success', async () => {
  const transport = new DemoTransport()
  const service = new ModemService(new Engine(rm500q, transport, true), new DemoHost('wwan'), exampleConfig, true)
  const result = await service.dispatch('POST', '/api/airplane-mode', { enabled: true }) as { data: { enabled: boolean } }
  assert.equal(result.data.enabled, true)
  assert.deepEqual(transport.commands.slice(-2), ['AT+CFUN=4', 'AT+CFUN?'])
  await service.dispatch('POST', '/api/radio-mode', { mode: 'lte' })
  const original = transport.exchange.bind(transport)
  transport.exchange = async (command, ...args) => command.startsWith('AT+QNWPREFCFG="mode_pref",') ? '\r\nOK\r\n' : original(command, ...args)
  await assert.rejects(service.dispatch('POST', '/api/radio-mode', { mode: 'nr' }), /not confirmed/)
  await service.dispatch('POST', '/api/roaming', { allowed: false })
  assert.equal(transport.roamPreference, 1)
  assert.ok(transport.commands.includes('AT+QNWPREFCFG="roam_pref",1'))
  const unchanged = transport.exchange.bind(transport)
  transport.exchange = async (command, ...args) => command.startsWith('AT+QNWPREFCFG="roam_pref",') ? '\r\nOK\r\n' : unchanged(command, ...args)
  await assert.rejects(service.dispatch('POST', '/api/roaming', { allowed: true }), /not confirmed/)
  await assert.rejects(service.dispatch('GET', '/api/qos'), /Unsupported/)
})

test('read-only configuration cannot send hardware writes', async () => {
  const transport = new DemoTransport(), engine = new Engine(rm500q, transport, false)
  await assert.rejects(engine.write('airplaneSet', { functionality: '4' }), /disabled/)
  assert.equal(transport.commands.length, 0)
})
