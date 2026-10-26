import { constants } from 'node:fs'
import { open, mkdir, rm, realpath, type FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export async function writeAll(file: Pick<FileHandle, 'write'>, value: string, deadline: number) {
  const data = Buffer.from(value)
  let offset = 0
  while (offset < data.length) {
    if (Date.now() >= deadline) throw new Error('ModemReadDeferred: AT write timed out')
    try { offset += (await file.write(data, offset, data.length - offset, null)).bytesWritten }
    catch (error) { if (!['EAGAIN', 'EWOULDBLOCK', 'EINTR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    if (offset < data.length) await pause(10)
  }
}
export interface AtTransport {
  exchange(command: string, timeoutMs: number, continuation?: string): Promise<string>
  suspend<T>(work: () => Promise<T>): Promise<T>
  close(): Promise<void>
}

export class SerialTransport implements AtTransport {
  private file?: FileHandle
  private lock?: string
  private poisoned = false
  private lateReply = ''
  private active = false
  constructor(private device: string, private baudRate = 115200) {}
  async connect() {
    if (process.platform !== 'linux') throw new Error('Serial backend requires Linux; use --demo for local preview')
    const resolved = await realpath(this.device)
    if (!/^\/dev\/tty(?:USB|ACM)\d+$/.test(resolved)) throw new Error('Select an explicit ttyUSB/ttyACM AT port')
    const lock = `/var/lock/openwrt-modem-${resolved.split('/').pop()}`
    await mkdir(lock) // Atomic interprocess exclusion; never delete another owner's lock.
    this.lock = lock
    try {
      await execute('stty', ['-F', resolved, String(this.baudRate), 'raw', '-echo', '-ixon', '-ixoff', 'clocal', '-crtscts', 'min', '0', 'time', '0'], { timeout: 5000 })
      this.file = await open(resolved, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK)
    } catch (error) { await this.close(); throw error }
  }
  async exchange(command: string, timeoutMs: number, continuation?: string): Promise<string> {
    if (this.active || !this.file) throw new Error('ModemReadDeferred: AT port is busy or disconnected')
    this.active = true
    const file = this.file
    const deadline = Date.now() + timeoutMs
    try {
      if (this.poisoned) {
        // Consume the previous command's terminal reply before allowing a new
        // request. Never retry its write or let a late OK confirm the next one.
        const recoveryDeadline = Math.min(deadline, Date.now() + 5000)
        const recoveryBuffer = Buffer.alloc(4096)
        while (this.poisoned && Date.now() < recoveryDeadline) {
          try {
            const { bytesRead } = await file.read(recoveryBuffer, 0, recoveryBuffer.length, null)
            if (bytesRead) this.lateReply = (this.lateReply + recoveryBuffer.subarray(0, bytesRead).toString()).slice(-8192)
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error }
          if (/(?:^|\r?\n)(?:OK|ERROR|\+CME ERROR:[^\r\n]*|\+CMS ERROR:[^\r\n]*)\r?\n/.test(this.lateReply)) {
            this.poisoned = false; this.lateReply = ''; break
          }
          await pause(10)
        }
        if (this.poisoned) throw new Error('ModemReadDeferred: previous AT command is still pending; no new command sent')
      }
      // Drain queued URCs/old input before issuing a request. The scheduler is the
      // only reader. A timeout poisons the channel so late OK cannot satisfy a new query.
      const buffer = Buffer.alloc(4096)
      for (let i = 0; i < 64; i++) {
        try { if (!(await file.read(buffer, 0, buffer.length, null)).bytesRead) break }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EAGAIN') break; throw error }
      }
      try { await writeAll(file, command + '\r', deadline) }
      catch (error) { this.poisoned = true; throw error }
      let reply = '', sent = false
      while (Date.now() < deadline) {
        try {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
          if (bytesRead) reply += buffer.subarray(0, bytesRead).toString('utf8')
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error }
        if (Buffer.byteLength(reply) > 262144) { this.poisoned = true; throw new Error('AT reply exceeded output limit') }
        if (/(?:^|\r?\n)(?:ERROR|\+CME ERROR:[^\r\n]*|\+CMS ERROR:[^\r\n]*)\r?\n/.test(reply)) throw new Error(reply.trim())
        if (continuation !== undefined && !sent && /(?:^|[\r\n])> ?$/.test(reply)) {
          try { await writeAll(file, continuation + '\x1a', deadline); sent = true }
          catch (error) { this.poisoned = true; throw error }
        }
        if (/(?:^|\r?\n)OK\r?\n/.test(reply)) {
          if (continuation !== undefined && !sent) throw new Error('SMS command completed without a payload prompt')
          return reply
        }
        await pause(10)
      }
      this.poisoned = true
      this.lateReply = reply.slice(-8192)
      throw new Error('ModemReadDeferred: AT command timed out; channel quarantined to prevent reply mixups')
    } finally { this.active = false }
  }
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    if (this.active || this.poisoned) throw new Error('AT channel unavailable')
    await this.file?.close(); this.file = undefined
    try { return await work() }
    finally { this.file = await open(this.device, constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK) }
  }
  async close() {
    await this.file?.close(); this.file = undefined
    if (this.lock) { await rm(this.lock, { recursive: true }); this.lock = undefined }
  }
}
