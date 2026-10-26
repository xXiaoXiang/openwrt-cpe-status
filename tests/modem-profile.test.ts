import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import { parseReply } from '../backend/parser.ts'
import { snapshotRoutes } from '../shared/status-snapshot.ts'
import { r13Snapshot } from './fixtures/rm500q-r13.ts'
import { cellLockParams } from '../shared/radio-settings.ts'

test('bundled editable profile matches documented reference and contains read-only telemetry groups', async () => {
  assert.deepEqual(JSON.parse(await readFile('modem.d/2c7c0800.conf', 'utf8')), JSON.parse(JSON.stringify(rm500qProfile)))
  for (const group of Object.values(rm500qProfile.groups)) for (const name of group.names) assert.equal(rm500qProfile.commands[name].kind, 'read')
  for (const operation of Object.values(rm500qProfile.commands)) assert.ok(operation.output)
})
test('snapshot parses a different model and temperature layout entirely from selected profile', () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.adapter!.modelPattern = '^Example-X$'
  snapshot.adapter!.commands.model.rules = [{ regex: '^DEVICE=(.*)$', format: 'captures', fields: { model: { index: 0 } } }]
  snapshot.adapter!.commands.temperature.command = 'AT+HEAT?'
  snapshot.adapter!.commands.temperature.rules = [{ regex: '^HEAT:(.*)$', format: 'csv', fields: { sensor: { index: 1 }, temperature: { index: 0, type: 'number', scale: 0.1 } } }]
  snapshot.raw.identity = 'DEVICE=Example-X'
  snapshot.raw.temperature = 'HEAT:435,chip'
  const routes = snapshotRoutes(snapshot)
  assert.equal((routes['/api/device'].data as { model: string }).model, 'Example-X')
  assert.deepEqual((routes['/api/stats'].data as { temperature: unknown[] }).temperature, [{ zone: 'modem-chip', type: 'chip', temperature: 43.5 }])
})
test('configured lock extraction verifies tuple count and configured parameters set allowed SCS', () => {
  const rows = parseReply(rm500qProfile.commands.lteCellLock, '+QNWLOCK: "common/4g",2,1400,366,3349,323')
  assert.deepEqual(rows, [{ rat: 'lte', arfcn: 1400, pci: 366 }, { rat: 'lte', arfcn: 3349, pci: 323 }])
  assert.throws(() => parseReply(rm500qProfile.commands.lteCellLock, '+QNWLOCK: "common/4g",2,1400,366'))
  const request = { action: 'lock' as const, rat: 'nr' as const, cell: { rat: 'nr' as const, arfcn: 726432, pci: 570, band: 79, scs_khz: 60 } }
  assert.throws(() => cellLockParams(request, JSON.parse(JSON.stringify(rm500qProfile))))
  const alternate = structuredClone(rm500qProfile)
  alternate.commands.nrCellLockSet.parameters!.scs = '15|30|60'
  assert.deepEqual(cellLockParams(request, alternate).slice(-2), ['79', '60'])
})
