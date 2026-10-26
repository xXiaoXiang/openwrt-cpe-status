import { rm500qProfile } from '../adapters/rm500q-profile.ts'
import { parseReply } from '../backend/parser.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { once } from 'node:events'
import { r13Snapshot, r13NsaCells } from './fixtures/rm500q-r13.ts'

// Local integration harness for the generated LuCI view. Real LuCI/rpcd and USB
// behavior still require a router; this checks React, RPC envelopes and tab reuse.
const lite = process.env.CPE_STATUS_TEST === '1'
const output = resolve(lite ? 'build/browser-status-lite' : 'build/browser-smoke')
await mkdir(output, { recursive: true })
const daemon = spawn(process.execPath, ['build/daemon.mjs', '--demo', '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const origin = await new Promise<string>((resolve, reject) => {
  let stdout = ''
  const timer = setTimeout(() => reject(new Error('Demo startup timed out')), 10000)
  daemon.stdout.on('data', part => {
    stdout += part.toString()
    const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)
    if (match) { clearTimeout(timer); resolve(match[0]) }
  })
  daemon.on('error', error => { clearTimeout(timer); reject(error) })
  daemon.stderr.on('data', part => process.stderr.write(part))
})
const generatedView = await readFile(lite ? 'build/openwrt-status-package/files/www/luci-static/resources/view/modem/cpe-status.js' : 'build/openwrt-package/files/www/luci-static/resources/view/openwrt-modem/cpe-status.js', 'utf8')
const menu = JSON.parse(await readFile(lite ? 'build/openwrt-status-package/files/usr/share/luci/menu.d/luci-app-cpe-status.json' : 'build/openwrt-package/files/usr/share/luci/menu.d/luci-app-openwrt-modem.json', 'utf8'))
assert.deepEqual(Object.keys(menu), ['admin/modem', 'admin/modem/cpe-status'])
const rpcRequests: string[] = []
const roamingWrites: string[] = []
const controlWrites: string[] = []
const bandWrites: string[][] = []
const radioWrites: string[][] = []
const radioJobs = new Map<string, { params: string[]; polls: number }>()
const cellLocks = { lte: { status: 'ok', count: 0, cells: [] as object[], raw: '+QNWLOCK: "common/4g",0' }, nr: { status: 'ok', count: 0, cells: [] as object[], raw: '+QNWLOCK: "common/5g",0' }, sampled_at: 1792427000 }
let rejectNrLock = true
let staleLockReads = false, staleLockReadCount = 0
let bandReadCount = 0, scanWrites = 0, scanPolls = 0, scanPending = false, rejectScan = false
let scanData: { raw: string; sampled_at: number } | undefined
let operatorJob: string[] | undefined, operatorPolls = 0, rejectOperatorScan = false
const operatorWrites: string[][] = []
let operatorData: { raw: string; sampled_at: number } | undefined = { raw: '+COPS: (1,"OLD NETWORK","OLD","46001",7)\nOK\n', sampled_at: 1792426000 }
const operatorState = { mode: 0, operator: '45412', plmn: '45412', registered: true, registration: 5, sampled_at: 1792427000 }
const bandJobs = new Map<string, { target: typeof bandState.enabled; polls: number }>()
const bandState = { model: 'RM500Q-GL', supported: { lte: [1, 3, 7, 8, 20, 28, 38, 40, 41, 66, 71], sa: [41, 77, 78, 79], nsa: [41, 77, 78, 79] }, enabled: { lte: [3, 7], sa: [78], nsa: [78] }, sampled_at: 1792427000 }
const controlJobs = new Map<string, { kind: string; target: boolean; polls: number; done?: boolean }>()
let resumeData = false
let roamingFailure = false
let roamingWriteAccess = true
let apnSettings = { apn: 'internet', pdptype: 'ipv4', auth: 'none', username: '', password: '' }
let apnWrites = 0
let smsEmpty = false, smsReads = 0
let smsPath = '/etc/cpe-status/sms'
const messageFixture = [{ id: 1, direction: 'incoming', phone_number: '+85212345678', content: '短信测试', timestamp: '2026-10-26T12:00:00Z', status: 'received' }]
const liteSnapshot = structuredClone(r13Snapshot)
liteSnapshot.raw.mode = '+QNWPREFCFG: "mode_pref",AUTO\n'
liteSnapshot.sampled.mode = 1792427000
liteSnapshot.host.network_interface = 'wwan'
liteSnapshot.host.net['ipv4-address'] = []
liteSnapshot.host.net['ipv6-address'] = []
liteSnapshot.host.networks = [
  { interface: 'wwan_4', up: true, dynamic: true, l3_device: 'wwan0', 'ipv4-address': [{ address: '192.0.2.2', mask: 26 }] },
  { interface: 'wwan_6', up: true, dynamic: true, l3_device: 'wwan0', 'ipv6-address': [{ address: '2001:db8::2', mask: 64 }], 'ipv6-prefix': [{ address: '2001:db8:100::', mask: 56 }] },
  { interface: 'lan', up: true, l3_device: 'br-lan' },
]
liteSnapshot.host.counters.push({ interface: 'br-lan', rx: 1000, tx: 2000 }, { interface: 'eth0', rx: 1000, tx: 2000 })
const harness = createServer(async (req, res) => {
  try {
    if (req.url === '/luci') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light;background:#fff}:root[data-darkmode="true"]{color-scheme:dark;background:#141414}body{background:inherit;margin:8px auto;width:calc(100% - 16px);max-width:1180px;font-family:sans-serif}.cbi-tabmenu{display:flex;gap:12px;padding:8px;list-style:none;overflow:auto;white-space:nowrap}.cbi-tab a{font-weight:bold;border-bottom:3px solid #06a}iframe{display:block}</style></head><body><script>
      const scheme=matchMedia('(prefers-color-scheme: dark)');const syncTheme=()=>document.documentElement.setAttribute('data-darkmode',String(scheme.matches));scheme.addEventListener('change',syncTheme);syncTheme();
      window.L={env:{sessionid:'local-test',ubuspath:'/ubus/'},resource:path=>'/ui/index.html'};
      function E(tag,attrs,children){const el=document.createElement(tag);Object.entries(attrs||{}).forEach(([k,v])=>{if(k==='click')el.addEventListener(k,v);else el.setAttribute(k,v)});for(const c of Array.isArray(children)?children:[children])if(c!=null)el.append(c);return el}
      document.body.append(new Function('view','L','E',${JSON.stringify(generatedView)})({extend:x=>x},L,E).render());
      </script></body></html>`)
      return
    }
    if (req.url === '/ubus/') {
      let raw = ''; for await (const part of req) raw += part.toString()
      const rpc = JSON.parse(raw)
      if (lite) {
        assert.equal(rpc.params[0], 'local-test')
        if (rpc.params[1] === 'session') {
          assert.equal(rpc.params[2], 'access')
          assert.deepEqual(rpc.params[3], { scope: 'access-group', object: 'luci-app-cpe-status', function: 'write' })
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { access: roamingWriteAccess }] }))
          return
        }
        assert.equal(rpc.params[1], 'file')
        assert.equal(rpc.params[2], 'exec')
        const sendControl = (value: unknown) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { code: 0, stdout: JSON.stringify(value), stderr: '' }] }))
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-snapshot' && rpc.params[3].params[0] === 'profile') { sendControl({ status: 'ok', data: rm500qProfile }); return }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-apn') { sendControl({ status: 'ok', data: { settings: apnSettings, active: true, active_apn: apnSettings.apn, active_protocol: 'IP', sampled_at: 1792427000, logs: apnWrites ? ['+0s 保存配置', '+1s 连接成功'] : [] } }); return }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-speed-settings') { sendControl({ wwan: { status: 'ready', apn: 'internet', carrier: 'CSL' } }); return }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-messaging') {
          const params = rpc.params[3].params
          if (params[0] === 'at') { sendControl({ status: 'ok', data: params[1] === 'AT+CGSN' ? '123456789012345\nOK\n' : '+CSQ: 20,99\nOK\n' }); return }
          if (params[0] === 'config') { if (params[1]) smsPath = params[1]; sendControl({ status: 'ok', data: { path: smsPath } }); return }
          smsReads++; await new Promise(resolve => setTimeout(resolve, 250))
          sendControl({ status: 'ok', data: smsEmpty ? [] : messageFixture }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-bands') { bandReadCount++; sendControl({ status: 'ok', data: bandState }); return }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-operators') {
          if (['current','state'].includes(rpc.params[3].params[0])) { sendControl({ status: 'ok', state: operatorState, refreshing: false, busy: false }); return }
          if (operatorJob && ++operatorPolls >= 3) {
            if (operatorJob[0] === 'operator-scan' && !rejectOperatorScan) operatorData = { raw: '+COPS: (1,"CUniq","CUniq","45403",7),(2,"UNICOM","UNICOM","45400",7),,(0-4),(0-2)\nOK\n', sampled_at: 1792427000 }
            else if (operatorJob[0] === 'operator') { operatorState.mode = operatorJob[1] === 'auto' ? 0 : 1; operatorState.plmn = operatorJob[1] === 'auto' ? '45400' : operatorJob[1]; operatorState.operator = operatorState.plmn }
            operatorJob = undefined
          }
          sendControl({ status: operatorJob ? 'deferred' : rejectOperatorScan ? 'error' : 'ok', busy: !!operatorJob, state: operatorState, data: operatorData ? { ...operatorData, records: parseReply(rm500qProfile.commands.operatorScan, operatorData.raw) } : undefined, message: operatorJob ? '运营商操作进行中' : rejectOperatorScan ? '运营商扫描失败，保留原列表' : '已读取运营商状态' }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-scan-result') {
          if (scanPending && ++scanPolls >= 2) {
            scanPending = false
            if (!rejectScan) scanData = { raw: '+QSCAN: "LTE",454,00,1400,366,-95,-13,16,121,31E7C20,452,100,3\n+QSCAN: "LTE",454,00,3349,323,-107,-9,16,121,31E7C20,452,100,7\n+QSCAN: "NR5G",454,00,632352,41,-86,-10,33,1,31E7C20,452,273,78\nOK\n', sampled_at: 1792427000 }
          }
          sendControl({ status: scanPending ? 'deferred' : rejectScan ? 'error' : 'ok', scanning: scanPending, data: scanData ? { ...scanData, records: parseReply(rm500qProfile.commands.cellScan, scanData.raw) } : undefined,
            message: scanPending ? '正在扫描 LTE / NR 小区' : rejectScan ? '扫描超时，保留当前列表' : scanData ? '扫描完成，列表已固定' : '' }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-cell-locks') {
          if (staleLockReads) staleLockReadCount++
          sendControl({ status: 'ok', data: staleLockReads ? {
            ...cellLocks, stale: true,
            ...Object.fromEntries(['lte', 'nr'].map(rat => [rat, { status: 'error', cells: [], raw: '', previous: cellLocks[rat as 'lte' | 'nr'] }])),
          } : cellLocks }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-control') {
          assert.ok(roamingWriteAccess)
          if (rpc.params[3].params[0] === 'apn') { apnWrites++; apnSettings = JSON.parse(rpc.params[3].params[1]); sendControl({ status: 'pending', job_id: '1792427000-999' }); return }
          if (['operator', 'operator-scan'].includes(rpc.params[3].params[0])) {
            operatorJob = rpc.params[3].params; operatorWrites.push([...operatorJob!]); operatorPolls = 0
            sendControl({ status: 'pending', job_id: '5000-' + operatorWrites.length }); return
          }
          if (rpc.params[3].params[0] === 'scan') {
            assert.deepEqual(rpc.params[3].params, ['scan']); scanWrites++; scanPending = true; scanPolls = 0
            sendControl({ status: 'pending', job_id: '4000-1' }); return
          }
          if (['mode', 'cell'].includes(rpc.params[3].params[0])) {
            const params = rpc.params[3].params as string[]
            radioWrites.push(params)
            const id = '3000-' + radioWrites.length
            radioJobs.set(id, { params, polls: 0 })
            sendControl({ status: 'pending', job_id: id }); return
          }
          if (rpc.params[3].params[0] === 'bands') {
            const params = rpc.params[3].params as string[]
            assert.equal(params.length, 4)
            bandWrites.push(params)
            const id = '2000-' + bandWrites.length
            bandJobs.set(id, { target: Object.fromEntries(['lte', 'sa', 'nsa'].map((key, i) => [key, params[i + 1].split(':').map(Number)])) as typeof bandState.enabled, polls: 0 })
            sendControl({ status: 'pending', job_id: id }); return
          }
          const [kind, target] = rpc.params[3].params
          assert.ok(['data', 'airplane'].includes(kind) && ['0', '1'].includes(target))
          controlWrites.push(kind + ':' + target)
          const id = '1000-' + controlWrites.length
          controlJobs.set(id, { kind, target: target === '1', polls: 0 })
          sendControl({ status: 'pending', job_id: id }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-control-result') {
          if (rpc.params[3].params[0] === '1792427000-999') { sendControl({ status: 'ok', data: { settings: apnSettings, active: true, active_apn: apnSettings.apn, logs: ['+0s 保存配置', '+1s 连接成功'] }, message: 'APN 已保存，wwan 已重新连接' }); return }
          const radio = radioJobs.get(rpc.params[3].params[0])
          if (radio) {
            if (++radio.polls === 1) { sendControl({ status: 'pending' }); return }
            const [kind, rat, operation, arfcn, pci, band, scs] = radio.params
            if (kind === 'mode') {
              liteSnapshot.raw.mode = `+QNWPREFCFG: "mode_pref",${rat}\n`
              sendControl({ status: 'ok', snapshot: liteSnapshot, data: { mode: rat }, message: '模块已确认网络模式' }); return
            }
            if (rat === 'nr' && operation === 'lock' && rejectNrLock) {
              sendControl({ status: 'error', data: cellLocks, message: '小区设置失败：+CME ERROR: 901' }); return
            }
            const target = cellLocks[rat as 'lte' | 'nr']
            target.count = operation === 'unlock' ? 0 : 1
            target.cells = operation === 'unlock' ? [] : [{ rat, arfcn: Number(arfcn), pci: Number(pci), ...(rat === 'nr' ? { band: Number(band), scs_khz: Number(scs) } : {}) }]
            sendControl({ status: 'ok', data: cellLocks, message: operation === 'unlock' ? '模块已确认解除小区锁定' : '模块已确认小区锁定配置；不代表已注册或数据可用' }); return
          }
          const bands = bandJobs.get(rpc.params[3].params[0])
          if (bands) {
            if (++bands.polls === 1) { sendControl({ status: 'pending' }); return }
            bandState.enabled = structuredClone(bands.target)
            sendControl({ status: 'ok', data: bandState, message: '模块已确认频段设置' }); return
          }
          const job = controlJobs.get(rpc.params[3].params[0])!
          assert.ok(job)
          if (++job.polls === 1) { sendControl({ status: 'pending' }); return }
          const setData = (active: boolean) => {
            liteSnapshot.host.net.up = active
            liteSnapshot.host.networks!.filter(row => row.interface?.startsWith('wwan_')).forEach(row => { row.up = active })
          }
          if (!job.done) {
            if (job.kind === 'data') setData(job.target)
            else {
              if (job.target) { resumeData = liteSnapshot.host.net.up === true; setData(false) }
              else setData(resumeData)
              liteSnapshot.raw.status = liteSnapshot.raw.status.replace(/\+CFUN:\s*\d+/, '+CFUN: ' + (job.target ? 4 : 1))
            }
            job.done = true
          }
          sendControl({ status: 'ok', snapshot: liteSnapshot, data: job.kind === 'data' ? { active: job.target }
            : { enabled: job.target, online: !job.target, powered: true, data_active: liteSnapshot.host.net.up === true } }); return
        }
        if (rpc.params[3].command === '/usr/libexec/cpe-status-roaming') {
          assert.ok(roamingWriteAccess)
          const [pref] = rpc.params[3].params
          assert.ok(['1', '255'].includes(pref))
          roamingWrites.push(pref)
          await new Promise(resolve => setTimeout(resolve, 500))
          if (!roamingFailure) liteSnapshot.raw.roaming = `+QNWPREFCFG: "roam_pref",${pref}\n`
          const result = roamingFailure ? { status: 'error', message: '模块尚未确认漫游偏好' }
            : { status: 'ok', message: 'Confirmed', data: { roam_pref: Number(pref), roaming_allowed: pref === '255', policy_scope: 'registration' }, raw: liteSnapshot.raw.roaming, sampled_at: 1005 }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { code: 0, stdout: JSON.stringify(result), stderr: '' }] }))
          return
        }
        assert.deepEqual(rpc.params[3], { command: '/usr/libexec/cpe-status-snapshot', params: [] })
        rpcRequests.push('file.exec')
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { code: 0, stdout: JSON.stringify(liteSnapshot), stderr: '' }] }))
        return
      }
      assert.equal(rpc.params[0], 'local-test'); assert.equal(rpc.params[1], 'openwrt-modem')
      const args = rpc.params[3]
      rpcRequests.push(args.path)
      const response = await fetch(origin + args.path, rpc.params[2] === 'write' ? { method: 'POST', body: args.body, headers: { 'Content-Type': 'application/json' } } : {})
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: [0, { content: await response.text(), content_type: response.headers.get('Content-Type') }] }))
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const root = resolve('build/www'), file = resolve(root, '.' + pathname.replace(/^\/ui/, ''))
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    res.end(await readFile(file))
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
await new Promise<void>(resolve => harness.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(harness.address() as { port: number }).port}`
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${output}/profile`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
let ws: WebSocket | undefined
try {
  const endpoint = await new Promise<string>((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 15000)
    chrome.stderr.on('data', part => {
      stderr += part.toString()
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    chrome.on('error', error => { clearTimeout(timer); reject(error) })
  })
  ws = new WebSocket(endpoint)
  await new Promise(resolve => ws!.addEventListener('open', resolve, { once: true }))
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>()
  const exceptions: unknown[] = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const request = pending.get(message.id); if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(message.error); else request.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params)
  })
  const call = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  const send = (method: string, params: object = {}) => call(method, params, sessionId)
  await send('Runtime.enable'); await send('Page.enable')
  const evaluate = async (expression: string) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async (expression: string) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await pause(100) }
    console.error(JSON.stringify({ expression, exceptions, rpcRequests, body: await evaluate('document.body.innerText'), iframe: await evaluate('document.querySelector("iframe")?.contentDocument?.body?.innerText') }))
    throw new Error('Timed out: ' + expression)
  }
  const doc = 'document.querySelector("iframe").contentDocument'
  const checks: unknown[] = []
  await send('Page.navigate', { url: base + '/luci' })
  if (lite) {
    await wait(`${doc}?.readyState==='complete'`)
    // Each run starts from a deterministic preference, regardless of prior profile.
    await evaluate('localStorage.removeItem("cpe-status-speed-interfaces");localStorage.removeItem("cpe-theme-preference");document.documentElement.setAttribute("data-darkmode","false")')
    await send('Page.reload')
    await wait(`${doc}?.querySelector('[data-network-status-items]')?.textContent.includes('LTE') && ${doc}?.body.textContent.includes('RM500QGLABR13A03M4G')`)
    assert.equal(await evaluate('document.querySelectorAll(\'[role="tab"]\').length'), 5)
    const frameWindow = 'document.querySelector("iframe").contentWindow'
    const colorScheme = `${frameWindow}.getComputedStyle(${doc}.body).colorScheme`
    await wait(`${colorScheme}==='light'`)
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.body).backgroundColor`), await evaluate('getComputedStyle(document.body).backgroundColor'))
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.querySelector('main')).paddingLeft`), '0px')
    await evaluate('document.documentElement.setAttribute("data-darkmode","true")')
    await wait(`${colorScheme}==='dark'`)
    const darkShot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`${output}/theme-dark.png`, Buffer.from(darkShot.data, 'base64'))
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.body).backgroundColor`), await evaluate('getComputedStyle(document.body).backgroundColor'), 'automatic dark background must match LuCI, including the iframe canvas')
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.documentElement).colorScheme`), 'dark')
    assert.equal(await evaluate('getComputedStyle(document.querySelector("iframe")).colorScheme'), 'dark')
    const themeChoice = async (label: string) => {
      await evaluate(`${doc}.querySelector('[title="刷新间隔与显示设置"]').click()`)
      await wait(`${doc}.querySelector('[role="menu"]')!==null`)
      await evaluate(`Array.from(${doc}.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent===${JSON.stringify(label)}).click()`)
    }
    await themeChoice('浅色模式')
    await wait(`${colorScheme}==='light'`)
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.body).backgroundColor`), 'rgb(255, 255, 255)')
    await evaluate('document.documentElement.setAttribute("data-darkmode","false");document.documentElement.setAttribute("data-darkmode","true")')
    assert.equal(await evaluate(colorScheme), 'light', 'manual theme overrides LuCI')
    await themeChoice('跟随 LuCI')
    await wait(`${colorScheme}==='dark'`)
    assert.equal(await evaluate(`${frameWindow}.getComputedStyle(${doc}.body).backgroundColor`), 'rgb(20, 20, 20)')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await send('Page.reload')
    await wait(`${doc}?.body && ${colorScheme}==='dark' && ${frameWindow}.getComputedStyle(${doc}.body).backgroundColor==='rgb(20, 20, 20)'`)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await wait(`${colorScheme}==='light' && ${frameWindow}.getComputedStyle(${doc}.body).backgroundColor==='rgb(255, 255, 255)'`)
    await evaluate('document.documentElement.setAttribute("data-darkmode","false")')
    await wait(`${colorScheme}==='light'`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-auto-apn]')!==null || ${doc}.body.textContent.includes('当前APN')`), false, 'APN belongs on the operator page')
    checks.push({ luciThemeFollowing: true, manualThemeOverride: true, backgroundMatchesLuci: true, darkCanvasAndColorScheme: true, systemDarkOnLoadAndSwitch: true, noOuterPadding: true })
    assert.equal(await evaluate(`${doc}.body.textContent.includes('LTE/NR')`), false)
    await wait(`${doc}.body.textContent.includes('15 MHz') && ${doc}.body.textContent.includes('MBIM / wwan0')`)
    assert.equal(await evaluate(`Array.from(${doc}.querySelectorAll('span')).find(el=>el.textContent==='在网MCC/MNC')?.parentElement.textContent.includes('454/00')`), true, 'SIM card uses cached serving PLMN and preserves the MNC leading zero')
    assert.equal(await evaluate(`${doc}.querySelectorAll('[data-quick-control] input:disabled').length`), 0)
    const roamingInput = `${doc}.querySelector('[data-quick-control="roaming"] input')`
    await wait(`${roamingInput}?.checked===true && !${roamingInput}.disabled`)
    await evaluate(`${roamingInput}.click()`)
    await wait(`${doc}.body.textContent.includes('关闭后仅允许归属网络')`)
    assert.equal(roamingWrites.length, 0)
    await evaluate(`${doc}.querySelector('[aria-label="取消快捷控制操作"]').click()`)
    await wait(`!${roamingInput}.disabled`)
    assert.equal(roamingWrites.length, 0, 'cancelling must not submit any AT setting')
    await evaluate(`${roamingInput}.click()`)
    await evaluate(`${doc}.querySelector('[aria-label="确认快捷控制操作"]').click()`)
    await wait(`${doc}.querySelector('[data-quick-control="roaming"]').getAttribute('aria-busy')==='true'`)
    assert.equal(await evaluate(`${roamingInput}.checked`), true, 'keep old state until backend confirms')
    await wait(`${roamingInput}.checked===false && !${roamingInput}.disabled`)
    assert.deepEqual(roamingWrites, ['1'])
    roamingFailure = true
    await evaluate(`${roamingInput}.click()`)
    await evaluate(`${doc}.querySelector('[aria-label="确认快捷控制操作"]').click()`)
    await wait(`${doc}.body.textContent.includes('请求失败') && !${roamingInput}.disabled`)
    await evaluate(`${doc}.querySelector('[title="查看详情"]').click()`)
    await wait(`${doc}.body.textContent.includes('模块尚未确认漫游偏好')`)
    assert.equal(await evaluate(`${roamingInput}.checked`), false, 'failed confirmation must not flip the switch')
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent==='关闭').click()`)
    roamingFailure = false
    await evaluate(`${roamingInput}.click()`)
    await evaluate(`${doc}.querySelector('[aria-label="确认快捷控制操作"]').click()`)
    await wait(`${roamingInput}.checked===true && !${roamingInput}.disabled`)
    assert.deepEqual(roamingWrites, ['1', '255', '255'])
    checks.push({ roamingCancel: true, readbackOnly: true, failureKeepsState: true })
    assert.ok(rpcRequests.length <= 4, 'dashboard API reads must coalesce even while reconciling controls')
    const dataInput = `${doc}.querySelector('[data-quick-control="data"] input')`
    const flightInput = `${doc}.querySelector('[data-quick-control="airplane"] input')`
    await evaluate(`${dataInput}.click()`)
    await evaluate(`${doc}.querySelector('[aria-label="取消快捷控制操作"]').click()`)
    assert.equal(controlWrites.length, 0)
    for (const [input, target] of [[dataInput, false], [dataInput, true], [flightInput, true], [flightInput, false]] as const) {
      await wait(`!${input}.disabled`)
      await evaluate(`${input}.click()`)
      await evaluate(`${doc}.querySelector('[aria-label="确认快捷控制操作"]').click()`)
      await wait(`${doc}.querySelector('[data-quick-control][aria-busy="true"]')!==null`)
      assert.equal(await evaluate(`${input}.checked`), !target, 'keep previous state while backend job is pending')
      await wait(`${input}.checked===${target} && !${flightInput}.disabled`)
      if (input === flightInput && target) assert.equal(await evaluate(`${dataInput}.disabled`), true)
    }
    assert.deepEqual(controlWrites, ['data:0', 'data:1', 'airplane:1', 'airplane:0'])
    await wait(`${dataInput}.checked===true && !${dataInput}.disabled`)
    checks.push({ asyncControls: true, cancelDoesNotSubmit: true, noOptimisticSwitch: true, flightBlocksData: true, dataRestoredAfterFlight: true })
    const modeSelect = `${doc}.querySelector('[data-network-mode] [role="combobox"]')`
    await wait(`${modeSelect}?.textContent.includes('Auto')`)
    await evaluate(`${modeSelect}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
    await wait(`!!${doc}.querySelector('[role="option"][data-value="NR5G"]')`)
    await evaluate(`${doc}.querySelector('[role="option"][data-value="NR5G"]').click()`)
    await wait(`${doc}.body.textContent.includes('5G Only 需要运营商及 SIM 支持 SA')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='取消').click()`)
    assert.equal(radioWrites.length, 0)
    await evaluate(`${modeSelect}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
    await wait(`!!${doc}.querySelector('[role="option"][data-value="LTE:NR5G"]')`)
    await evaluate(`${doc}.querySelector('[role="option"][data-value="LTE:NR5G"]').click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认切换').click()`)
    await wait(`${doc}.querySelector('[data-network-mode] .Mui-disabled') !== null`)
    assert.equal(await evaluate(`${modeSelect}.textContent.includes('Auto')`), true)
    await wait(`${modeSelect}.textContent.includes('LTE & 5G NR')`)
    assert.deepEqual(radioWrites, [['mode', 'LTE:NR5G']])
    checks.push({ modeChoices: 6, saWarning: true, modeCancelDoesNotSubmit: true, noOptimisticMode: true })
    await wait(`${doc}.body.textContent.includes('192.0.2.2/26') && ${doc}.body.textContent.includes('2001:db8:100::/56')`)
    const speedDevices = () => evaluate(`Array.from(${doc}.querySelectorAll('[data-speed-interface]')).map(el=>el.dataset.speedInterface)`)
    assert.deepEqual((await speedDevices()).sort(), ['br-lan', 'wwan0'])
    await evaluate(`${doc}.querySelector('[aria-label="切换网速接口视图"]').click()`)
    await wait(`${doc}.querySelectorAll('[data-speed-interface]').length===3`)
    await evaluate(`${doc}.querySelector('[aria-label="默认显示 eth0"]').click();${doc}.querySelector('[aria-label="默认显示 wwan0"]').click()`)
    await evaluate(`${doc}.querySelector('[aria-label="切换网速接口视图"]').click()`)
    await wait(`${doc}.querySelectorAll('[data-speed-interface]').length===2 && !${doc}.querySelector('[data-speed-interface="wwan0"]')`)
    assert.deepEqual((await speedDevices()).sort(), ['br-lan', 'eth0'])
    await send('Page.reload')
    await wait(`${doc}?.querySelectorAll('[data-speed-interface]').length===2`)
    assert.deepEqual((await speedDevices()).sort(), ['br-lan', 'eth0'])
    checks.push({ speedSelection: true, savedAcrossReload: true, mbimAddresses: true })
    assert.equal(await evaluate(`${doc}.body.textContent.includes('cpu-thermal')`), false)
    assert.equal(await evaluate(`${doc}.body.textContent.includes('qfe_wtr_pa0') && !${doc}.body.textContent.includes('Modem qfe_wtr_pa0')`), true)
    liteSnapshot.host.networks![1]['ipv6-prefix'] = []
    await send('Page.reload')
    await wait(`${doc}?.body.textContent.includes('2001:db8::2/64')`)
    assert.equal(await evaluate(`${doc}.body.textContent.includes('IPv6 前缀')`), false)
    liteSnapshot.host.networks![1]['ipv6-address'] = [{ address: 'fd12:3456::2', mask: 64 }]
    liteSnapshot.host.networks![1]['ipv6-prefix'] = [{ address: 'fd12:3456::', mask: 56 }]
    await send('Page.reload')
    await wait(`${doc}?.body.textContent.includes('MBIM / wwan0')`)
    assert.equal(await evaluate(`${doc}.body.textContent.includes('IPv6')`), false)
    checks.push({ missingIpv6RowsHidden: true, ulaNotPublicIpv6: true, modemTemperaturesOnly: true })
    // Verify the actual rendered NR bandwidth through the snapshot/RPC path.
    liteSnapshot.raw.cells = '+QENG: "servingcell","CONNECT"\n+QENG: "LTE","FDD",454,00,38C4C03,158,3125,7,4,4,22,-97,-11,-67,11,0,-,30\n+QENG: "NR5G-NSA",454,00,747,-71,13,-11,627264,78,12,1\n'
      + '+QCAINFO: "SCC",1400,100,"LTE BAND 3",1,323,-95,-15,-60,0\n'
      + '+QENG: "neighbourcell inter","LTE",400,23,-15,-95,-60,-,30,6,8,22\n'
    await send('Page.reload')
    await wait(`${doc}?.querySelector('[data-cell-technology]')?.textContent==='LTE/NR' && ${doc}?.querySelector('[data-cell-snapshot]')?.textContent.includes('100 MHz')`)
    assert.deepEqual(await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-snapshot] tbody tr')).map(row=>row.cells[0].textContent.trim())`), ['B7', 'B3', 'n78', 'B1'])
    checks.push({ nrBandwidth: '100 MHz', technology: 'LTE/NR', cellOrder: ['B7 PCC', 'B3 SCC', 'n78', 'B1 neighbor'] })
    liteSnapshot.raw.cells = r13NsaCells
    await send('Page.reload')
    await wait(`${doc}?.querySelector('[data-cell-snapshot]')?.textContent.includes('50 MHz')`)
    const rows = await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-snapshot] tbody tr')).map(row=>Array.from(row.cells).map(cell=>cell.textContent.trim()))`)
    assert.deepEqual(rows.map((row: string[]) => row[0]), ['B3', 'B7', 'n78'])
    assert.equal(rows[1][6], '8.0', 'B7 RSSNR fallback has no asterisk')
    assert.equal(rows[0][6], '4.0', 'PCC keeps its QENG SINR')
    assert.equal(rows[2][1], '50 MHz', 'NOCONN retains reported NR width without an asterisk')
    checks.push({ idleNrBandwidth: '50 MHz', b7Rssnr: '8.0', pccSinr: '4.0' })
    checks.push({ lightweightSnapshot: true, sharedRpc: true, threeControlsWritable: true })
  } else {
  await wait(`document.querySelectorAll('[role="tab"]').length===5 && ${doc}?.querySelector('[data-network-status-items]')?.textContent.includes('5G NSA')`)
  await wait(`${doc}.querySelector('[data-cell-technology]')?.textContent.includes('LTE/NR')`)
  assert.equal(await evaluate(`${doc}.querySelectorAll('header').length`), 0, 'embedded UI must not duplicate navigation')
  await evaluate(`window.savedFrame=document.querySelector('iframe');window.savedDocument=savedFrame.contentDocument`)
  for (const [index, route, expected] of [[1, '/euicc', '尚未启用 LPAC/APDU'], [2, '/network', '小区信息'], [3, '/sms', '短信管理'], [4, '/at-console', 'AT 控制台'], [0, '/', '快捷控制']] as const) {
    await evaluate(`document.querySelectorAll('[role="tab"]')[${index}].click()`)
    await wait(`document.querySelector('iframe').contentWindow.location.hash===${JSON.stringify('#' + route)} && ${doc}.body.textContent.includes(${JSON.stringify(expected)})`)
    assert.equal(await evaluate('savedFrame===document.querySelector("iframe") && savedDocument===savedFrame.contentDocument'), true, 'changing tabs must retain React instance')
    assert.equal(await evaluate(`document.querySelectorAll('[role="tab"][aria-selected="true"]').length`), 1)
    checks.push({ route, reusedFrame: true })
  }
  }
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
    await evaluate('document.querySelector("iframe").contentWindow.scrollTo(0,0)')
    await pause(400)
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`${output}/luci-${width}.png`, Buffer.from(screenshot.data, 'base64'))
    const overflow = await evaluate(`({width:${doc}.documentElement.scrollWidth,viewport:document.querySelector('iframe').clientWidth})`)
    assert.ok(overflow.width <= overflow.viewport + 1, JSON.stringify(overflow))
    checks.push({ width, overflow })
    if (lite) {
      const grid = await evaluate(`(()=>{const grid=${doc}.querySelector('[data-quick-controls-grid]'),r=[...grid.children].map(el=>el.getBoundingClientRect());return {columns:document.querySelector('iframe').contentWindow.getComputedStyle(grid).gridTemplateColumns.split(' ').length,rects:r.map(x=>({top:x.top,left:x.left,right:x.right})),right:grid.getBoundingClientRect().right}})()`)
      assert.equal(grid.columns, width === 1440 ? 2 : 1, JSON.stringify(grid))
      if (width === 1440) assert.ok(Math.abs(grid.rects[0].top - grid.rects[1].top) < 1 && Math.abs(grid.rects[2].top - grid.rects[3].top) < 1, JSON.stringify(grid))
      assert.equal(await evaluate(`${doc}.querySelectorAll('[data-network-status-items]').length`), 1)
      assert.equal(await evaluate(`${doc}.querySelector('[data-embedded-status-bar]').querySelectorAll('button').length`), 3)
      await evaluate(`document.querySelector('iframe').contentWindow.scrollTo(0,${doc}.body.scrollHeight)`)
      await pause(150)
      const sticky = await evaluate(`(()=>{const bar=${doc}.querySelector('[data-embedded-status-bar]'),rect=bar.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,visible:[...bar.querySelectorAll('button')].every(button=>button.getBoundingClientRect().top>=rect.top&&button.getBoundingClientRect().bottom<=rect.bottom),scroll:document.querySelector('iframe').contentWindow.scrollY}})()`)
      assert.ok(sticky.scroll > 100 && Math.abs(sticky.top) < 1 && sticky.visible, JSON.stringify(sticky))
      const stickyShot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}/sticky-status-${width}.png`, Buffer.from(stickyShot.data, 'base64'))
      checks.push({ width, stickyStatusBar: true, controlsInStatusBar: true, singleStatusRow: true })
      await evaluate(`${doc}.querySelector('[data-speed-monitor]').scrollIntoView({block:'start'})`)
      await pause(200)
      const speedShot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}/speed-${width}.png`, Buffer.from(speedShot.data, 'base64'))
      await evaluate(`${doc}.querySelector('[aria-label="切换网速接口视图"]').click()`)
      await wait(`${doc}.querySelectorAll('[data-speed-interface]').length===3`)
      const allOverflow = await evaluate(`({width:${doc}.documentElement.scrollWidth,viewport:document.querySelector('iframe').clientWidth})`)
      assert.ok(allOverflow.width <= allOverflow.viewport + 1, JSON.stringify(allOverflow))
      await evaluate(`${doc}.querySelector('[aria-label="切换网速接口视图"]').click()`)
      await wait(`${doc}.querySelectorAll('[data-speed-interface]').length===2`)
    }
  }
  if (!lite) assert.equal(rpcRequests.filter(path => path === '/api/adaptation').length, 1, 'capabilities must not reload for each tab')
  if (lite) {
    await evaluate(`window.savedFrame=document.querySelector('iframe');window.savedDocument=savedFrame.contentDocument;document.querySelectorAll('[role="tab"]')[1].click()`)
    await wait(`${doc}.querySelectorAll('[data-band-group]').length===3`)
    assert.equal(await evaluate(`${doc}.body.textContent.includes('频段偏好不指定主副载波') || ${doc}.body.textContent.includes('按频点和 PCI 锁定；锁定配置不代表')`), false)
    assert.equal(await evaluate('savedDocument===document.querySelector("iframe").contentDocument'), true)
    const applyButton = `Array.from(${doc}.querySelectorAll('button')).find(el=>el.textContent==='应用频段设置')`
    await evaluate(`${doc}.querySelector('[data-band-group="lte"] input').click()`)
    const initialBandReads = bandReadCount
    await pause(3200)
    assert.equal(bandReadCount, initialBandReads, 'band preferences have no periodic polling')
    assert.equal(scanWrites, 0, 'opening the page must not start QSCAN')
    assert.equal(await evaluate(`${doc}.querySelector('[data-band-group="lte"] input').checked`), true, 'polling preserves unsaved choices')
    await evaluate(`${applyButton}.click()`)
    await wait(`!!${doc}.querySelector('[role="dialog"]')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='取消').click()`)
    assert.equal(bandWrites.length, 0)
    await evaluate(`${applyButton}.click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认应用').click()`)
    await wait(`${applyButton}.disabled===true && !${doc}.querySelector('[role="dialog"]')`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-band-group="lte"]').textContent.includes('模块当前：B3 · B7')`), true, 'pending write keeps previous confirmed selection')
    await wait(`${doc}.body.textContent.includes('模块已确认频段设置')`)
    assert.deepEqual(bandWrites, [['bands', '1:3:7', '78', '78']])
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      await pause(250)
      assert.ok(await evaluate(`${doc}.documentElement.scrollWidth <= document.querySelector('iframe').clientWidth + 1`))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}/bands-${width}.png`, Buffer.from(shot.data, 'base64'))
    }
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-band-group="nsa"] button')).find(el=>el.textContent==='清空').click()`)
    assert.equal(await evaluate(`${applyButton}.disabled`), true, 'empty band group cannot be submitted')
    checks.push({ twoTabs: true, bandsConfirm: true, pollingPreservesDraft: true, noOptimisticBands: true, emptyRejected: true, bandsResponsive: true })
    await wait(`${doc}.querySelectorAll('[data-cell-lock-action]').length===3`)
    const lockNr = `Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] tbody tr')).find(row=>row.cells[0].textContent.includes('n78')).querySelector('button')`
    await evaluate(`${lockNr}.click()`)
    await wait(`${doc}.body.textContent.includes('确认锁定这个小区')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='取消').click()`)
    assert.equal(radioWrites.length, 1)
    await evaluate(`${lockNr}.click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认执行').click()`)
    await wait(`${doc}.body.textContent.includes('CME ERROR: 901')`)
    assert.deepEqual(radioWrites[1], ['cell', 'nr', 'lock', '632352', '41', '78', '30'])
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel]').textContent.includes('NR：未锁定')`), true)
    const lockLte = `${doc}.querySelector('[data-cell-lock-action]')`
    await evaluate(`${lockLte}.click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认执行').click()`)
    await wait(`${doc}.body.textContent.includes('模块已确认小区锁定配置')`)
    const lockedRow = `${doc}.querySelector('[data-cell-locked]').closest('tr')`
    assert.equal(await evaluate(`${lockedRow}.querySelector('button')===null`), true, 'confirmed lock uses a static icon instead of a button')
    assert.ok(await evaluate(`${lockedRow}.querySelector('[data-cell-locked]').getAttribute('aria-label').includes('1400')`))
    const confirmedSummary = await evaluate(`${doc}.querySelector('[data-cell-lock-panel]').querySelector('.MuiChip-root').textContent`)
    staleLockReads = true; liteSnapshot.stale = true
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] button')).find(el=>el.textContent==='读取锁定').click()`)
    for (let attempt = 0; attempt < 20 && staleLockReadCount < 2; attempt++) await pause(500)
    assert.ok(staleLockReadCount >= 2, 'exercise repeated failed lock reads')
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel]').querySelector('.MuiChip-root').textContent`), confirmedSummary)
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel]').textContent.includes('上次')`), false)
    assert.equal(await evaluate(`${lockedRow}.querySelector('button')===null`), true, 'refresh errors preserve the confirmed lock icon')
    staleLockReads = false; liteSnapshot.stale = false
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] button')).find(el=>el.textContent.includes('解除LTE锁定')).click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认执行').click()`)
    await wait(`${doc}.body.textContent.includes('模块已确认解除小区锁定')`)
    assert.equal(await evaluate(`${doc}.querySelectorAll('[data-cell-lock-action]')[0].textContent`), '')
    assert.ok(await evaluate(`${doc}.querySelectorAll('[data-cell-lock-action]')[0].getAttribute('aria-label').includes('锁定')`))
    rejectNrLock = false
    await evaluate(`${lockNr}.click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认执行').click()`)
    await wait(`${doc}.querySelector('[data-cell-lock-panel]').textContent.includes('NR：632352/41')`)
    const scanTab = `Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] [role=tab]')).find(el=>el.textContent==='全部小区信息')`
    const scanButton = `${doc}.querySelector('[data-cell-lock-panel] button[aria-label="刷新小区信息"]')`
    const rows = `${doc}.querySelector('[data-cell-lock-panel] tbody').textContent`
    scanData = { raw: '+QSCAN: "LTE",460,11,1850,20,-95,-13,16,121,31E7C20,452,100,3\nOK\n', sampled_at: 1792426000 }
    await evaluate(`${scanTab}.click()`)
    await pause(2200)
    assert.equal(scanWrites, 0, 'switching the all-cell table must never start a scan')
    assert.equal(await evaluate(`${scanButton}.disabled`), false)
    await evaluate(`${scanButton}.click()`)
    await wait(`${scanButton}.disabled`)
    await pause(2500) // First poll includes an older full scan from another PLMN.
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel] tbody').textContent.includes('460/11')`), false, 'pending scan never displays the old completed scan as new')
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel] thead').textContent.includes('PLMN')`), true, 'all-cell tab shows a PLMN column even while scanning')
    assert.equal(await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-lock-action]')).every(button=>button.disabled)`), true, 'AT lock stays reserved until the modem finishes scanning')
    await wait(`${doc}.querySelector('[data-cell-lock-panel] thead').textContent.includes('PLMN')`)
    await wait(`!${scanButton}.disabled && Array.from(${doc}.querySelectorAll('[data-cell-lock-action]')).some(button=>!button.disabled)`)
    assert.equal(scanWrites, 1)
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel] tbody').textContent.includes('454/00')`), true)
    const fixedRows = await evaluate(rows)
    liteSnapshot.raw.cells = ''
    const completedPolls = scanPolls
    await pause(3200)
    assert.equal(await evaluate(rows), fixedRows, 'dashboard refresh cannot overwrite the frozen scan list')
    assert.equal(scanPolls, completedPolls, 'scan result polling stops when the job completes')
    rejectScan = true
    await evaluate(`${scanButton}.click()`)
    await wait(`${doc}.querySelector('[data-cell-lock-panel]').textContent.includes('扫描超时')`)
    assert.equal(await evaluate(rows), fixedRows, 'failed scan preserves last successful cells')
    rejectScan = false
    checks.push({ manualScan: true, noAutomaticBandReads: true, pendingScanKeepsCells: true, oldScanNotPresentedAsNew: true, locksEnabledOnCompletion: true, completedScanFrozen: true, failedScanKeepsCells: true })
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      await evaluate(`${doc}.querySelector('[data-cell-lock-panel]').scrollIntoView({block:'start'})`)
      await pause(200)
      assert.ok(await evaluate(`${doc}.documentElement.scrollWidth <= document.querySelector('iframe').clientWidth + 1`))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}/cell-locks-${width}.png`, Buffer.from(shot.data, 'base64'))
    }
    checks.push({ cellLockCancel: true, nsaNrSent: true, cme901Preserved: true, cellReadback: true, unlockReadback: true, cellsResponsive: true })
    // The two list sources are explicit and cannot overwrite one another.
    liteSnapshot.raw.cells = r13NsaCells
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] button')).find(el=>el.textContent==='当前及邻区').click()`)
    await wait(`!${doc}.querySelector('[data-cell-lock-panel] thead').textContent.includes('PLMN')`)
    await wait(`${doc}.querySelector('[data-cell-lock-panel] tbody').textContent.includes('50 MHz')`)
    const currentRows = await evaluate(rows)
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-cell-lock-panel] button')).find(el=>el.textContent==='读取锁定').click()`)
    await pause(2500)
    assert.equal(await evaluate(rows), currentRows)
    await evaluate(`document.querySelectorAll('[role="tab"]')[2].click()`)
    await wait(`${doc}.querySelector('[data-current-operator]')?.textContent==='中国移动香港'`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-operator-registration]').textContent`), '已自动注册上网络')
    assert.equal(await evaluate(`${doc}.body.textContent.includes('按 PLMN 选择实际网络；')`), false)
    assert.equal(operatorWrites.length, 0, 'entering operator page must not scan or change registration')
    assert.equal(await evaluate(`${doc}.querySelectorAll('[data-operator-plmn]').length`), 0, 'available operators stay hidden until explicit search')
    await wait(`!!${doc}.querySelector('[data-apn-settings] input')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[data-apn-settings] button')).find(el=>el.textContent==='保存APN').click()`)
    await wait(`${doc}.querySelector('[data-apn-logs]')?.textContent.includes('连接成功')`)
    assert.equal(apnWrites, 1)
    assert.equal(await evaluate(`${doc}.querySelector('[data-active-apn]').textContent.includes('internet')`), true)
    const operatorButton = (text: string) => `Array.from(${doc}.querySelectorAll('[data-operators] button')).find(el=>el.textContent==='${text}')`
    const confirmOperator = `Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='确认')`
    await evaluate(`${operatorButton('扫描运营商')}.click()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('[role="dialog"] button')).find(el=>el.textContent==='取消').click()`)
    assert.equal(operatorWrites.length, 0)
    await evaluate(`${operatorButton('扫描运营商')}.click()`)
    await evaluate(`${confirmOperator}.click()`)
    await wait(`${doc}.querySelectorAll('[data-operator-plmn]').length===2`)
    await evaluate(`${doc}.querySelector('[data-operator-plmn="45403"] button').click()`)
    await evaluate(`${confirmOperator}.click()`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-operator-registration]').textContent.includes('已手动注册上网络')`), false, 'manual state waits for backend confirmation')
    await wait(`${doc}.querySelector('[data-operator-registration]').textContent==='已手动注册上网络'`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-current-operator]').textContent`), 'CUniq', 'numeric COPS selection uses the matching scanned name, never another PLMN from the dashboard')
    assert.deepEqual(operatorWrites.at(-1), ['operator', '45403'])
    await evaluate(`${operatorButton('自动选网')}.click()`)
    await evaluate(`${confirmOperator}.click()`)
    await wait(`${doc}.querySelector('[data-operators]').textContent.includes('自动选网') && !${operatorButton('扫描运营商')}.disabled`)
    assert.deepEqual(operatorWrites.at(-1), ['operator', 'auto'])
    assert.equal(await evaluate(`${doc}.querySelector('[data-operator-registration]').textContent`), '已自动注册上网络')
    assert.equal(await evaluate(`${doc}.querySelector('[data-current-operator]').textContent`), 'UNICOM')
    rejectOperatorScan = true
    await evaluate(`${operatorButton('扫描运营商')}.click()`)
    await evaluate(`${confirmOperator}.click()`)
    await wait(`${doc}.querySelector('[data-operators]').textContent.includes('运营商扫描失败')`)
    assert.equal(await evaluate(`${doc}.querySelectorAll('[data-operator-plmn]').length`), 2)
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
      assert.ok(await evaluate(`${doc}.documentElement.scrollWidth <= document.querySelector('iframe').clientWidth + 1`))
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}/operators-${width}.png`, Buffer.from(shot.data, 'base64'))
    }
    rejectOperatorScan = false
    checks.push({ explicitCellSources: true, operatorsCancelNoWrite: true, operatorSelectionByPlmn: true, operatorConfirmation: true, autoSelection: true, failedOperatorScanRetained: true, operatorsResponsive: true })
    await evaluate(`document.querySelectorAll('[role="tab"]')[0].click()`)
    await evaluate(`document.querySelectorAll('[role="tab"]')[3].click()`)
    await wait(`${doc}.body.textContent.includes('点击快捷指令或输入自定义指令开始')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('.MuiChip-root')).find(el=>el.textContent==='信号质量').click()`)
    await wait(`${doc}.body.textContent.includes('+CSQ: 20,99')`)
    await evaluate(`Array.from(${doc}.querySelectorAll('.MuiChip-root')).find(el=>el.textContent==='IMEI' && el.querySelector('svg')).click()`)
    await wait(`!!Array.from(${doc}.querySelectorAll('button')).find(el=>el.textContent==='写入')`)
    await evaluate(`document.querySelectorAll('[role="tab"]')[4].click()`)
    await wait(`${doc}.body.textContent.includes('短信测试') && !!${doc}.querySelector('input[value="/etc/cpe-status/sms"]')`)
    await evaluate(`(()=>{const input=${doc}.querySelector('input[value="/etc/cpe-status/sms"]');Object.getOwnPropertyDescriptor(savedFrame.contentWindow.HTMLInputElement.prototype,'value').set.call(input,'/mnt/disk/cpe-sms');input.dispatchEvent(new savedFrame.contentWindow.Event('input',{bubbles:true}));})()`)
    await evaluate(`Array.from(${doc}.querySelectorAll('button')).find(el=>el.textContent==='保存路径').click()`)
    await wait(`${doc}.body.textContent.includes('存储路径已保存')`)
    assert.equal(smsPath, '/mnt/disk/cpe-sms')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await pause(150)
    await evaluate(`${doc}.querySelector('[data-sms-conversations] .MuiListItemButton-root').click()`)
    await pause(600)
    await evaluate(`window.smsRow=${doc}.querySelector('[data-sms-conversations] .MuiListItemButton-root');window.smsFlash=false;window.smsObserver=new savedFrame.contentWindow.MutationObserver(()=>{if(${doc}.querySelector('[data-sms-initial-loading]'))window.smsFlash=true});window.smsObserver.observe(${doc}.querySelector('[data-sms-page]'),{childList:true,subtree:true})`)
    const setSmsInterval = async (label: string) => {
      await evaluate(`${doc}.querySelector('[title="刷新间隔与显示设置"]').click()`)
      await evaluate(`Array.from(${doc}.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent.includes('刷新频率')).click()`)
      await evaluate(`Array.from(${doc}.querySelectorAll('[role="menuitem"]')).find(el=>el.textContent==='${label}').click()`)
      await evaluate(`Array.from(${doc}.querySelectorAll('.MuiBackdrop-root')).at(-1)?.click()`)
    }
    await setSmsInterval('1秒/次')
    const readsBefore = smsReads
    await pause(2500)
    assert.ok(smsReads >= readsBefore + 4, 'SMS follows the selected one-second refresh interval')
    assert.equal(await evaluate(`smsRow===${doc}.querySelector('[data-sms-conversations] .MuiListItemButton-root') && smsRow.classList.contains('Mui-selected')`), true, 'background refresh retains the actual list node and selected conversation')
    await setSmsInterval('手动刷新')
    await pause(600)
    const pausedReads = smsReads
    await pause(1500)
    assert.equal(smsReads, pausedReads, 'manual refresh mode stops SMS automatic reads')
    smsEmpty = true
    await evaluate(`${doc}.querySelector('[aria-label="刷新短信"]').click()`)
    await wait(`${doc}.body.textContent.includes('暂无对话')`)
    await evaluate(`${doc}.querySelector('[aria-label="刷新短信"]').click()`)
    await pause(600)
    assert.equal(await evaluate('smsFlash'), false, 'refresh of a loaded empty list never replaces it with a spinner')
    await evaluate('smsObserver.disconnect()')
    smsEmpty = false
    checks.push({ atConsoleShortcutsAndImeiPanel: true, smsHistoryAndStoragePath: true, smsRefreshFollowsInterval: true, smsSelectionRetained: true, emptySmsRefreshNoFlash: true })
    await evaluate(`document.querySelectorAll('[role="tab"]')[0].click()`)
    roamingWriteAccess = false
    await send('Page.reload')
    await wait(`${doc}?.querySelectorAll('[data-quick-control] input:disabled').length===3`)
    assert.deepEqual(roamingWrites, ['1', '255', '255'])
    await evaluate(`document.querySelectorAll('[role="tab"]')[1].click()`)
    await wait(`${doc}.querySelectorAll('[data-band-group] input:disabled').length===19`)
    assert.equal(await evaluate(`${applyButton}.disabled`), true)
    await wait(`${doc}.querySelectorAll('[data-cell-lock-action]:disabled').length===2 && ${doc}.querySelectorAll('[data-cell-locked]').length===1`)
    assert.equal(await evaluate(`${doc}.querySelector('[data-cell-lock-panel] thead').textContent.includes('PLMN')`), false, 'returning to cell locks defaults to the shared serving/neighbour snapshot, not the old QSCAN list')
    checks.push({ readOnlySession: true })
    await evaluate(`document.querySelectorAll('[role="tab"]')[2].click()`)
    await wait(`!!${doc}.querySelector('[data-operators]')`)
    assert.equal(await evaluate(`${operatorButton('扫描运营商')}.disabled`), true)
    assert.equal(await evaluate(`${operatorButton('自动选网')}.disabled`), true)
  }
  assert.equal(rpcRequests.some(path => path === '/api/network/operators/scan'), false, 'no unsolicited operator scan')
  assert.equal(rpcRequests.some(path => path === '/api/euicc'), false, 'disabled LPAC must not probe SIM')
  assert.deepEqual(exceptions, [])
  await writeFile(`${output}/report.json`, JSON.stringify({ checks, rpcRequests, roamingWrites, exceptions, scope: lite ? 'Generated lightweight LuCI view with sanitized hardware fixture and mocked file.exec' : 'Generated LuCI view with mocked LuCI API and real demo backend; no real hardware' }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, output }))
} finally {
  ws?.close(); chrome.kill(); daemon.kill()
  harness.closeAllConnections(); harness.close()
  await Promise.race([once(daemon, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))])
}
