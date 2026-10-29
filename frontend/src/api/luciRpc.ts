export class LuciRpcError extends Error {
  constructor(message: string, readonly transient = false, readonly code?: number) {
    super(transient ? `ModemReadDeferred: ${message}` : message)
    this.name = 'LuciRpcError'
  }
}

export async function decodeLuciRpc<T = unknown>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LuciRpcError('LuCI 会话已过期或权限不足，请重新登录', false, response.status)
    throw new LuciRpcError(`LuCI HTTP 请求失败（${response.status}）`, response.status >= 500, response.status)
  }
  let rpc: { result?: [number, T]; error?: { code?: number; message?: string } }
  try { rpc = await response.json() } catch { throw new LuciRpcError('LuCI 返回了无效的 RPC 响应') }
  if (!rpc.result) throw new LuciRpcError(`LuCI RPC 响应错误：${rpc.error?.message || '缺少结果'}`, false, rpc.error?.code)
  const code = rpc.result[0]
  if (code === 0) return rpc.result[1]
  if (code === 6) throw new LuciRpcError('LuCI 会话已过期或没有此操作的权限，请重新登录', false, code)
  if (code === 7) throw new LuciRpcError('LuCI RPC 请求超时，任务可能仍在执行，将读取任务结果', true, code)
  if (code === 10) throw new LuciRpcError('LuCI 无法连接 ubus 服务，稍后重试', true, code)
  throw new LuciRpcError(`LuCI RPC 执行失败（ubus ${code}）`, false, code)
}
