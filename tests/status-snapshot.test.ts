import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotRoutes } from '../shared/status-snapshot.ts'
import { r13Snapshot, r13NsaCells } from './fixtures/rm500q-r13.ts'
import { normalizeCells } from '../backend/cells.ts'
import { parseReply } from '../backend/parser.ts'
import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { statusGroups, statusCollector } from '../openwrt/status-collector.ts'
import { roamingPreference } from '../shared/roaming.ts'
import type { CellsResponse, NetworkInfo, SystemStatsResponse } from '../frontend/src/api/types.ts'

test('R13 COPS AcT=13 with LTE-only QENG stays LTE and uses QSPN name', () => {
  const routes = snapshotRoutes(r13Snapshot)
  const network = routes['/api/network'].data as NetworkInfo
  assert.equal(network.technology, 'LTE')
  assert.equal(network.operator_name, 'Lucky2')
  assert.equal(network.mcc, '454')
  assert.equal(network.mnc, '00')
  const cells = routes['/api/cells'].data as CellsResponse
  assert.equal(cells.cells.length, 3, 'duplicate PCC and frequency-only neighbor rows are excluded')
  assert.equal(cells.cells[0].band, 'B7')
  assert.equal(cells.cells[0].bandwidth_mhz, 15, 'QCAINFO 75 resource blocks means 15 MHz')
  assert.equal(cells.cells[0].carrier_role, 'PCC')
  assert.equal(cells.cells[0].pci, 158)
  assert.equal(cells.cells[0].sinr, 200, 'QENG 11 means 2 dB, not QCAINFO final field')
  assert.equal(cells.cells[2].band, 'B3')
  const qengOnly = normalizeCells(parseReply(rm500q.commands.serving, r13Snapshot.raw.cells), [])
  assert.equal(qengOnly.cells[0].bandwidth_mhz, 15, 'QENG enum 4 also means 15 MHz')
})

test('LTE SCC is appended once without inventing NR or losing serving measurements', () => {
  const raw = r13Snapshot.raw.cells + '+QCAINFO: "SCC",1400,100,"LTE BAND 3",1,323,-95,-15,-60,0\n'
  const result = normalizeCells(parseReply(rm500q.commands.serving, raw), parseReply(rm500q.commands.neighbors, raw), parseReply(rm500q.commands.carriers, raw))
  assert.equal(result.technology, 'LTE-A')
  assert.equal(result.cells.length, 3)
  const scc = result.cells.find(row => row.carrier_role === 'SCC1')!
  assert.equal(scc.bandwidth_mhz, 20)
  assert.equal(scc.is_secondary, true)
  assert.equal(scc.rsrp, -9500)
  assert.equal(scc.band, 'B3')
})

test('B7 PCC stays first, then B3 SCC and n78 by band, before neighbors', () => {
  const raw = r13Snapshot.raw.cells.replace('NOCONN', 'CONNECT')
    + '+QENG: "NR5G-NSA",454,00,747,-71,13,-11,627264,78,12,1\n'
    + '+QCAINFO: "SCC",1400,100,"LTE BAND 3",1,323,-95,-15,-60,0\n'
  const result = normalizeCells(parseReply(rm500q.commands.serving, raw), parseReply(rm500q.commands.neighbors, raw), parseReply(rm500q.commands.carriers, raw))
  assert.deepEqual(result.cells.filter(row => row.is_serving).map(row => row.band), ['B7', 'B3', 'n78'])
  assert.ok(result.cells.slice(3).every(row => !row.is_serving))
  assert.equal(result.serving_cell?.cell_id, 0x38C4C03, 'header keeps actual PCC identity')
  assert.equal(result.cells[0].carrier_role, 'PCC')
  assert.equal(result.cells[1].carrier_role, 'SCC1')
  assert.equal(result.cells[2].is_secondary, true)
  assert.equal(result.cells[2].bandwidth_mhz, 100)
})

test('R13 idle NSA preserves reported 50MHz and B7 RSSNR, without replacing PCC SINR', () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.raw.cells = r13NsaCells
  const result = snapshotRoutes(snapshot)['/api/cells'].data as CellsResponse
  assert.deepEqual(result.cells.map(row => row.band), ['B3', 'B7', 'n78'])
  const [pcc, scc, nr] = result.cells
  assert.equal(pcc.sinr, 400, 'QENG raw 12 converts to 4 dB')
  assert.equal(pcc.rssnr, 200, 'QCAINFO RSSNR is a separate physical dB value')
  assert.equal(scc.sinr, undefined, 'do not label RSSNR as QENG SINR in the API')
  assert.equal(scc.rssnr, 800, 'QCAINFO field 9, not trailing extension fields')
  assert.equal(nr.bandwidth_mhz, 50)
  assert.equal(nr.bandwidth_code, 7)
  assert.equal(nr.bandwidth_current, false)
  assert.equal(nr.rrc_state, 'NOCONN')
  assert.equal(nr.sinr, 1400)
  const parse = (raw: string) => normalizeCells(parseReply(rm500q.commands.serving, raw), [], parseReply(rm500q.commands.carriers, raw))
  const fallback = parse(r13NsaCells.replace(',632352,78,7,1', ',632352,78,-,1'))
  assert.equal(fallback.cells[2].bandwidth_mhz, 50, 'matching NR QCAINFO supplements missing QENG width')
  assert.equal(parse(r13NsaCells.replace(',632352,78,7,1', ',632352,78,12,1')).cells[2].bandwidth_mhz, 100, 'valid QENG width takes priority')
  const noNr = parse(r13NsaCells.replace(/^\+QENG: "NR5G-NSA".*\n/m, ''))
  assert.equal(noNr.cells.some(row => row.tech === 'nr'), false, 'QCAINFO alone cannot invent a connected NR cell')
  const noRssnr = parse(r13NsaCells.replace(',-90,8,0,-,-', ',-90,-,0,-,-'))
  assert.equal(noRssnr.cells[1].rssnr, undefined)
})

