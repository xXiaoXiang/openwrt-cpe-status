import { statusLiteFetch } from './statusLite'
interface LuciWindow extends Window { L?: { env?: { sessionid?: string; ubuspath?: string } } }
export function usesSnapshotTransport() {
  return typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(location.search).get('source') === 'quectel'
}

export async function backendFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (window.parent === window || !new URLSearchParams(location.search).has('embedded')) return fetch(input, init)
  const environment = (window.parent as LuciWindow).L?.env
  if (!environment?.sessionid) throw new Error('LuCI 会话不存在，请重新登录路由器')
  const path = String(input)
  if (!path.startsWith('/api/')) throw new Error('Invalid Modem API path')
  const write = (init?.method ?? 'GET').toUpperCase() !== 'GET'
  if (new URLSearchParams(location.search).get('source') === 'quectel') {
    return statusLiteFetch(path, init, async (object, method, args) => {
      const result = await fetch(environment.ubuspath ?? '/ubus/', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [environment.sessionid, object, method, args] }) })
      const rpc = await result.json() as { result?: [number, unknown] }
      if (!result.ok || !rpc.result || rpc.result[0] !== 0) throw new Error('LuCI 会话或采集权限不可用')
      return rpc.result[1]
    })
  }
  const response = await fetch(environment.ubuspath ?? '/ubus/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: init?.signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [environment.sessionid, 'openwrt-modem', write ? 'write' : 'read', { path, ...(write ? { body: String(init?.body ?? '{}') } : {}) }] }),
  })
  if (!response.ok) throw new Error(`LuCI RPC HTTP ${response.status}`)
  const rpc = await response.json() as { result?: [number, { content?: string; content_type?: string }]; error?: { message?: string } }
  if (!rpc.result || rpc.result[0] !== 0 || typeof rpc.result[1]?.content !== 'string') throw new Error(rpc.error?.message ?? `LuCI 权限或 RPC 错误：${rpc.result?.[0]}`)
  return new Response(rpc.result[1].content, { headers: { 'Content-Type': rpc.result[1].content_type ?? 'application/json' } })
}
