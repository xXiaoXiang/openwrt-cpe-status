import type { ModemProfile } from '../../../shared/modem-profile.ts'
import { validateApnSettings, type ApnSettings } from '../../../shared/apn-settings.ts'
import { snapshotRoutes, type StatusSnapshot } from '../../../shared/status-snapshot.ts'
import type { ApiResponse } from '../../../shared/adapter.ts'
import { snapshotCapabilities } from '../../../shared/roaming.ts'
import { bandGroups, normalizeBands, type BandState } from '../../../shared/bands.ts'
import { cellLockParams, lockMatches, networkModes, type CellLockRequest, type CellLockState } from '../../../shared/radio-settings.ts'
import { joinSmsSegments, type ArchivedSms } from '../../../shared/sms-history.ts'

const unsupported: ApiResponse = { status: 'unsupported', message: '此状态插件未启用该操作' }
let interval = Number(localStorage.getItem('cpe-status-refresh') ?? 2000)
if (![0, 1000, 2000, 3000, 5000, 10000].includes(interval)) interval = 2000
let cache: { time: number; data: StatusSnapshot } | undefined
let pending: Promise<StatusSnapshot> | undefined
let revision = 0
let writing = false
let canWrite: boolean | undefined
let selectedProfile: ModemProfile | undefined
let localRead: Promise<{ speed?: { wall_time: number; time: number; previous_time: number; counters: StatusSnapshot['host']['counters']; previous_counters: StatusSnapshot['host']['counters'] }; wwan?: { status: string; message: string; carrier?: string; apn?: string } }> | undefined
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
export async function statusLiteFetch(path: string, init: RequestInit | undefined, rpc: (object: string, method: string, args: object) => Promise<unknown>) {
  if (path === '/api/adaptation') {
    try { canWrite = (await rpc('session', 'access', { scope: 'access-group', object: 'luci-app-cpe-status', function: 'write' }) as { access?: boolean }).access === true } catch { canWrite = false }
    const file = await rpc('file', 'exec', { command: '/usr/libexec/cpe-status-snapshot', params: ['profile'] }) as { code?: number; stdout?: string }
    const info = file.code === 0 && file.stdout ? JSON.parse(file.stdout) : {}
    const profile = info.data as ModemProfile | undefined
    const valid = profile?.schemaVersion === 1
    selectedProfile = profile
    return response({ status: 'ok', data: { ...snapshotCapabilities, id: profile?.id ?? 'unknown-modem', writes_enabled: canWrite && valid, data_control: valid, airplane_control: !!profile?.commands.airplaneSet, roaming_policy: !!profile?.commands.roamingSet, modem_profile: profile } })
  }
  const local = async () => {
    if (!localRead) localRead = rpc('file', 'exec', { command: '/usr/libexec/cpe-status-speed-settings', params: ['read'] }).then(result => {
      const value = result as { code?: number; stdout?: string }
      return value.code === 0 && value.stdout ? JSON.parse(value.stdout) : {}
    }).finally(() => { localRead = undefined })
    return localRead
  }
  if ((path === '/api/apn' || path === '/api/apn/refresh') && (init?.method ?? 'GET') === 'GET') {
    if (canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有 APN 配置权限' })
    const result = await rpc('file', 'exec', { command: '/usr/libexec/cpe-status-apn', params: path.endsWith('/refresh') ? ['refresh'] : [] }) as { code?: number; stdout?: string; stderr?: string }
    if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || 'APN 配置读取失败')
    return response(JSON.parse(result.stdout))
  }
  if (path === '/api/wwan-management') return response({ status: 'ok', data: (await local()).wwan })
  if (path.startsWith('/api/refresh/')) {
    if (path === '/api/refresh/config' && init?.method === 'POST') {
      const value = JSON.parse(String(init.body ?? '{}')).interval_ms
      if (![0, 1000, 2000, 3000, 5000, 10000].includes(value)) throw new Error('Invalid refresh interval')
      interval = value; localStorage.setItem('cpe-status-refresh', String(value))
    }
    if (path === '/api/refresh/config') await rpc('file', 'exec', { command: '/usr/libexec/cpe-status-speed-settings', params: [String(interval)] })
    return response({ status: 'ok', data: { interval_ms: interval } })
  }
  if (path === '/api/at' || path.startsWith('/api/sms/')) {
    if (canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有 AT / 短信权限' })
    const url = new URL(path, 'http://router'), post = init?.method === 'POST', body = post ? JSON.parse(String(init?.body ?? '{}')) : {}
    let params: string[]
    if (path === '/api/at' && post && typeof body.cmd === 'string') params = ['at', body.cmd]
    else if (url.pathname === '/api/sms/storage') params = post ? ['config', String(body.path ?? '')] : ['config']
    else if (url.pathname === '/api/sms/send' && post) {
      if (typeof body.content !== 'string' || !body.content.length || body.content.length > 70 || /[\ud800-\udfff]/.test(body.content)) return response({ status: 'error', message: '请输入 1–70 个字符，不支持 emoji' })
      params = ['send', String(body.phone_number ?? ''), body.content]
    } else if (url.pathname === '/api/sms/clear' && post) params = ['clear']
    else if (!post && ['/api/sms/list', '/api/sms/conversation', '/api/sms/stats'].includes(url.pathname)) params = ['list']
    else return response(unsupported)
    const result = await rpc('file', 'exec', { command: '/usr/libexec/cpe-status-messaging', params }) as { code?: number; stdout?: string; stderr?: string }
    if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || 'AT / 短信操作未返回结果')
    const value = JSON.parse(result.stdout)
    if (path === '/api/at') {
      revision++; if (cache) cache.time = 0
      if (value.status !== 'ok') throw new Error(value.message || 'AT 命令未执行')
      return new Response(value.data, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    if (value.status === 'ok' && params[0] === 'list') {
      let records = joinSmsSegments(value.data as ArchivedSms[])
      if (url.pathname.endsWith('/stats')) return response({ status: 'ok', data: { total: records.length, incoming: records.filter(row => row.direction === 'incoming').length, outgoing: records.filter(row => row.direction === 'outgoing').length, unread: records.filter(row => row.status === 'received').length } })
      if (url.pathname.endsWith('/conversation')) records = records.filter(row => row.phone_number === url.searchParams.get('phone_number'))
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0), limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      return response({ ...value, data: records.slice(offset, offset + limit) })
    }
    return response(value)
  }
  if (path === '/api/cell-scan') {
    const start = init?.method?.toUpperCase() === 'POST'
    if (!start && (init?.method ?? 'GET') !== 'GET') return response(unsupported)
    if (start && canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有扫描权限' })
    if (start && writing) return response({ status: 'deferred', message: '已有 Modem 操作正在执行', scanning: false })
    // Short submission and file-only polling: a LuCI request never waits for
    // the multi-minute scan. The backend AT lock coordinates other sessions.
    const result = await rpc('file', 'exec', { command: start ? '/usr/libexec/cpe-status-control' : '/usr/libexec/cpe-status-scan-result', params: start ? ['scan'] : [] }) as { code?: number; stdout?: string; stderr?: string }
    if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '无法读取小区扫描任务')
    const value = JSON.parse(result.stdout)
    return response(value.status === 'pending' ? { ...value, status: 'deferred', scanning: true } : value)
  }
  if (['/api/operators', '/api/operators/refresh', '/api/operators/current', '/api/operators/current-result'].includes(path)) {
    const start = init?.method?.toUpperCase() === 'POST'
    if (path !== '/api/operators' && start) return response(unsupported)
    if (start && canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有选网权限' })
    const body = start ? JSON.parse(String(init?.body ?? '{}')) : {}
    const params = !start ? path.endsWith('/current-result') ? ['state'] : path.endsWith('/current') ? ['current'] : path.endsWith('/refresh') ? ['refresh'] : [] : body.action === 'scan' ? ['operator-scan'] : body.action === 'auto' ? ['operator', 'auto'] : body.action === 'manual' && /^\d{5,6}$/.test(body.plmn ?? '') ? ['operator', body.plmn] : null
    if (!params) return response({ status: 'error', message: '无效的选网参数' })
    if (start && writing) return response({ status: 'deferred', message: '已有 Modem 操作正在执行', busy: false })
    const result = await rpc('file', 'exec', { command: start ? '/usr/libexec/cpe-status-control' : '/usr/libexec/cpe-status-operators', params }) as { code?: number; stdout?: string; stderr?: string }
    if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '无法读取运营商任务')
    const value = JSON.parse(result.stdout)
    if (start) { revision++; if (cache) cache.time = 0 }
    return response(value.status === 'pending' ? { ...value, status: 'deferred', busy: true } : value)
  }
  if (['/api/band-lock', '/api/cell-lock', '/api/cell-lock/refresh'].includes(path) && (init?.method ?? 'GET') === 'GET') {
    const result = await rpc('file', 'exec', { command: path.startsWith('/api/cell-lock') ? '/usr/libexec/cpe-status-cell-locks' : '/usr/libexec/cpe-status-bands', params: path.endsWith('/refresh') ? ['refresh'] : [] }) as { code?: number; stdout?: string; stderr?: string }
    if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '频段读取未返回结果')
    return response(JSON.parse(result.stdout))
  }
  if (['/api/data', '/api/airplane-mode', '/api/band-lock', '/api/network-mode', '/api/cell-lock', '/api/apn'].includes(path) && init?.method?.toUpperCase() === 'POST') {
    if (canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有 Modem 控制权限' })
    const kind = path === '/api/apn' ? 'apn' : path === '/api/cell-lock' ? 'cell' : path === '/api/network-mode' ? 'mode' : path === '/api/band-lock' ? 'bands' : path === '/api/data' ? 'data' : 'airplane'
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    const target = body[kind === 'data' ? 'active' : 'enabled']
    if (['data', 'airplane'].includes(kind) && typeof target !== 'boolean') return response({ status: 'error', message: '开关设置必须是布尔值' })
    let params: string[]
    try {
      if (kind === 'apn') params = ['apn', JSON.stringify(validateApnSettings(body as unknown as ApnSettings))]
      else if (kind === 'mode') {
        if (!networkModes.some(mode => mode.value === body.mode)) throw new Error('无效的网络模式')
        params = ['mode', String(body.mode)]
      } else if (kind === 'cell') params = cellLockParams(body as unknown as CellLockRequest, selectedProfile)
      else params = kind === 'bands' ? ['bands', ...bandGroups.map(group => normalizeBands(body[group.key]).join(':'))] : [kind, target ? '1' : '0']
    }
    catch (error) { return response({ status: 'error', message: String(error) }) }
    if (writing) return response({ status: 'deferred', message: '已有 Modem 设置正在执行', submitted: false })
    writing = true; revision++
    const execute = async (command: string, params: string[]) => {
      const result = await rpc('file', 'exec', { command, params }) as { code?: number; stdout?: string; stderr?: string }
      if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || 'Modem 控制未返回结果，请刷新检查实际状态')
      return JSON.parse(result.stdout) as { status: string; message?: string; job_id?: string; data?: Record<string, unknown>; snapshot?: StatusSnapshot }
    }
    try {
      let result = await execute('/usr/libexec/cpe-status-control', params)
      if (result.status !== 'pending') return response(result)
      if (!result.job_id || !/^\d+-\d+$/.test(result.job_id)) throw new Error('无效的 Modem 控制任务')
      const job = result.job_id, deadline = Date.now() + 60_000
      do {
        await new Promise(resolve => setTimeout(resolve, 1000))
        result = await execute('/usr/libexec/cpe-status-control-result', [job])
      } while (result.status === 'pending' && Date.now() < deadline)
      if (result.snapshot && result.snapshot.device === cache?.data.device) cache = { time: 0, data: result.snapshot }
      else if (cache) cache.time = 0
      if (result.status === 'pending') return response({ status: 'deferred', message: '设置已提交，尚未确认最终状态，请稍后刷新' })
      if (result.status === 'ok') {
        const bands = result.data as unknown as BandState | undefined
        const matches = kind === 'apn' ? JSON.stringify(result.data?.settings) === JSON.stringify(validateApnSettings(body as unknown as ApnSettings)) : kind === 'mode' ? result.data?.mode === body.mode
          : kind === 'cell' ? lockMatches(result.data as unknown as CellLockState, body as unknown as CellLockRequest)
          : kind === 'bands' ? bandGroups.every(group => bands?.enabled?.[group.key]?.join(':') === normalizeBands(body[group.key]).join(':'))
          : kind === 'data' ? result.data?.active === target
          : result.data?.enabled === target && result.data?.online === !target
        if (!matches) throw new Error('Modem 返回的确认状态与请求不符')
      }
      return response({ status: result.status, message: result.message, data: result.data })
    } finally { writing = false; revision++ }
  }
  if (path === '/api/roaming' && init?.method?.toUpperCase() === 'POST') {
    if (canWrite !== true) return response({ status: 'error', message: '当前 LuCI 会话没有漫游设置权限' })
    const body = JSON.parse(String(init.body ?? '{}')) as { allowed?: unknown }
    if (typeof body.allowed !== 'boolean') return response({ status: 'error', message: '漫游设置必须是布尔值' })
    if (writing) return response({ status: 'error', message: '正在设置漫游偏好，请稍后重试' })
    writing = true; revision++
    try {
      const result = await rpc('file', 'exec', { command: '/usr/libexec/cpe-status-roaming', params: [body.allowed ? '255' : '1'] }) as { code?: number; stdout?: string; stderr?: string }
      if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '漫游设置没有返回结果，请刷新检查实际状态')
      const confirmed = JSON.parse(result.stdout) as ApiResponse<Record<string, unknown>> & { raw?: string; sampled_at?: number }
      if (confirmed.status !== 'ok') {
        if (cache) cache.time = 0
        return response(confirmed)
      }
      if (confirmed.data?.roam_pref !== (body.allowed ? 255 : 1) || confirmed.data?.roaming_allowed !== body.allowed || !confirmed.raw) throw new Error('模块返回的漫游状态与请求不符')
      // Keep all unrelated badges and cached groups; do not optimistically flip.
      if (cache) {
        cache.data.raw.roaming = confirmed.raw
        cache.data.sampled.roaming = confirmed.sampled_at ?? Math.floor(Date.now() / 1000)
      }
      const previous = cache ? snapshotRoutes(cache.data)['/api/roaming'].data as object : {}
      return response({ status: 'ok', message: confirmed.message, data: { ...previous, ...confirmed.data } })
    } finally { writing = false; revision++ }
  }
  if ((init?.method ?? 'GET') !== 'GET' || ['/api/qos', '/api/ims/status', '/api/connectivity'].includes(path)) return response(unsupported)
  if (!['/api/device', '/api/network', '/api/network-mode', '/api/cells', '/api/airplane-mode', '/api/roaming', '/api/sim', '/api/data', '/api/stats'].includes(path)) return response(unsupported)
  if (!writing && (!cache || Date.now() - cache.time >= 450)) {
    if (!pending) {
      const readRevision = revision
      pending = rpc('file', 'exec', { command: '/usr/libexec/cpe-status-snapshot', params: [] }).then(value => {
      const result = value as { code?: number; stdout?: string; stderr?: string }
      if (result.code !== 0 || !result.stdout) throw new Error(result.stderr || '采集脚本没有返回数据')
      const snapshot = JSON.parse(result.stdout) as StatusSnapshot
      if (!snapshot.error && readRevision === revision) cache = { time: Date.now(), data: snapshot }
      return snapshot
      }).finally(() => { pending = undefined })
    }
    const snapshot = await pending
    if (snapshot.error) return response({ status: 'deferred', message: snapshot.error, retry_after_ms: snapshot.retry_after_ms ?? 5000 })
  }
  if (!cache) return response({ status: 'deferred', message: '等待 Modem 快照', retry_after_ms: 5000 })
  if (path === '/api/stats') {
    const speed = (await local()).speed
    if (speed && Date.now() / 1000 - speed.wall_time < 3) {
      const host = { ...cache.data.host, counters: speed.counters, previous_counters: speed.previous_counters, speed_time: speed.time, speed_previous_time: speed.previous_time }
      return response(snapshotRoutes({ ...cache.data, host })[path])
    }
  }
  return response(snapshotRoutes(cache.data)[path] ?? unsupported)
}
