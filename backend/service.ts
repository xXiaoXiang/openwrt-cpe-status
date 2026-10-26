import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { ApiResponse, Scalar } from '../shared/adapter.ts'
import { normalizeCells } from './cells.ts'
import { csv, renderCommand } from './parser.ts'
import { Engine } from './engine.ts'
import { OpenWrtHost } from './host.ts'
import { EuiccService } from './lpac.ts'
import type { ServiceConfig } from './config.ts'
import { encodeSms, parseSmsList, type SmsRecord } from './sms.ts'
import { roamingPreference } from '../shared/roaming.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const text = (value: unknown, name: string, pattern = /^[^\x00-\x1f]{1,1024}$/) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid ${name}`)
  return value
}
const boolean = (value: unknown) => { if (typeof value !== 'boolean') throw new Error('Expected boolean'); return value }
const registrationStatus = (value: Scalar | undefined) => ({ 0: 'unregistered', 1: 'registered', 2: 'searching', 3: 'denied', 4: 'unknown', 5: 'roaming', 8: 'emergency' }[Number(value)] ?? 'unknown')

export class ModemService {
  private euicc: EuiccService
  private endpointCache = new Map<string, { time: number; data?: unknown; pending?: Promise<unknown> }>()
  private interval = 5000
  private sent: SmsRecord[] = []
  constructor(readonly engine: Engine, private host: OpenWrtHost, private config: ServiceConfig, readonly demo = false) {
    this.euicc = new EuiccService(engine, config.lpac)
  }
  private async row(name: string) { return (await this.engine.read(name)).values[0] ?? {} }
  private async optional(name: string) { try { return await this.row(name) } catch { return {} } }
  private async cached<T>(name: string, ttl: number, work: () => Promise<T>): Promise<T> {
    const cached = this.endpointCache.get(name)
    if (cached?.data !== undefined && Date.now() - cached.time < ttl) return cached.data as T
    if (cached?.pending) return cached.pending as Promise<T>
    const entry = { time: 0, data: cached?.data, pending: undefined as Promise<unknown> | undefined }
    this.endpointCache.set(name, entry)
    entry.pending = work().then(data => { entry.time = Date.now(); entry.data = data; return data }).finally(() => { entry.pending = undefined })
    return entry.pending as Promise<T>
  }
  private async cells() {
    const [primary, secondary, carriers] = await Promise.all([this.engine.read('serving'), this.engine.read('neighbors').catch(() => null), this.engine.read('carriers').catch(() => null)])
    const result = normalizeCells(primary.values, secondary?.values ?? [], carriers?.values ?? [])
    return { ...result, stale: primary.stale || secondary?.stale === true, sampled_at: primary.sampledAt }
  }
  private async network() {
    const [registration, registration5g, operator, signal, provider] = await Promise.all([this.row('registration'), this.optional('registration5g'), this.row('operator'), this.optional('signal'), this.optional('provider')])
    const registered5g = [1, 5].includes(Number(registration5g.status))
    const status = registered5g ? registration5g : registration
    // QENG is shared with /cells; never use COPS AcT=13 alone
    // to claim active NR secondary connectivity.
    const serving = await this.engine.read('serving').catch(() => null)
    const cells = normalizeCells(serving?.values ?? [], [])
    const identity = serving?.values.find(row => row.mcc)
    const numericOperator = operator.format === 2 && typeof operator.operator === 'string' && /^\d{5,6}$/.test(operator.operator) ? operator.operator : undefined
    return {
      operator_name: provider.provider_name || (operator.format !== 2 ? operator.operator ?? '' : ''), registration_status: registrationStatus(status.status),
      technology_preference: (await this.optional('mode')).mode ?? '',
      technology: cells.technology ?? (registered5g ? 'NR' : [7, 10, 13].includes(Number(operator.act)) ? 'LTE' : undefined),
      signal_strength: signal.rssi_code !== undefined && Number(signal.rssi_code) <= 31 ? Math.round(Number(signal.rssi_code) / 31 * 100) : undefined,
      mcc: identity?.mcc ?? numericOperator?.slice(0, 3), mnc: identity?.mnc ?? numericOperator?.slice(3),
      selection_mode: operator.mode, stale: serving?.stale,
    }
  }
  private async device() {
    const [manufacturer, model, revision, imei, radio] = await Promise.all(['manufacturer', 'model', 'revision', 'imei', 'radio'].map(name => this.row(name)))
    return { ...manufacturer, ...model, ...revision, ...imei, powered: true, online: radio.functionality === 1 }
  }
  private async sim() {
    let pin: Record<string, Scalar>
    try { pin = await this.row('simPin') }
    catch (error) { if (/\+CME ERROR:\s*10(?:\D|$)|SIM not inserted/i.test(String(error))) return { present: false }; throw error }
    if (pin.pin_required !== 'READY') return { present: true, pin_required: pin.pin_required, iccid: '', imsi: '', phone_numbers: [], sms_center: '', mcc: '', mnc: '', preferred_languages: [] }
    const [iccid, imsi, phone, center] = await Promise.all([this.row('iccid'), this.row('imsi'), this.optional('phone'), this.optional('smsCenter')])
    return { present: true, ...pin, ...iccid, ...imsi, ...center, phone_numbers: phone.number ? [phone.number] : [], mcc: String(imsi.imsi).slice(0, 3), mnc: '', preferred_languages: [], note: 'IMSI MNC length cannot be inferred safely; serving PLMN comes from QENG/COPS' }
  }
  private async airplane(enabled: boolean) {
    if (!this.engine.allowWrites) throw new Error('Unsupported: writes disabled')
    const definition = this.engine.definition('airplaneSet')
    return this.engine.exclusive(async () => {
      this.engine.writing = true
      const deadline = Date.now() + 60_000
      let lastError = ''
      try {
        try { await this.engine.transport.exchange(renderCommand(definition, { functionality: enabled ? '4' : '1' }), 15_000) }
        catch (error) { lastError = String(error) }
        while (Date.now() < deadline) {
          try {
            const row = (await this.engine.fresh('radio', Math.min(5000, deadline - Date.now())))[0]
            if (row?.functionality === (enabled ? 4 : 1)) return { enabled, powered: true, online: !enabled }
          } catch (error) { lastError = String(error) }
          await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())))
        }
        throw new Error(`ModemReadDeferred: airplane mode not confirmed within 60s; ${lastError}`)
      } finally { this.engine.cache.invalidate(); this.engine.writing = false }
    })
  }
  private async sms() {
    return this.cached('sms', 6000, () => this.engine.exclusive(async () => {
      if (this.engine.writing) throw new Error('ModemReadDeferred: modem is changing state')
      await this.engine.transport.exchange(this.engine.definition('smsPduMode').command, 5000)
      return parseSmsList(await this.engine.transport.exchange(this.engine.definition('smsList').command, 15_000))
    }))
  }
  private async bandState() {
    const [lte, nsa, sa, capability] = await Promise.all(['lteBands', 'nsaBands', 'nrBands', 'bandCapabilities'].map(name => this.engine.read(name)))
    const list = (value: Scalar | undefined) => typeof value === 'string' ? value.split(':').map(Number).filter(band => Number.isInteger(band) && band > 0) : []
    const saved = await readFile(`${this.config.stateDirectory}/bands.json`, 'utf8').then(JSON.parse).catch(() => null)
    return { lte: list(lte.values[0]?.bands), nsa: list(nsa.values[0]?.bands), sa: list(sa.values[0]?.bands), supported: Object.fromEntries(capability.values.map(row => [String(row.rat), list(row.bands)])), saved_baseline: saved }
  }
  private async setBands(body: Record<string, unknown>) {
    if (!this.engine.allowWrites) throw new Error('Unsupported: writes disabled')
    const current = await this.bandState()
    const baseline = current.saved_baseline ?? { lte: current.lte, nsa: current.nsa, sa: current.sa }
    const requested = body.operation === 'restore' ? baseline : body
    const values: Record<string, number[]> = {}
    for (const [key, rat] of [['lte', 'lte_band'], ['nsa', 'nsa_nr5g_band'], ['sa', 'nr5g_band']]) {
      const bands: unknown = requested[key]
      if (!Array.isArray(bands) || !bands.length || bands.some(band => !Number.isInteger(band) || !current.supported[rat]?.includes(band))) throw new Error(`Invalid or unsupported ${key} bands`)
      values[rat] = [...new Set(bands)]
    }
    await mkdir(this.config.stateDirectory, { recursive: true })
    if (!current.saved_baseline) await writeFile(`${this.config.stateDirectory}/bands.json`, JSON.stringify(baseline), { mode: 0o600 })
    await this.engine.exclusive(async () => {
      this.engine.writing = true
      try {
        for (const [rat, bands] of Object.entries(values)) {
          await this.engine.transport.exchange(renderCommand(this.engine.definition('bandSet'), { rat, bands: bands.join(':') }), 15_000)
        }
      } finally { this.engine.cache.invalidate(); this.engine.writing = false }
    })
    const confirmed = await this.bandState()
    for (const [key, rat] of [['lte', 'lte_band'], ['nsa', 'nsa_nr5g_band'], ['sa', 'nr5g_band']] as const) if ([...confirmed[key]].sort().join(':') !== [...values[rat]].sort().join(':')) throw new Error('Band write not confirmed; some settings may already have changed')
    return confirmed
  }
  async dispatch(method: string, path: string, body: Record<string, unknown> = {}): Promise<ApiResponse | string> {
    const url = new URL(path, 'http://localhost'), route = url.pathname
    const ok = (data: unknown, message = 'Success'): ApiResponse => ({ status: 'ok', message, data })
    if (method === 'GET') {
      switch (route) {
        case '/api/health': return ok({ adapter: this.engine.adapter.id, demo: this.demo })
        case '/api/adaptation': return ok({ id: this.engine.adapter.id, firmware_baseline: this.engine.adapter.firmwareBaseline, demo: this.demo, writes_enabled: this.engine.allowWrites, lpac_enabled: this.config.lpac.enabled, data_control: !this.demo, roaming_policy: true, roaming_scope: 'registration', ims: false, commands: Object.fromEntries(Object.entries(this.engine.adapter.commands).map(([name, operation]) => [name, { command: operation.command, kind: operation.kind, ttl_ms: operation.ttlMs, timeout_ms: operation.timeoutMs, enabled: !operation.requiresValidation || this.config.validatedOperations.includes(name), reference: operation.reference }])), documents: this.engine.adapter.documents })
        case '/api/device': return ok(await this.device())
        case '/api/sim': return ok(await this.sim())
        case '/api/network': return ok(await this.network())
        case '/api/cells': { const cells = await this.cells(); return { ...ok(cells), stale: cells.stale, sampled_at: cells.sampled_at } }
        case '/api/location/cell-info': { const cells = await this.cells(); return ok({ available: !!cells.serving_cell, serving_cell: cells.serving_cell, cells: cells.cells, source: 'shared QENG snapshot' }) }
        case '/api/airplane-mode': { const radio = await this.row('radio'); return ok({ enabled: radio.functionality === 4, powered: true, online: radio.functionality === 1 }) }
        case '/api/roaming': return ok({ is_roaming: (await this.network()).registration_status === 'roaming', ...roamingPreference((await this.row('roamingPreference')).roam_pref) })
        case '/api/data': return ok(await this.cached('netifd', 2000, () => this.host.status()))
        case '/api/apn': {
          const [contexts, active] = await Promise.all([this.engine.read('contexts'), this.engine.read('contextsActive').catch(() => null)])
          return ok({ contexts: contexts.values.map(row => {
            const state = active?.values.find(value => value.cid === row.cid)
            return { path: `cid:${row.cid}`, cid: row.cid, name: `PDP ${row.cid}`, type: 'internet', access_point_name: row.apn, protocol: row.protocol === 'IPV4V6' ? 'dual' : String(row.protocol).toLowerCase(), active: state?.active ?? null, active_known: !!state }
          }), host_note: 'AT PDP definitions do not replace the APN/authentication in the netifd UCI interface configuration' })
        }
        case '/api/radio-mode': { const mode = (await this.row('mode')).mode; return ok({ mode: mode === 'LTE' ? 'lte' : mode === 'NR5G' ? 'nr' : mode === 'AUTO' ? 'auto' : 'mixed', technology_preference: mode }) }
        case '/api/band-lock': return ok(await this.bandState())
        case '/api/network/operators': return ok({ operators: [], current: await this.row('operator'), scan_required: true })
        case '/api/network/operators/scan': {
          const raw = String((await this.row('operatorScan')).operators_raw ?? '')
          const operators = [...raw.matchAll(/\(([^()]*)\)/g)].flatMap(match => {
            const row = csv(match[1]); if (!/^\d{5,6}$/.test(row[3] ?? '')) return []
            return [{ path: row[3], name: row[1], status: ({ '1': 'available', '2': 'current', '3': 'forbidden' } as Record<string, string>)[row[0]] ?? 'unknown', mcc: row[3].slice(0, 3), mnc: row[3].slice(3), technologies: [row[4]] }]
          })
          return ok({ operators })
        }
        case '/api/qos': {
          const values = (await this.engine.read('qos')).values, row = values.find(row => row.cid === 1) ?? values[0]
          if (!row) throw new Error('Unsupported: network did not report QoS')
          return ok({ qci: row.qci, dl_speed: Number(row.dl_ambr || row.dl_mbr || row.dl_gbr || 0), ul_speed: Number(row.ul_ambr || row.ul_mbr || row.ul_gbr || 0) })
        }
        case '/api/ims/status': throw new Error('Unsupported: no documented IMS registration query in this adapter; never infer VoLTE from an IMS APN')
        case '/api/stats': return ok(await this.cached('stats', 2000, async () => {
          const [stats, modem] = await Promise.all([this.host.stats(), this.engine.read('temperature').catch(() => null)])
          return { ...stats, temperature: (modem?.values ?? []).flatMap(row => typeof row.temperature === 'number' ? [{ zone: `modem-${row.sensor}`, type: `${this.engine.adapter.manufacturer} ${row.sensor}`, temperature: row.temperature }] : []) }
        }))
        case '/api/connectivity': return ok(await this.cached('connectivity', 6000, async () => ({ ipv4: await this.host.ping(false), ipv6: await this.host.ping(true) })))
        case '/api/network/nitz': return ok({ ...(await this.row('clock')), available: true, source: 'modem clock; not proof of NITZ synchronization' })
        case '/api/sms/list': case '/api/sms/conversation': case '/api/sms/stats': {
          const messages = [...await this.sms(), ...this.sent]
          if (route.endsWith('stats')) return ok({ total: messages.length, incoming: messages.filter(row => row.direction === 'incoming').length, outgoing: messages.filter(row => row.direction === 'outgoing').length })
          const selected = route.endsWith('conversation') ? messages.filter(row => row.phone_number === url.searchParams.get('phone_number')) : messages
          const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0))
          const limit = Math.max(1, Math.min(500, Math.trunc(Number(url.searchParams.get('limit')) || 100)))
          return ok(selected.slice(offset, offset + limit))
        }
        case '/api/euicc': return ok(await this.euicc.info())
        case '/api/euicc/notifications': return ok(await this.euicc.invoke(['notification', 'list'], false, 20_000))
        case '/api/refresh/config': return ok({ interval_ms: this.interval })
      }
    }
    if (method === 'POST') {
      switch (route) {
        case '/api/refresh/heartbeat': return ok({ interval_ms: this.interval })
        case '/api/refresh/config': { const value = Number(body.interval_ms); if (![0, 1000, 2000, 3000, 5000, 10000].includes(value)) throw new Error('Invalid refresh interval'); this.interval = value; return ok({ interval_ms: value }) }
        case '/api/airplane-mode': return ok(await this.airplane(boolean(body.enabled)))
        case '/api/data': {
          if (!this.engine.allowWrites) throw new Error('Unsupported: writes disabled')
          const data = await this.engine.exclusive(async () => { this.engine.writing = true; try { return await this.host.setData(boolean(body.active)) } finally { this.engine.writing = false; this.endpointCache.delete('netifd') } })
          return ok(data)
        }
        case '/api/roaming': {
          if (!this.engine.allowWrites) throw new Error('Unsupported: hardware writes are disabled')
          const preference = boolean(body.allowed) ? '255' : '1'
          const confirmed = await this.engine.exclusive(async () => {
            this.engine.writing = true
            try {
              const definition = this.engine.definition('roamingSet')
              await this.engine.transport.exchange(renderCommand(definition, { preference }), definition.timeoutMs)
              const state = (await this.engine.fresh('roamingPreference'))[0]
              if (state?.roam_pref !== Number(preference)) throw new Error('Roaming preference not confirmed')
              return roamingPreference(state.roam_pref)
            } finally { this.engine.cache.invalidate(['roamingPreference']); this.engine.writing = false }
          })
          return ok({ is_roaming: (await this.network()).registration_status === 'roaming', ...confirmed })
        }
        case '/api/apn': {
          if (body.username || body.password || (body.auth_method && body.auth_method !== 'none')) throw new Error('Unsupported: configure APN credentials through OpenWrt network interface settings')
          const cid = String(body.cid ?? String(body.path ?? '').replace('cid:', ''))
          await this.engine.write('apnSet', { cid, protocol: ({ dual: 'IPV4V6', ip: 'IP', ipv6: 'IPV6' } as Record<string, string>)[String(body.protocol)] ?? body.protocol, apn: body.apn ?? body.access_point_name })
          const row = (await this.engine.read('contexts')).values.find(row => String(row.cid) === cid)
          if (row?.apn !== (body.apn ?? body.access_point_name)) throw new Error('APN not confirmed')
          return ok(row, 'Modem PDP APN 已保存；请同时核对 OpenWrt 接口的 APN')
        }
        case '/api/radio-mode': {
          const mode = ({ auto: 'AUTO', lte: 'LTE', nr: 'NR5G' } as Record<string, string>)[String(body.mode)]
          if (!mode) throw new Error('Invalid radio mode')
          await this.engine.write('modeSet', { mode })
          if ((await this.row('mode')).mode !== mode) throw new Error('Radio preference not confirmed')
          return ok({ mode: body.mode, technology_preference: mode })
        }
        case '/api/band-lock': return ok(await this.setBands(body))
        case '/api/network/register-auto': await this.engine.write('operatorAuto'); return ok(await this.row('operator'), '自动选网命令已完成；网络注册仍可能需要1～2分钟')
        case '/api/network/register-manual': await this.engine.write('operatorManual', { plmn: text(body.mccmnc, 'PLMN', /^\d{5,6}$/) }); return ok(await this.row('operator'))
        case '/api/at': {
          if (!this.engine.allowWrites) throw new Error('Unsupported: AT console is disabled when writes are disabled')
          const command = text(body.cmd, 'AT command', /^AT[^\r\n\x00-\x1f\x7f]{0,1022}$/i)
          const reply = await this.engine.exclusive(async () => { this.engine.writing = true; try { return await this.engine.transport.exchange(command, 15_000) } finally { this.engine.cache.invalidate(); this.engine.writing = false } })
          return reply
        }
        case '/api/sms/send': {
          if (!this.engine.allowWrites) throw new Error('Unsupported: writes disabled')
          const phone = text(body.phone_number, 'phone number'), content = text(body.content, 'SMS content')
          const encoded = encodeSms(phone, content)
          const reply = await this.engine.exclusive(async () => {
            this.engine.writing = true
            try {
              await this.engine.transport.exchange(this.engine.definition('smsPduMode').command, 5000)
              return await this.engine.transport.exchange(renderCommand(this.engine.definition('smsSend'), { length: String(encoded.length) }), 120_000, encoded.pdu)
            } finally { this.engine.writing = false; this.endpointCache.delete('sms') }
          })
          if (!/\+CMGS:\s*\d+/.test(reply)) throw new Error('Modem did not confirm SMS submission')
          const id = Date.now(); this.sent.push({ id, direction: 'outgoing', phone_number: phone, content, timestamp: new Date().toISOString(), status: 'sent' })
          return ok({ db_id: id, message_path: `cmgs:${id}` }, '已确认提交给 Modem；不代表对方已接收')
        }
        case '/api/sms/clear': {
          for (const message of await this.sms()) await this.engine.write('smsDelete', { index: String(message.id) })
          this.sent = []; this.endpointCache.delete('sms'); return ok({})
        }
        case '/api/euicc/profile/enable': {
          const iccid = text(body.iccid, 'ICCID', /^\d{18,22}$/)
          await this.euicc.invoke(['profile', 'enable', iccid, this.euicc.refreshMode()])
          const profiles = await this.euicc.invoke(['profile', 'list'], false, 20_000) as { iccid: string; profileState: string }[]
          if (!Array.isArray(profiles) || !profiles.some(row => row.iccid === iccid && row.profileState === 'enabled')) throw new Error('LPAC did not confirm target profile enabled; refresh the profile list')
          // Do not block the UI on long COPS=0; the serialized write owns the port
          // and readers keep cached values/defer until it completes.
          void this.engine.write('operatorAuto').catch(error => console.warn('Post-profile automatic selection:', String(error)))
          return ok({ iccid, profiles, network_selection_submitted: true, network_selection_pending: true }, 'Profile 已确认切换，已提交自动选网；请等待1～2分钟')
        }
        case '/api/euicc/profile/delete': { const iccid = text(body.iccid, 'ICCID', /^\d{18,22}$/); await this.euicc.invoke(['profile', 'delete', iccid]); return ok({ iccid }) }
        case '/api/euicc/profile/nickname': { const iccid = text(body.iccid, 'ICCID', /^\d{18,22}$/); const nickname = typeof body.nickname === 'string' ? body.nickname : ''; if (Array.from(nickname).length > 32 || /\p{Cc}/u.test(nickname)) throw new Error('Invalid nickname'); await this.euicc.invoke(['profile', 'nickname', iccid, nickname]); return ok({ iccid, nickname }) }
        case '/api/euicc/profile/download': {
          const args = ['profile', 'download']
          if (body.activation_code) args.push('-a', text(body.activation_code, 'activation code'))
          else args.push('-s', text(body.smdp_address, 'SM-DP+'), '-m', text(body.matching_id, 'matching ID'))
          for (const [key, flag] of [['confirmation_code', '-c'], ['imei', '-i']]) if (body[key]) args.push(flag, text(body[key], key))
          const data = await this.euicc.invoke(args)
          return JSON.stringify({ type: 'complete', success: true, message: '下载完成', result: { code: 0, message: 'success', data } }) + '\n'
        }
        case '/api/euicc/notifications/process': case '/api/euicc/notifications/remove': {
          const action = route.endsWith('process') ? 'process' : 'remove'
          if (body.all === true) {
            const notifications = await this.euicc.invoke(['notification', 'list'], false, 20_000) as { seqNumber: number }[]
            for (const row of notifications) await this.euicc.invoke(['notification', action, String(row.seqNumber)])
            return ok(action === 'remove' ? { removed: notifications.map(row => row.seqNumber), failed: [], skipped: 0 } : {})
          }
          const sequence = Number(body.seq_number)
          if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid notification sequence')
          await this.euicc.invoke(['notification', action, String(sequence)])
          return ok(action === 'remove' ? { removed: [sequence], failed: [], skipped: 0 } : {})
        }
        case '/api/euicc/refresh-sim': throw new Error('Unsupported: RM500Q SIM refresh requires a documented APDU/reset sequence; do not reuse UDX710 AT commands')
      }
    }
    throw new Error(`Unsupported: ${method} ${route}`)
  }
}
