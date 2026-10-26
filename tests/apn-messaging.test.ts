import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileApns, selectApn, type ApnEntry } from '../shared/apn.ts'
import { joinSmsSegments } from '../shared/sms-history.ts'
import { snapshotRoutes } from '../shared/status-snapshot.ts'
import { r13Snapshot } from './fixtures/rm500q-r13.ts'

test('Android APN import excludes IMS/MMS-only and proxy-only entries, retains MVNO rules', async () => {
  const entries = compileApns(await readFile('data/apns-conf_8.xml', 'utf8'))
  assert.ok(entries.length > 500)
  assert.ok(entries.some(row => row.mvno_type === 'imsi'))
  const csl = selectApn(entries, { imsi: '454001234567890', mncLength: 2 })!
  assert.equal(csl.apn, 'internet')
  assert.equal(csl.mnc, '00')
  assert.ok(!entries.some(row => row.apn === 'ims'))
})

test('home IMSI/EF_AD and MVNO matches select APN without using roaming PLMN', () => {
  const entries: ApnEntry[] = [
    { carrier: 'home', mcc: '454', mnc: '00', apn: 'home' },
    { carrier: 'three digit', mcc: '454', mnc: '001', apn: 'three' },
    { carrier: 'MVNO', mcc: '454', mnc: '00', apn: 'mvno', mvno_type: 'imsi', mvno_match_data: '4540012xx' },
    { carrier: 'visited', mcc: '460', mnc: '00', apn: 'cmnet' },
  ]
  assert.equal(selectApn(entries, { imsi: '454001234567890' }), undefined)
  assert.equal(selectApn(entries, { imsi: '454001234567890', mncLength: 2 })?.apn, 'mvno')
  assert.equal(selectApn(entries, { imsi: '454001234567890', mncLength: 3 })?.apn, 'three')
  assert.equal(selectApn(entries, { imsi: '454009999567890', mncLength: 2 })?.apn, 'home')
  assert.equal(selectApn(entries, { imsi: '999991234567890', mncLength: 2 }), undefined)
})

test('half-second speed samples use actual elapsed time and handle counter reset', () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.host.speed_time = 100.5; snapshot.host.speed_previous_time = 100
  snapshot.host.previous_counters = [{ interface: 'wwan0', rx: 1000, tx: 1000 }]
  snapshot.host.counters = [{ interface: 'wwan0', rx: 2000, tx: 500 }]
  const stats = snapshotRoutes(snapshot)['/api/stats'].data as { network_speed: { interval_seconds: number; interfaces: { rx_bytes_per_sec: number; tx_bytes_per_sec: number }[] } }
  assert.equal(stats.network_speed.interval_seconds, 0.5)
  assert.equal(stats.network_speed.interfaces[0].rx_bytes_per_sec, 2000)
  assert.equal(stats.network_speed.interfaces[0].tx_bytes_per_sec, 0)
})

test('SMS archive joins complete multipart messages while isolating SIMs and incomplete parts', () => {
  const row = { id: 1, phone_number: '+85212345678', direction: 'incoming', content: '你', timestamp: '2026-10-26T00:00:00Z', status: 'received', reference: 20, part: 1, total: 2, sim: 'a' }
  const records = joinSmsSegments([row, { ...row, id: 2, content: '好', part: 2 }, { ...row, id: 3, sim: 'b' }])
  assert.equal(records.length, 2)
  assert.ok(records.some(row => row.content === '你好'))
  assert.ok(records.some(row => row.content === '[1/2] 你'))
})
