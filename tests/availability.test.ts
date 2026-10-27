import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine, validateAdapter } from '../backend/engine.ts'
import { renderCommand } from '../backend/parser.ts'
import { operationSupported, parameterSupported, unsupportedResult } from '../shared/availability.ts'
import { snapshotRoutes } from '../shared/status-snapshot.ts'
import { lteOnlyProfile } from './fixtures/lte-only-profile.ts'
import { r13Snapshot } from './fixtures/rm500q-r13.ts'
import type { AtTransport } from '../backend/transport.ts'

const transport = (sent: string[], reply = 'OK'): AtTransport => ({ async exchange(command) { sent.push(command); return reply }, async suspend(work) { return work() }, async close() {} })

test('explicit unsupported declarations override retained AT commands and reject transport access', async () => {
  const profile = lteOnlyProfile()
  const sent: string[] = []
  const engine = new Engine(profile, transport(sent), true)
  for (const name of ['registration5g', 'temperature', 'nrBands']) await assert.rejects(engine.read(name), /Unsupported:/)
  await assert.rejects(engine.write('nrCellLockSet', { arfcn: '632352', pci: '41', band: '78', scs: '30' }), /Unsupported:/)
  assert.deepEqual(sent, [])
  assert.equal(operationSupported(profile, 'serving'), true)
  assert.equal(operationSupported(profile, 'nrCellLock'), false)
  delete profile.commands.registration5g
  validateAdapter(profile)
  assert.equal(operationSupported(profile, 'registration5g'), false)
})

test('unsupported write values are distinct from malformed or unconfirmed values', async () => {
  const profile = lteOnlyProfile()
  const sent: string[] = []
  const engine = new Engine(profile, transport(sent), true)
  assert.equal(parameterSupported(profile, 'modeSet', 'mode', 'LTE'), true)
  assert.equal(parameterSupported(profile, 'modeSet', 'mode', 'NR5G'), false)
  assert.equal(parameterSupported(profile, 'modeSet', 'mode', 'LTE:NR5G'), false)
  await assert.rejects(engine.write('modeSet', { mode: 'NR5G' }), /Unsupported:/)
  assert.deepEqual(sent, [])
  assert.equal(renderCommand(profile.commands.modeSet, { mode: 'LTE' }), 'AT+QNWPREFCFG="mode_pref",LTE')
  profile.commands.modeSet.parameterValues = { mode: ['bad;AT+CFUN=0'] }
  assert.throws(() => validateAdapter(profile), /Invalid supported parameter values/)
})

test('unsupported snapshots use a fixed placeholder without fabricating false/zero or staying deferred', () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.adapter = lteOnlyProfile()
  snapshot.adapter.unsupportedOperations!.mode = 'No mode query'
  snapshot.adapter.unsupportedOperations!.serving = 'No serving query'
  snapshot.sampled = {}
  const routes = snapshotRoutes(snapshot)
  for (const path of ['/api/network-mode', '/api/cells', '/api/roaming']) {
    assert.equal(routes[path].status, 'unsupported')
    assert.equal(routes[path].message, 'Not applicable')
    assert.equal(routes[path].display, '-')
    assert.equal(routes[path].data, undefined)
    assert.equal(routes[path].retry_after_ms, undefined)
  }
  assert.equal(routes['/api/airplane-mode'].status, 'deferred', 'a supported read with no sample is still pending')
  assert.deepEqual(unsupportedResult(), { status: 'unsupported', message: 'Not applicable', display: '-' })
  assert.equal((routes['/api/stats'].data as { temperature: unknown[] }).temperature.length, 0)
})

test('LTE registration survives absent NR queries; failed supported queries remain failures', async () => {
  const snapshot = structuredClone(r13Snapshot)
  snapshot.adapter = lteOnlyProfile()
  snapshot.raw.status = '+CPIN: READY\n+CEREG: 2,1\n+C5GREG: 2,5\n'
  assert.equal((snapshotRoutes(snapshot)['/api/network'].data as { registration_status: string }).registration_status, 'registered')
  const engine = new Engine(snapshot.adapter, transport([], 'ERROR'))
  await assert.rejects(engine.read('mode'), /No matching data/)
})
