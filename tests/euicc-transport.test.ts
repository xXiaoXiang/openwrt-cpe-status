import { test } from 'node:test'
import assert from 'node:assert/strict'
import { euiccLiteFetch } from '../frontend/src/api/euiccLite.ts'
import { LuciRpcError } from '../frontend/src/api/luciRpc.ts'
import { ModemActivity, modemActivity } from '../frontend/src/api/modemActivity.ts'

test('eUICC probe stays asynchronous and read-only sessions cannot submit writes', async () => {
  const calls: unknown[] = []
  const rpc = async (_object: string, _method: string, args: object) => {
    calls.push(args)
    return { code: 0, stdout: JSON.stringify({ status: 'pending', job_id: '1-2', available: false }) }
  }
  const probe = await euiccLiteFetch('/api/euicc/capability', undefined, rpc, false)
  assert.deepEqual(await probe.json(), { status: 'pending', job_id: '1-2', available: false, pending: true })
  const denied = await euiccLiteFetch('/api/euicc/profile/delete', { method: 'POST', body: '{}' }, rpc, false)
  assert.equal((await denied.json()).status, 'error')
  assert.equal(calls.length, 1)
})

test('eUICC transient polling failure never resubmits the profile operation', async () => {
  const calls: { command: string; params: string[] }[] = []
  const rpc = async (_object: string, _method: string, args: object) => {
    const request = args as { command: string; params: string[] }
    calls.push(request)
    if (calls.length === 2) throw new LuciRpcError('temporary failure', true, 7)
    return { code: 0, stdout: JSON.stringify(calls.length === 1
      ? { status: 'pending', job_id: '1-2' } : { status: 'ok', data: { iccid: 'fixture' } }) }
  }
  const response = await euiccLiteFetch('/api/euicc/profile/enable', { method: 'POST', body: '{"iccid":"fixture"}' }, rpc, true)
  assert.equal((await response.json()).status, 'ok')
  assert.equal(calls.filter(call => call.command.endsWith('-control')).length, 1)
  assert.deepEqual(calls.slice(1).map(call => call.params), [['job', '1-2'], ['job', '1-2']])
})

test('eUICC download polling preserves progress and the final NDJSON result', async () => {
  let calls = 0
  const rpc = async () => ({ code: 0, stdout: JSON.stringify(++calls === 1
    ? { status: 'pending', job_id: '1-2' }
    : { status: 'ok', output: 'fixture output', events: [{ type: 'progress', payload: { message: 'download' } }], result: { code: 0 } }) })
  const response = await euiccLiteFetch('/api/euicc/profile/download', { method: 'POST', body: '{}' }, rpc, true)
  assert.equal(modemActivity.isPaused(), true)
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.type), ['output', 'lpac', 'complete'])
  assert.equal(events.at(-1).success, true)
  assert.equal(calls, 2)
  assert.equal(modemActivity.isPaused(), false)
})

test('unconfirmed profile switches return their last real list without retrying the write', async () => {
  const calls: { command: string; params: string[] }[] = []
  const result = { status: 'unconfirmed', message: '判断Profile切换超时，请主动刷新页面', data: { confirmed: false, profiles: [{ iccid: 'fixture', profileState: 'disabled' }] } }
  const rpc = async (_object: string, _method: string, args: object) => {
    calls.push(args as { command: string; params: string[] })
    return { code: 0, stdout: JSON.stringify(calls.length === 1 ? { status: 'pending', job_id: '7-8' } : result) }
  }
  const response = await euiccLiteFetch('/api/euicc/profile/enable', { method: 'POST', body: '{"iccid":"fixture"}' }, rpc, true)
  assert.deepEqual(await response.json(), result)
  assert.equal(calls.filter(call => call.command.endsWith('-control')).length, 1)
})

test('download observers can leave without cancelling or resubmitting the backend task', async () => {
  const calls: { params: string[] }[] = []
  const rpc = async (_object: string, _method: string, args: object) => {
    calls.push(args as { params: string[] })
    return { code: 0, stdout: JSON.stringify({ status: 'pending', job_id: '3-4' }) }
  }
  const response = await euiccLiteFetch('/api/euicc/profile/download', { method: 'POST', body: '{}' }, rpc, true)
  await response.body!.cancel()
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(calls.length, 1)
  assert.equal(modemActivity.isPaused(), true)
  // The file-only activity monitor resumes updates when the detached job ends.
  modemActivity.setRemote(false)
  assert.equal(modemActivity.isPaused(), false)
})

