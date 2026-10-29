import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileApns, selectApn, matchingApns, type ApnEntry } from '../shared/apn.ts'
import { compileProviderDatabase } from '../shared/apn-database.ts'
import { bundledApnDatabase } from '../data/apn-database.ts'
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

test('bundled provider database retains home MNC zeroes, multiple APNs and protocol variants', () => {
  assert.equal(bundledApnDatabase.count, bundledApnDatabase.entries.length)
  const hk = matchingApns(bundledApnDatabase.entries, { imsi: '454031234567890', mncLength: 2 })
  assert.ok(hk.some(row => row.mnc === '03' && row.apn === 'mobile.three.com.hk'))
  assert.ok(hk.some(row => row.apn === 'mobile.lte.three.com.hk'))
  assert.ok(hk.some(row => row.apn === 'mobile.three.com.hk' && row.protocol === 'IPV4V6'))
  assert.throws(() => compileProviderDatabase('<html>download failed</html>'), /format/)
  assert.throws(() => compileProviderDatabase('# database-format: 2\n# database-version: 2026.10.23\n'), /entry count/)
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

test('provider candidates retain multiple APNs and require every subscriber discriminator',()=>{
  const entries:ApnEntry[]=[
    {carrier:'home one',mcc:'454',mnc:'03',apn:'mobile.three.com.hk',priority:200},
    {carrier:'home two',mcc:'454',mnc:'03',apn:'mobile.lte.three.com.hk',priority:201},
    {carrier:'another SIM',mcc:'454',mnc:'03',apn:'other',iccid_pattern:'898600'},
    {carrier:'travel',mcc:'*',mnc:'',apn:'travel',iccid_pattern:'8985203',imsi_pattern:'45403xx',gid1:'01',spn:'3'},
  ]
  const sim={imsi:'454031234567890',iccid:'8985203000000000001',mncLength:2,gid:'01FF',spn:'3'}
  assert.deepEqual(matchingApns(entries,sim).map(row=>row.apn),['travel','mobile.three.com.hk','mobile.lte.three.com.hk'])
  assert.deepEqual(matchingApns(entries,{...sim,spn:'other'}).map(row=>row.apn),['mobile.three.com.hk','mobile.lte.three.com.hk'])
  assert.equal(selectApn(entries,{...sim,spn:'other'},'mobile.lte.three.com.hk')?.apn,'mobile.lte.three.com.hk')
  assert.equal(selectApn(entries,sim,'mobile.lte.three.com.hk')?.apn,'travel')
})

test('SMS archive joins complete multipart messages while isolating SIMs and incomplete parts', () => {
  const row = { id: 1, phone_number: '+85212345678', direction: 'incoming', content: '你', timestamp: '2026-10-26T00:00:00Z', status: 'received', reference: 20, part: 1, total: 2, sim: 'a' }
  const records = joinSmsSegments([row, { ...row, id: 2, content: '好', part: 2 }, { ...row, id: 3, sim: 'b' }])
  assert.equal(records.length, 2)
  assert.ok(records.some(row => row.content === '你好'))
  assert.ok(records.some(row => row.content === '[1/2] 你'))
  const mixed = joinSmsSegments([{...row,status:'read'}, {...row,id:2,content:'好',part:2}])
  assert.equal(mixed[0].status,'received')
  assert.deepEqual(mixed[0].archive_ids,[1,2])
  assert.equal(joinSmsSegments([{...row,status:'read'}, {...row,id:2,content:'好',part:2,status:'read'}])[0].status,'read')
  assert.equal(joinSmsSegments([{...row,memory:'ME',sim:'unknown'}, {...row,id:2,content:'好',part:2,memory:'ME',sim:'new-sim'}])[0].content,'你好')
})
