import type { ModemProfile } from './modem-profile.ts'
import { parseReply } from '../backend/parser.ts'
import { normalizeCells } from '../backend/cells.ts'
import type { Scalar, ApiResponse } from './adapter.ts'
import { connectionFromHost, interfaceAliases, type HostNetwork } from './host-network.ts'
import { roamingPreference, snapshotCapabilities } from './roaming.ts'
import { operationSupported, unsupportedResult } from './availability.ts'

export interface RouterHost extends HostNetwork {
  time: number; previous_time: number
  speed_time?: number; speed_previous_time?: number
  board: { kernel?: string; hostname?: string; model?: string; release?: { description?: string } }
  meminfo: string; loadavg: string; uptime: string; cpustat: string; cpuinfo: string; machine: string; disk: string
  counters: { interface: string; rx: number; tx: number }[]; previous_counters: { interface: string; rx: number; tx: number }[]
  thermal: { zone: string; type: string; temperature: number }[]
}
export interface StatusSnapshot {
  error?: string; retry_after_ms?: number; source: string; device: string; stale?: boolean
  profile_key?: string; adapter?: ModemProfile; sim_identity?: { iccid: string; imsi: string };
  raw: Record<string, string>; sampled: Record<string, number>; warnings?: Record<string, string>; host: RouterHost
}
const registration = (value: Scalar | undefined) => ({ 0: 'unregistered', 1: 'registered', 2: 'searching', 3: 'denied', 4: 'unknown', 5: 'roaming', 8: 'emergency' }[Number(value)] ?? 'unknown')
export function snapshotRoutes(snapshot: StatusSnapshot): Record<string, ApiResponse> {
  const parsed = (name: string, group: string) => { try { return operationSupported(snapshot.adapter, name) ? parseReply(snapshot.adapter!.commands[name], snapshot.raw[group] ?? '') : [] } catch { return [] } }
  const row = (name: string, group: string) => parsed(name, group)[0] ?? {}
  const ok = (data: unknown): ApiResponse => ({ status: 'ok', message: 'Success', data })
  const unsupported: ApiResponse = { status: 'unsupported', message: '此状态版仅采集信息；该功能未启用' }
  const radio = row('radio', snapshot.raw.radio ? 'radio' : 'status'), simPin = row('simPin', 'status'), operator = row('operator', 'status'), provider = row('provider', 'status')
  const reg = row('registration', 'status'), reg5 = row('registration5g', 'status'), signal = row('signal', 'status')
  const offline = snapshot.adapter?.radioStates.off.includes(Number(radio.functionality)) ?? false
  const serving = parsed('serving', 'cells'), cellInfo = offline || !snapshot.sampled.cells
    ? { serving_cell: null, cells: [], technology: undefined }
    : normalizeCells(serving, parsed('neighbors', 'cells'), parsed('carriers', 'cells'))
  const plmn = operator.format === 2 && /^\d{5,6}$/.test(String(operator.operator)) ? String(operator.operator) : /^\d{5,6}$/.test(String(provider.plmn)) ? String(provider.plmn) : undefined
  const identity = serving.find(value => value.mcc)
  const network = { operator_name: provider.provider_name || (operator.format !== 2 ? operator.operator : '') || '',
    mcc: identity?.mcc ?? plmn?.slice(0, 3), mnc: identity?.mnc ?? plmn?.slice(3),
    registration_status: offline ? 'unregistered' : registration([1, 5].includes(Number(reg5.status)) ? reg5.status : reg.status),
    technology: cellInfo.technology, signal_strength: !offline && Number(signal.rssi_code) <= 31 ? Math.floor(Number(signal.rssi_code) * 100 / 31) : undefined,
    technology_preference: '',
  }
  const host = snapshot.host, net = host.net ?? {}, uptime = Number((host.uptime ?? '').split(/\s+/)[0]) || 0
  const memory = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(host.meminfo ?? '')?.[1] ?? 0) * 1024
  const total = memory('MemTotal'), available = memory('MemAvailable') || memory('MemFree')
  const load = (host.loadavg ?? '').split(/\s+/).slice(0, 3).map(Number), cores = (host.cpustat?.match(/^cpu\d+\s/gm) ?? []).length || 1
  const sensors = parsed('temperature', 'temperature').filter(value => typeof value.temperature === 'number').map(value => ({ zone: `modem-${value.sensor}`, type: `${value.sensor}`, temperature: value.temperature }))
  const stats = {
    memory: { total_bytes: total, available_bytes: available, used_bytes: total - available, cached_bytes: memory('Cached'), buffers_bytes: memory('Buffers'), used_percent: total ? (total - available) / total * 100 : 0 },
    cpu_load: { core_count: cores, load_1min: load[0] || 0, load_5min: load[1] || 0, load_15min: load[2] || 0, load_percent: Math.min(100, (load[0] || 0) * 100 / cores) },
    uptime: { uptime_seconds: uptime, idle_seconds: 0, uptime_formatted: `${Math.floor(uptime / 86400)}天${Math.floor(uptime / 3600) % 24}时${Math.floor(uptime / 60) % 60}分${Math.floor(uptime) % 60}秒` },
    system_info: { sysname: 'Linux', nodename: host.board.hostname, machine: host.machine, release: host.board.kernel, version: host.board.release?.description, full_info: host.board.model },
    temperature: sensors,
    network_speed: { interval_seconds: Math.max(0.001, (host.speed_time ?? host.time) - (host.speed_previous_time ?? host.previous_time)), interfaces: (host.counters ?? []).filter(value => value.interface !== 'lo').map(value => {
      const previous = host.previous_counters?.find(row => row.interface === value.interface), seconds = (host.speed_time ?? host.time) - (host.speed_previous_time ?? host.previous_time)
      return { interface: value.interface, logical_interfaces: interfaceAliases(host, value.interface), total_rx_bytes: value.rx, total_tx_bytes: value.tx, rx_bytes_per_sec: previous && seconds > 0 ? Math.max(0, value.rx - previous.rx) / seconds : 0, tx_bytes_per_sec: previous && seconds > 0 ? Math.max(0, value.tx - previous.tx) / seconds : 0 }
    }) },
    disk: (host.disk ?? '').split('\n').slice(1).flatMap(line => { const cols = line.trim().split(/\s+/); return cols.length >= 6 ? [{ mount_point: cols.slice(5).join(' '), fs_type: '', total_bytes: Number(cols[1]) * 1024, used_bytes: Number(cols[2]) * 1024, available_bytes: Number(cols[3]) * 1024, used_percent: Number(cols[4].replace('%', '')) }] : [] }),
    connection: connectionFromHost(host),
    usb_mode: { current_mode: null, current_mode_name: String(net.proto ?? '未知').toUpperCase(), needs_reboot: false },
  }
  const routes: Record<string, ApiResponse> = {
    '/api/adaptation': ok(snapshotCapabilities),
    '/api/device': ok({ ...row('manufacturer', 'identity'), ...row('model', 'identity'), ...row('revision', 'identity'), ...row('imei', 'identity'), powered: true, online: radio.functionality === undefined ? undefined : radio.functionality === 1, at_port: snapshot.device, protocol: net.proto }),
    '/api/network': ok(network), '/api/cells': { ...ok(cellInfo), stale: snapshot.stale, sampled_at: (snapshot.sampled.cells ?? 0) * 1000 },
    '/api/network-mode': snapshot.sampled.mode && row('mode', 'mode').mode ? ok({ mode: row('mode', 'mode').mode }) : { status: 'deferred', message: '等待网络模式快照', retry_after_ms: 2000 },
    '/api/airplane-mode': ok({ enabled: radio.functionality === 4, powered: true, online: radio.functionality === 1 }),
    '/api/roaming': ok({ is_roaming: network.registration_status === 'roaming', ...roamingPreference(row('roamingPreference', 'roaming').roam_pref) }),
    '/api/sim': ok({ present: simPin.pin_required !== undefined && !new RegExp(snapshot.adapter?.simAbsentPattern ?? '(?!)').test(snapshot.raw.status ?? ''), ...simPin,
      ...(snapshot.sim_identity ?? {}), ...row('iccid', 'sim'), ...row('imsi', 'sim'), ...row('smsCenter', 'sim'), phone_numbers: parsed('phone', 'sim').map(value => value.number).filter(Boolean), preferred_languages: [], mcc: '', mnc: '' }),
    '/api/data': ok({ active: net.up === true, pending: net.pending === true }), '/api/stats': ok(stats), '/api/connectivity': unsupported,
    '/api/ims/status': unsupported, '/api/qos': unsupported,
  }
  // An absent modem group is deferred, never interpreted as radio-off/SIM-out.
  for (const path of ['/api/device', '/api/network', '/api/airplane-mode', '/api/roaming', '/api/sim']) {
    if (!snapshot.sampled.status || (path === '/api/device' && !snapshot.sampled.identity)) routes[path] = { status: 'deferred', message: '等待 Modem 快照', retry_after_ms: 10000 }
  }
  if (!offline && !snapshot.sampled.cells) routes['/api/cells'] = { status: 'deferred', message: '等待小区快照', retry_after_ms: 10000 }
  if (simPin.pin_required === undefined && !new RegExp(snapshot.adapter?.simAbsentPattern ?? '(?!)').test(snapshot.raw.status ?? '')) routes['/api/sim'] = { status: 'deferred', message: '等待 SIM 状态', retry_after_ms: 10000 }
  if (radio.functionality === undefined) routes['/api/airplane-mode'] = { status: 'deferred', message: '等待射频状态', retry_after_ms: 10000 }
  // Explicit absence is final, unlike a supported read awaiting its first sample.
  if (snapshot.adapter) for (const [path, name] of Object.entries({ '/api/network-mode': 'mode', '/api/airplane-mode': 'radio', '/api/roaming': 'roamingPreference', '/api/cells': 'serving', '/api/sim': 'simPin' })) {
    if (!operationSupported(snapshot.adapter, name)) routes[path] = unsupportedResult(snapshot.adapter.unsupportedOperations?.[name] || name)
  }
  return routes
}
