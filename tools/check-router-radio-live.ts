import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { cellLockReader } from '../openwrt/radio-settings.ts'
import { statusRuntime } from '../openwrt/status-collector.ts'

// Read-only real hardware check using the installed collector's shared AT lock.
const root = '/tmp/cpe-radio-read-' + process.pid
const probe = statusRuntime + String.raw`
let lock=directory+'/lock';
if(!mkdir(lock,0700)) die('Modem read lock busy, retry later');
writefile(lock+'/pid',''+pid);
let result={};
try {
  result.mode=bounded('sms_tool -d '+port+' at '+"'AT+QNWPREFCFG=\"mode_pref\"'",5);
  result.syntax=bounded('sms_tool -d '+port+' at '+"'AT+QNWLOCK=?'",5);
} catch(e) { result.error=''+e; }
unlink(lock+'/pid');rmdir(lock);
print(sprintf('%J\n',result));
`
const script = [
  'set -eu', 'umask 077', `mkdir ${root}`,
  ...Object.entries({ locks: cellLockReader, probe }).flatMap(([file, content], index) => [`cat > ${root}/${file} <<'CPE_LIVE_${index}'`, content, `CPE_LIVE_${index}`]),
  `chmod 700 ${root}/locks ${root}/probe`, `export CPE_STATUS_CELL_SCRIPT=${root}/locks`,
  `${root}/locks --refresh`, `echo '>>> locks'`, `${root}/locks`,
  `echo '>>> cached'`, `${root}/locks`, `echo '>>> probe'`, `${root}/probe`, `echo '>>> done'`,
].join('\n')
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', 'root@192.168.2.248', 'sh -s'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdin.end(script + '\n')
let stdout = '', stderr = ''
child.stdout.on('data', part => { stdout += part.toString() }); child.stderr.on('data', part => { stderr += part.toString() })
const timer = setTimeout(() => child.kill(), 40_000)
const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) }); clearTimeout(timer)
await mkdir('build/router-audit', { recursive: true })
await writeFile('build/router-audit/radio-live.txt', stdout + stderr)
assert.equal(code, 0, stdout + stderr)
const result = Object.fromEntries(stdout.split(/>>> /).filter(part => part.includes('\n') && !part.startsWith('done')).map(part => { const [name, ...lines] = part.trim().split('\n'); return [name, JSON.parse(lines.join('\n'))] }))
assert.equal(result.locks.status, 'ok'); assert.equal(result.locks.data.lte.status, 'ok'); assert.equal(result.locks.data.nr.status, 'ok')
assert.deepEqual(result.locks, result.cached)
assert.match(result.probe.mode, /\+QNWPREFCFG:\s*"mode_pref",/)
assert.match(result.probe.syntax, /"common\/5g",<pci>,<freq>,<scs>,<band>/)
console.log(JSON.stringify({ readOnly: true, modemWrites: 0, cacheReused: true, lte: result.locks.data.lte, nr: result.locks.data.nr, mode: result.probe.mode, nrSyntax: 'pci,freq,scs,band' }))
