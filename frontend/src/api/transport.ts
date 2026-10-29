import { statusLiteFetch } from './statusLite'
import { decodeLuciRpc, LuciRpcError } from './luciRpc'
import { modemActivity } from './modemActivity'
interface LuciWindow extends Window { L?: { env?: { sessionid?: string; ubuspath?: string } } }
async function rpcFetch(url: string, init: RequestInit) {
  try { return await fetch(url, init) }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new LuciRpcError('无法连接 LuCI RPC 服务，请检查网络连接', true)
  }
}
export function usesSnapshotTransport() {
  return typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(location.search).get('source') === 'quectel'
}

export async function backendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (window.parent === window || !new URLSearchParams(location.search).has('embedded')) return fetch(input, init)
  const environment = (window.parent as LuciWindow).L?.env
  if (!environment?.sessionid) throw new Error('LuCI 会话不存在，请重新登录路由器')
  const path = String(input)
  if (!path.startsWith('/api/')) throw new Error('Invalid Modem API path')
  if (usesSnapshotTransport() && !['/api/euicc/activity', '/api/euicc/capability', '/api/euicc/profile/download', '/api/adaptation'].includes(path) && !path.startsWith('/api/refresh/')) {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET' && modemActivity.isPaused())
      return new Response(JSON.stringify({ status: 'deferred', submitted: false }), { headers: { 'Content-Type': 'application/json' } })
    await modemActivity.wait(init?.signal)
  }
  const write = (init?.method ?? 'GET').toUpperCase() !== 'GET'
  if (new URLSearchParams(location.search).get('source') === 'quectel') {
    return statusLiteFetch(path, init, async (object, method, args) => {
      const result = await rpcFetch(environment.ubuspath ?? '/ubus/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [environment.sessionid, object, method, args] }) })
      return decodeLuciRpc(result)
    })
  }
  const response = await rpcFetch(environment.ubuspath ?? '/ubus/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: init?.signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [environment.sessionid, 'openwrt-modem', write ? 'write' : 'read', { path, ...(write ? { body: String(init?.body ?? '{}') } : {}) }] }),
  })
  const rpc = await decodeLuciRpc<{ content?: string; content_type?: string }>(response)
  if (typeof rpc?.content !== 'string') throw new Error('LuCI RPC 没有返回有效内容')
  return new Response(rpc.content, { headers: { 'Content-Type': rpc.content_type ?? 'application/json' } })
}
