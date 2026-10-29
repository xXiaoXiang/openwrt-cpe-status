import { LuciRpcError } from './luciRpc.ts'
import { modemActivity } from './modemActivity.ts'

type Rpc = (object: string, method: string, args: object) => Promise<unknown>
interface Result { status: string; message?: string; available?: boolean; job_id?: string; data?: unknown; result?: unknown; output?: string; output_offset?: number; output_more?: boolean; events?: unknown[] }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const pause = () => new Promise(resolve => setTimeout(resolve, 1000))
export async function euiccLiteFetch(path: string, init: RequestInit | undefined, rpc: Rpc, canWrite: boolean) {
  const execute = async (write: boolean, params: string[]): Promise<Result> => {
    const value = await rpc('file', 'exec', { command: `/usr/libexec/cpe-status/euicc-${write ? 'control' : 'read'}`, params }) as { code?: number; stdout?: string; stderr?: string }
    if (value.code !== 0 || !value.stdout) throw new Error(value.stderr || 'eUICC接口没有返回结果')
    return JSON.parse(value.stdout)
  }
  const post = (init?.method ?? 'GET').toUpperCase() === 'POST'
  if (path === '/api/euicc/activity' && !post) return json(await execute(false, ['activity']))
  if (path === '/api/euicc/settings') {
    if (post && !canWrite) return json({ status: 'error', message: '当前LuCI会话没有写入权限' })
    return json(await execute(post, post ? ['settings', JSON.stringify(JSON.parse(String(init?.body ?? '{}')))] : ['settings']))
  }
  if (!post) {
    const kind = path.endsWith('/capability') ? 'probe' : path === '/api/euicc/notifications' ? 'notifications' : path === '/api/euicc' ? 'info' : null
    if (!kind) return json({ status: 'unsupported' })
    let result = await execute(false, [kind])
    if (kind === 'probe') return json({ ...result, pending: result.status === 'pending' })
    const id = result.job_id, until = Date.now() + 95_000
    while (result.status === 'pending' && id && Date.now() < until) {
      await pause()
      try { result = await execute(false, ['result', `euicc-${kind}`, id]) }
      catch (error) { if (!(error instanceof LuciRpcError && error.transient)) throw error }
    }
    return json(result.status === 'pending' ? { status: 'deferred', message: 'eUICC读取仍在排队，请稍后刷新' } : result)
  }
  if (!canWrite) return json({ status: 'error', message: '当前LuCI会话没有eUICC写入权限' })
  const action = path.startsWith('/api/euicc/profile/') ? path.slice('/api/euicc/profile/'.length)
    : path.startsWith('/api/euicc/notifications/') ? path.slice('/api/euicc/notifications/'.length) : null
  if (!action || !['enable', 'delete', 'nickname', 'download', 'process', 'remove'].includes(action)) return json({ status: 'unsupported', message: 'Not applicable' })
  const body = JSON.parse(String(init?.body ?? '{}')) as object
  // Submission is performed exactly once. A timeout here must never cause an
  // automatic second profile write. All later requests read this job only.
  const release = action === 'download' ? modemActivity.begin() : () => {}
  let start: Result
  try { start = await execute(true, [action, JSON.stringify(body)]) }
  catch (error) { release(); throw error }
  if (start.status !== 'pending' || !start.job_id) { release(); return json(start) }
  if (action === 'download') modemActivity.setRemote(true)
  const id = start.job_id
  let outputOffset = action === 'download' ? 0 : undefined
  const follow = async (consume?: (value: Result) => void, stopped?: () => boolean) => {
    let result = start
    const until = Date.now() + 235_000
    do {
      if (!result.output_more) await pause()
      if (stopped?.()) return result
      try { result = await execute(false, ['job', id, ...(outputOffset === undefined ? [] : [String(outputOffset)])]); consume?.(result) }
      catch (error) {
        if (!(error instanceof LuciRpcError && error.transient)) throw error
        if (result.output_more) await pause()
      }
    } while ((result.status === 'pending' || result.output_more) && Date.now() < until)
    if (action === 'download' && result.status !== 'pending') modemActivity.setRemote(false)
    if (result.status === 'pending') throw new Error('操作仍在执行或结果尚未确认，请读取卡状态；请勿重复提交')
    return result
  }
  if (action !== 'download') return json(await follow())
  const encoder = new TextEncoder()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
      let output = '', seen = 0
      try {
        const result = await follow(value => {
          if (typeof value.output_offset === 'number' && Number.isSafeInteger(value.output_offset) && value.output_offset >= 0) {
            if (value.output) send({ type: 'output', text: value.output })
            outputOffset = value.output_offset
          } else if (value.output && value.output !== output) {
            // Compatibility with older installed helpers returning full logs.
            send({ type: 'output', text: value.output.startsWith(output) ? value.output.slice(output.length) : value.output }); output = value.output
          }
          for (const event of (value.events ?? []).slice(seen)) send({ type: 'lpac', event })
          seen = value.events?.length ?? seen
        }, () => cancelled)
        send({ type: 'complete', success: result.status === 'ok', message: result.message, result: result.result })
      } catch (error) { send({ type: 'complete', success: false, message: error instanceof Error ? error.message : String(error) }) }
      finally { release(); if (!cancelled) controller.close() }
    },
    // Cancelling this observer never submits a cancellation to the backend.
    cancel() { cancelled = true; release() },
  })
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
}
