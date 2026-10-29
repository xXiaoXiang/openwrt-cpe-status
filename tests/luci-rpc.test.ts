import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeLuciRpc, LuciRpcError } from '../frontend/src/api/luciRpc.ts'

test('LuCI timeout and connection failures are retryable; permission failures remain distinct', async () => {
  for (const code of [7, 10]) await assert.rejects(decodeLuciRpc(Response.json({ result: [code] })), (error: unknown) =>
    error instanceof LuciRpcError && error.transient && error.code === code && !/权限/.test(error.message))
  await assert.rejects(decodeLuciRpc(Response.json({ result: [6] })), (error: unknown) =>
    error instanceof LuciRpcError && !error.transient && /权限/.test(error.message))
  await assert.rejects(decodeLuciRpc(new Response('', { status: 503 })), (error: unknown) => error instanceof LuciRpcError && error.transient)
})

test('LuCI preserves file exit codes and reports malformed RPC independently of permissions', async () => {
  const result = { code: 1, stderr: 'AT query failed' }
  assert.deepEqual(await decodeLuciRpc(Response.json({ result: [0, result] })), result)
  await assert.rejects(decodeLuciRpc(new Response('<html>login</html>')), /无效的 RPC/)
  await assert.rejects(decodeLuciRpc(Response.json({ error: { code: -32601, message: 'Method not found' } })), /Method not found/)
})