test('router statistics preserve byte units, interface rates, temperatures and connection addresses', () => {
  const routes = snapshotRoutes(r13Snapshot), stats = routes['/api/stats'].data as SystemStatsResponse
  assert.equal(stats.memory.total_bytes, 204800000)
  assert.equal(stats.memory.used_percent, 50)
  assert.equal(stats.cpu_load.core_count, 2)
  assert.equal(stats.network_speed.interfaces[0].rx_bytes_per_sec, 2000)
  assert.equal(stats.network_speed.interfaces[0].tx_bytes_per_sec, 1000)
  assert.equal(stats.temperature.length, 2)
  assert.ok(stats.temperature.every(sensor => sensor.zone.startsWith('modem-')), 'router thermal sensors are excluded')
  assert.equal(stats.connection?.protocol, 'MBIM')
  assert.deepEqual(stats.connection?.ipv6, ['2001:db8::2/64'])
  assert.equal(stats.disk[0].used_percent, 40)
})

test('missing snapshots defer instead of fabricating radio-off/SIM-out; explicit SIM absence works', () => {
  const missing = structuredClone(r13Snapshot)
  missing.sampled = {}; missing.raw = {}
  const routes = snapshotRoutes(missing)
  for (const path of ['device', 'network', 'cells', 'sim', 'airplane-mode']) assert.equal(routes['/api/' + path].status, 'deferred')
  missing.sampled.status = 1000
  missing.raw.status = '+CFUN: 1\n+CME ERROR: 10\n'
  assert.equal((snapshotRoutes(missing)['/api/sim'].data as { present: boolean }).present, false)
  missing.raw.status = '+CFUN: 1\n'
  assert.equal(snapshotRoutes(missing)['/api/sim'].status, 'deferred')
})

test('lightweight collection has only fixed read commands and separate TTLs, without LPAC', () => {
  assert.equal(statusGroups.status.ttl, 2)
  assert.equal(statusGroups.cells.ttl, 5)
  assert.equal(statusGroups.temperature.ttl, 4)
  assert.equal(statusGroups.identity.ttl, 86400)
  assert.equal(statusGroups.roaming.ttl, 86400)
  for (const group of Object.values(statusGroups)) assert.ok(group.ttl >= 2 && group.ttl <= 86400)
  for (const group of Object.values(statusGroups)) for (const name of group.names) assert.equal(rm500q.commands[name].kind, 'read')
  assert.ok(!statusCollector.includes('lpac'))
  assert.ok(!statusCollector.includes('+COPS='))
  assert.ok(statusCollector.includes('AT+QENG=\\"servingcell\\"'))
})

test('roaming policy is separate from current roaming registration; unknown preference remains unknown', () => {
  for (const pref of [1, 3, 255]) {
    const snapshot = structuredClone(r13Snapshot)
    snapshot.raw.roaming = `+QNWPREFCFG: "roam_pref",${pref}\n`
    const data = snapshotRoutes(snapshot)['/api/roaming'].data as { roaming_allowed: boolean; is_roaming: boolean; roam_pref: number }
    assert.equal(data.roaming_allowed, pref !== 1)
    assert.equal(data.is_roaming, false)
    assert.equal(data.roam_pref, pref)
  }
  assert.equal(roamingPreference(undefined).roaming_allowed, null)
  const missing = structuredClone(r13Snapshot)
  delete missing.raw.roaming
  assert.equal((snapshotRoutes(missing)['/api/roaming'].data as { roaming_allowed: unknown }).roaming_allowed, null)
})

test('confirmed RF off clears old registration/cells without treating missing data as flight mode', () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.raw.status = snapshot.raw.status.replace('+CFUN: 1', '+CFUN: 4')
  snapshot.sampled.cells = 0
  const routes = snapshotRoutes(snapshot)
  assert.equal(routes['/api/cells'].status, 'ok')
  assert.deepEqual((routes['/api/cells'].data as CellsResponse).cells, [])
  assert.equal((routes['/api/network'].data as NetworkInfo).registration_status, 'unregistered')
  assert.equal((routes['/api/airplane-mode'].data as { enabled: boolean }).enabled, true)
  snapshot.raw.status = snapshot.raw.status.replace('+CFUN: 4', '+CFUN: 1')
  assert.equal(snapshotRoutes(snapshot)['/api/cells'].status, 'deferred', 'wait for fresh cells after RF is restored')
})
