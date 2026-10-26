import { spawn } from 'node:child_process'
import type { Engine } from './engine.ts'

export interface LpacConfig { enabled: boolean; executable: string; env: Record<string, string>; enableRefresh: '0' | '1' }

export async function runLpac(config: LpacConfig, args: string[], timeoutMs: number): Promise<unknown> {
  if (!config.enabled) throw new Error('Unsupported: configure LPAC and its APDU transport before using eUICC')
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, ...config.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', failure: Error | undefined
    const kill = (reason: string) => {
      failure = new Error(reason)
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const timer = setTimeout(() => kill('LPAC timeout; subprocess was forcibly terminated'), timeoutMs)
    child.stdout.on('data', data => { stdout += data.toString(); if (Buffer.byteLength(stdout) > 262144) kill('LPAC output limit exceeded') })
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure) { reject(failure); return }
      try {
        const payloads = stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line) as { type?: string; payload?: { code: number; message: string; data: unknown } })
        const payload = payloads.filter(event => event.type === 'lpa' && event.payload && 'code' in event.payload).at(-1)?.payload
        if (code !== 0 || !payload || payload.code !== 0) throw new Error(payload?.message || `LPAC exited ${code}: ${stderr}`)
        resolve(payload.data)
      } catch (error) { reject(error) }
    })
  })
}

export class EuiccService {
  private snapshot?: { time: number; data?: unknown; error?: unknown }
  private pending?: Promise<unknown>
  constructor(private engine: Engine, private config: LpacConfig) {}
  async info() {
    if (this.snapshot && Date.now() - this.snapshot.time < 10_000) {
      if (this.snapshot.error) throw this.snapshot.error
      return this.snapshot.data
    }
    if (this.pending) return this.pending
    this.pending = this.engine.exclusive(() => this.engine.transport.suspend(async () => {
      const info = await runLpac(this.config, ['chip', 'info'], 10_000) as { eidValue?: unknown; EUICCInfo2?: { euiccFirmwareVer?: unknown } }
      if (typeof info.eidValue !== 'string' || !/^\d{32}$/.test(info.eidValue)) throw new Error('LPAC did not return a valid EID; the SIM may not be an eUICC')
      const profiles = await runLpac(this.config, ['profile', 'list'], 20_000)
      if (!Array.isArray(profiles)) throw new Error('Invalid LPAC profile list')
      return { eid: info.eidValue, firmware_version: info.EUICCInfo2?.euiccFirmwareVer ?? null, profiles }
    })).then(data => { this.snapshot = { time: Date.now(), data }; return data }).catch(error => { this.snapshot = { time: Date.now(), error }; throw error }).finally(() => { this.pending = undefined })
    return this.pending
  }
  async invoke(args: string[], mutate = true, timeoutMs = 120_000) {
    if (mutate && !this.engine.allowWrites) throw new Error('Unsupported: hardware writes are disabled')
    return this.engine.exclusive(async () => {
      this.engine.writing = true
      try { return await this.engine.transport.suspend(() => runLpac(this.config, args, timeoutMs)) }
      finally { if (mutate) { this.snapshot = undefined; this.engine.cache.invalidate() }; this.engine.writing = false }
    })
  }
  refreshMode() { return this.config.enableRefresh }
}
