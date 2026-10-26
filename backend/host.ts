import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'

const execute = promisify(execFile)
const read = async (path: string) => readFile(path, 'utf8').then(text => text.trim()).catch(() => '')

export class OpenWrtHost {
  private samples = new Map<string, { time: number; rx: number; tx: number }>()
  constructor(readonly networkInterface: string) {
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(networkInterface)) throw new Error('Invalid netifd interface name')
  }
  async status() {
    const { stdout } = await execute('ubus', ['call', `network.interface.${this.networkInterface}`, 'status'], { timeout: 5000, maxBuffer: 262144 })
    const result = JSON.parse(stdout) as { up?: unknown; pending?: unknown; l3_device?: unknown; proto?: unknown }
    if (typeof result.up !== 'boolean') throw new Error('Invalid netifd status')
    return { active: result.up, pending: result.pending === true, interface: this.networkInterface, l3_device: typeof result.l3_device === 'string' ? result.l3_device : undefined, protocol: result.proto }
  }
  async setData(active: boolean) {
    await execute(active ? 'ifup' : 'ifdown', [this.networkInterface], { timeout: 10_000 })
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const status = await this.status()
      if (status.active === active && !status.pending) return status
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('ModemReadDeferred: netifd request submitted; interface state not yet confirmed')
  }
  async ping(ipv6: boolean) {
    const target = ipv6 ? '2606:4700:4700::1111' : '1.1.1.1'
    const status = await this.status()
    if (!status.active || !status.l3_device) return { success: false, target, error: 'Modem netifd interface is down' }
    try {
      const { stdout } = await execute(ipv6 ? 'ping6' : 'ping', ['-I', status.l3_device, '-c', '1', '-W', '2', target], { timeout: 5000 })
      const latency = /time[=<]([\d.]+)/.exec(stdout)
      return { success: true, target, latency_ms: latency ? Number(latency[1]) : undefined }
    } catch { return { success: false, target } }
  }
  async stats() {
    const memoryText = await read('/proc/meminfo')
    const memoryValue = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(memoryText)?.[1] ?? 0) * 1024
    const total = memoryValue('MemTotal') || os.totalmem(), available = memoryValue('MemAvailable') || os.freemem()
    const now = Date.now()
    const interfaces = await Promise.all(Object.keys(os.networkInterfaces()).map(async name => {
      const [rxText, txText] = await Promise.all(['rx_bytes', 'tx_bytes'].map(key => read(`/sys/class/net/${name}/statistics/${key}`)))
      const rx = Number(rxText), tx = Number(txText), previous = this.samples.get(name)
      const seconds = previous ? (now - previous.time) / 1000 : 0
      this.samples.set(name, { time: now, rx, tx })
      return { interface: name, total_rx_bytes: rx, total_tx_bytes: tx, rx_bytes_per_sec: seconds > 0 ? Math.max(0, rx - previous!.rx) / seconds : 0, tx_bytes_per_sec: seconds > 0 ? Math.max(0, tx - previous!.tx) / seconds : 0 }
    }))
    const zones = (await readdir('/sys/class/thermal').catch(() => [])).filter(name => /^thermal_zone\d+$/.test(name))
    const temperature = await Promise.all(zones.map(async zone => ({ zone, type: await read(`/sys/class/thermal/${zone}/type`), temperature: Number(await read(`/sys/class/thermal/${zone}/temp`)) / 1000 })))
    const load = os.loadavg(), cores = os.cpus().length || 1, uptime = os.uptime()
    const disk = await execute('df', ['-Pk'], { timeout: 3000 }).then(({ stdout }) => stdout.trim().split('\n').slice(1).flatMap(line => {
      const columns = line.trim().split(/\s+/)
      return columns.length >= 6 ? [{ mount_point: columns.slice(5).join(' '), fs_type: '', total_bytes: Number(columns[1]) * 1024, used_bytes: Number(columns[2]) * 1024, available_bytes: Number(columns[3]) * 1024, used_percent: Number(columns[4].replace('%', '')) }] : []
    })).catch(() => [])
    return {
      network_speed: { interfaces, interval_seconds: 1 },
      memory: { total_bytes: total, available_bytes: available, used_bytes: total - available, used_percent: (total - available) / total * 100, cached_bytes: memoryValue('Cached'), buffers_bytes: memoryValue('Buffers') },
      cpu_load: { core_count: cores, load_1min: load[0], load_5min: load[1], load_15min: load[2], load_percent: Math.min(100, load[0] / cores * 100) },
      uptime: { uptime_seconds: uptime, idle_seconds: 0, uptime_formatted: `${Math.floor(uptime / 86400)}天${Math.floor(uptime / 3600) % 24}时${Math.floor(uptime / 60) % 60}分${Math.floor(uptime) % 60}秒` },
      system_info: { sysname: os.type(), nodename: os.hostname(), machine: os.arch(), release: os.release(), version: os.version(), full_info: `${os.type()} ${os.release()}` },
      temperature, disk,
      usb_mode: { current_mode: null, current_mode_name: 'OpenWrt 主机管理', needs_reboot: false, read_mode: 'host' },
      scope: 'OpenWrt router resources, not the internal modem OS',
    }
  }
}
