import { parseReply } from '../backend/parser.ts'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellTarget, cellLockParams as validateCellLock, lockMatches, networkModes, type CellLockState } from '../shared/radio-settings.ts'
import { snapshotRoutes } from '../shared/status-snapshot.ts'
import { r13Snapshot } from './fixtures/rm500q-r13.ts'
import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { cacheSeconds } from '../shared/cache-policy.ts'
import { parseCellScan as normalizeResult } from '../shared/cell-scan.ts'

const cellLockParams = (body: Parameters<typeof validateCellLock>[0]) => validateCellLock(body, rm500qProfile)
function parseCellScan(raw: string) {
  if (!/^\s*OK\s*$/m.test(raw) || /^\s*(ERROR|\+CME ERROR:)/m.test(raw)) throw new Error('扫描未完整结束')
  try { return normalizeResult(raw, parseReply(rm500qProfile.commands.cellScan, raw)) } catch (error) { throw new Error('扫描格式无法识别：' + error) }
}

test('NR QENG SCS enum becomes kHz; NSA rows remain actionable', () => {
  const cell = cellTarget({ tech: 'nr', arfcn: 726432, pci: 570, band: 'n79', scs: 1 })!
  assert.deepEqual(cell, { rat: 'nr', arfcn: 726432, pci: 570, band: 79, scs_khz: 30 })
  assert.deepEqual(cellLockParams({ action: 'lock', rat: 'nr', cell }), ['cell', 'nr', 'lock', '726432', '570', '79', '30'])
  assert.equal(cellTarget({ tech: 'lte', arfcn: 0, pci: 0, band: 'B1' })?.pci, 0)
  assert.equal(cellTarget({ tech: 'nr', arfcn: 0, pci: 0, band: 'n0' }), undefined)
  assert.equal(cellTarget({ tech: 'lte', arfcn: undefined, pci: 1 }), undefined)
  assert.throws(() => cellLockParams({ action: 'lock', rat: 'nr', cell: { ...cell, scs_khz: 60 } }))
  assert.throws(() => cellLockParams({ action: 'lock', rat: 'nr', cell: { ...cell, pci: 0 } }))
  assert.throws(() => cellLockParams({ action: 'lock', rat: 'lte', cell: { rat: 'lte', arfcn: 1, pci: 504 } }))
})
test('only matching successful lock readback confirms a write', () => {
  const cell = { rat: 'nr' as const, arfcn: 726432, pci: 570, band: 79, scs_khz: 30 }
  const state: CellLockState = { nr: { status: 'ok', count: 1, cells: [cell], raw: '+QNWLOCK: "common/5g",570,726432,30,79' }, lte: { status: 'ok', count: 0, cells: [], raw: '' }, sampled_at: 1000 }
  assert.equal(lockMatches(state, { action: 'lock', rat: 'nr', cell }), true)
  assert.equal(lockMatches(state, { action: 'lock', rat: 'nr', cell: { ...cell, band: 78 } }), false)
  assert.equal(lockMatches(state, { action: 'unlock', rat: 'nr' }), false)
  assert.equal(lockMatches(state, { action: 'unlock', rat: 'lte' }), true)
  state.nr.status = 'error'
  assert.equal(lockMatches(state, { action: 'lock', rat: 'nr', cell }), false)
})
test('network mode uses the shared snapshot; missing results are never AUTO', () => {
  const snapshot = structuredClone(r13Snapshot)
  assert.equal(snapshotRoutes(snapshot)['/api/network-mode'].status, 'deferred')
  snapshot.raw.mode = '+QNWPREFCFG: "mode_pref",LTE:NR5G\n'
  snapshot.sampled.mode = 1000
  assert.deepEqual(snapshotRoutes(snapshot)['/api/network-mode'].data, { mode: 'LTE:NR5G' })
  for (const mode of ['AUTO', 'LTE', 'NR5G', 'LTE:NR5G', 'WCDMA:LTE', 'WCDMA']) assert.ok(networkModes.some(row => row.value === mode))
})
test('static settings use long caches while cell telemetry uses five seconds', () => {
  assert.equal(Math.min(...Object.values(cacheSeconds)), 1)
  assert.equal(Math.max(...Object.values(cacheSeconds)), 86400)
  for (const command of Object.values(rm500q.commands).filter(row => row.kind === 'read')) assert.ok(command.ttlMs! >= 2000 && command.ttlMs! <= 86400000, command.command)
})

test('QSCAN extended LTE/NR keeps PLMN, PCI zero and NR SCS without assuming connected cells', () => {
  const raw = '+QSCAN: "NR5G",454,00,632352,41,-86,-10,33,1,31E7C20,452,273,78,24,12,-\r\n'
    + '+QSCAN: "LTE",454,12,1400,0,-95,-13,16,121,31E7C20,452,100,3\r\nOK\r\n'
  const cells = parseCellScan(raw)
  assert.equal(cells.serving_cell, null)
  assert.deepEqual(cells.cells.map(cell => [cell.tech, cell.band, cell.mcc, cell.mnc, cell.arfcn, cell.pci, cell.rsrp, cell.scs]), [
    ['lte', 'B3', '454', '12', 1400, 0, -9500, undefined], ['nr', 'n78', '454', '00', 632352, 41, -8600, 1],
  ])
  assert.equal(cells.cells.every(cell => !cell.is_serving && cell.bandwidth_mhz == null && cell.sinr == null), true)
  const nr = cellTarget(cells.cells[1])!
  assert.deepEqual(cellLockParams({ action: 'lock', rat: 'nr', cell: nr }), ['cell', 'nr', 'lock', '632352', '41', '78', '30'])
})

test('QSCAN incomplete or rejected results never replace the list; a completed empty scan is valid', () => {
  assert.throws(() => parseCellScan('+QSCAN: "LTE",454,00,1400,1,-95,-13,16,121'), /未完整结束/)
  assert.throws(() => parseCellScan('+CME ERROR: 3\nOK\n'))
  assert.throws(() => parseCellScan('+QSCAN: broken\nOK\n'), /格式无法识别/)
  assert.deepEqual(parseCellScan('AT+QSCAN=3,1\r\nOK\r\n').cells, [])
})

test('QSCAN base format remains lockable; missing values are not converted to zero', () => {
  const cells = parseCellScan('+QSCAN: "LTE",454,00,1400,366,-,-,16,121\n+QSCAN: "NR5G",454,00,726432,570,-96,-11,33,-\nOK\n').cells
  assert.equal(cells.length, 2)
  assert.equal(cells[0].rsrp, undefined)
  assert.equal(cells[1].scs, undefined)
  assert.equal(cellTarget(cells[0])?.arfcn, 1400)
  assert.equal(cells[1].band, undefined)
})