test('STDIO HTTP logs drain all chunks once across a transient read failure before completion', async () => {
  const request = JSON.stringify({ type: 'http', direction: 'request', payload: { url: 'https://example.test/download', tx: '7b7d', headers: ['Content-Type: application/json'] } }) + '\n'
  const response = JSON.stringify({ type: 'http', direction: 'response', payload: { rcode: 200, rx: 'ab'.repeat(40_000) } }) + '\n'
  const chunks = [request, response.slice(0, 32_768), response.slice(32_768), '下载完成\n']
  const offsets = [0]
  for (const chunk of chunks) offsets.push(offsets.at(-1)! + new TextEncoder().encode(chunk).length)
  const calls: { command: string; params: string[] }[] = []
  let chunk = 0, retried = false
  const rpc = async (_object: string, _method: string, args: object) => {
    const call = args as { command: string; params: string[] }
    calls.push(call)
    if (calls.length === 1) return { code: 0, stdout: JSON.stringify({ status: 'pending', job_id: '5-6' }) }
    assert.deepEqual(call.params, ['job', '5-6', String(offsets[chunk])])
    if (chunk === 2 && !retried) { retried = true; throw new LuciRpcError('temporary failure', true, 7) }
    const current = chunk++
    return { code: 0, stdout: JSON.stringify({ status: 'ok', output: chunks[current], output_offset: offsets[current + 1], output_more: current < chunks.length - 1,
      events: [{ type: 'progress', payload: { code: 0, message: 'es10b_load_bound_profile_package' } }], result: { code: 0, message: 'success' } }) }
  }
  const result = await euiccLiteFetch('/api/euicc/profile/download', { method: 'POST', body: '{}' }, rpc, true)
  const events = (await result.text()).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.filter(event => event.type === 'output').map(event => event.text).join(''), chunks.join(''))
  assert.equal(events.filter(event => event.type === 'lpac').length, 1)
  assert.equal(events.filter(event => event.type === 'complete').length, 1)
  assert.equal(events.at(-1).success, true)
  assert.equal(calls.filter(call => call.command.endsWith('-control')).length, 1)
  assert.equal(retried, true)
  assert.equal(modemActivity.isPaused(), false)
})

test('paused reads retain their pending work until backend completion and can be aborted independently', async () => {
  const activity = new ModemActivity()
  const release = activity.begin()
  activity.setRemote(true)
  let resumed = false
  const read = activity.wait().then(() => { resumed = true })
  const abort = new AbortController()
  const abandoned = activity.wait(abort.signal)
  abort.abort()
  await assert.rejects(abandoned, { name: 'AbortError' })
  release(); release()
  await Promise.resolve()
  assert.equal(resumed, false)
  activity.setRemote(false)
  await read
  assert.equal(resumed, true)
})

test('communication settings use separate read/write helpers and never enter profile submission', async () => {
  const calls: { command: string; params: string[] }[] = []
  const rpc = async (_object: string, _method: string, args: object) => {
    calls.push(args as { command: string; params: string[] })
    return { code: 0, stdout: JSON.stringify({ status: 'ok', data: { apdu: 'uqmi', http: 'stdio' } }) }
  }
  await euiccLiteFetch('/api/euicc/settings', undefined, rpc, false)
  assert.deepEqual(calls[0], { command: '/usr/libexec/cpe-status/euicc-read', params: ['settings'] })
  const body = '{"apdu":"uqmi","http":"stdio"}'
  const denied = await euiccLiteFetch('/api/euicc/settings', { method: 'POST', body }, rpc, false)
  assert.equal((await denied.json()).status, 'error')
  assert.equal(calls.length, 1)
  await euiccLiteFetch('/api/euicc/settings', { method: 'POST', body }, rpc, true)
  assert.deepEqual(calls[1], { command: '/usr/libexec/cpe-status/euicc-control', params: ['settings', body] })
  assert.equal(calls.length, 2)
})
