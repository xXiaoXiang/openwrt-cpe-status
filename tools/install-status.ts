import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, basename, sep } from 'node:path'
import { packageManifest, packageRelease } from '../project.ts'
import { apkFilename } from './sdk-targets.ts'

const root = resolve('build/sdk-test'), apk = resolve(root, process.argv[2] || `aarch64_cortex-a53/${apkFilename(packageManifest.version, packageRelease, 'aarch64_cortex-a53')}`)
const reinstall = process.argv.includes('--reinstall') ? ' --force-reinstall' : ''
if (!apk.startsWith(root + sep) || !/^luci-app-cpe-status-[\d.]+-r\d+(?:-(?:aarch64_cortex-a53|x86_64))?\.apk$/.test(basename(apk))) throw new Error('Invalid generated APK path')
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts']
const router = process.env.CPE_ROUTER || 'root@192.168.6.248'
const ssh = (script: string) => execFileSync('ssh', [...sshOptions, router, 'sh -s'], { input: script + '\n', encoding: 'utf8', windowsHide: true })
const architecture = /-(aarch64_cortex-a53|x86_64)\.apk$/.exec(basename(apk))?.[1]
// OpenWrt's configured package target is more specific than apk's compiled
// architecture (for example aarch64_cortex-a53 versus aarch64).
if (architecture && ssh('cat /etc/apk/arch 2>/dev/null || apk --print-arch').trim() !== architecture) throw new Error('APK architecture does not match the target router')
const untouched = () => ssh("uci show network | sed '/^network\\.wwan[.=]/d' | sha256sum").trim()
const before = untouched(), sha256 = createHash('sha256').update(await readFile(apk)).digest('hex'), name = basename(apk)
const persistentHashes = () => {
  const out = ssh("find /etc/cpe-status -type f ! -path '/etc/cpe-status/legacy/*' -exec sha256sum {} \\;\nif test -f /etc/cpe-status.json; then sha256sum /etc/cpe-status.json; fi")
  return Object.fromEntries(out.trim().split('\n').filter(Boolean).map(line => {
    const match = /^([a-f0-9]{64})  (\/etc\/cpe-status(?:\/.*|\.json))$/.exec(line)
    if (!match) throw new Error('Unexpected persistent file checksum')
    return [match[2], match[1]]
  }))
}
const persistentBefore = persistentHashes()
const previousDefaults = Object.fromEntries(ssh('cat /lib/apk/packages/luci-app-cpe-status.conffiles_static 2>/dev/null || true').trim().split('\n').flatMap(line => {
  const match = /^(\/etc\/cpe-status\/[a-zA-Z0-9_./-]+) ([a-f0-9]{64})$/.exec(line)
  return match ? [[match[1],match[2]]] : []
}))
const smsBefore = new Map<string,{ records: Record<string,unknown>[] }>()
for (const path of Object.keys(persistentBefore)) if (/^\/etc\/cpe-status\/[a-zA-Z0-9_./-]+\/cpe-sms-history\.json$/.test(path)) smsBefore.set(path,JSON.parse(ssh(`cat ${path}`)))
execFileSync('scp', ['-O', ...sshOptions, apk, `${router}:/root/${name}`], { stdio: 'inherit', windowsHide: true })
const verified = ssh(`sha256sum /root/${name}`).trim().split(/\s+/)[0]
if (verified !== sha256) throw new Error('Router APK checksum mismatch')
console.log(ssh(`apk add --network=no --allow-untrusted${reinstall} /root/${name}\napk list --installed luci-app-cpe-status`))
const persistentAfter = persistentHashes()
const updatedDefaults: string[] = [], migratedArchives: string[] = []
const smsIdentity = (row: Record<string,unknown>) => {
  const memory = row.memory || /^[^:]+:(ME|SM):/.exec(String(row.key))?.[1] || 'ME'
  return JSON.stringify([row.direction,memory,memory==='SM' ? row.sim : null,row.phone_number,row.timestamp,row.content,row.reference??null,row.part??null,row.total??null])
}
for (const [path, hash] of Object.entries(persistentBefore)) {
  const destination = path === '/etc/cpe-status.json' ? (persistentBefore['/etc/cpe-status/config.json'] ? '/etc/cpe-status/legacy/cpe-status.json' : '/etc/cpe-status/config.json') : path
  const actual = destination.includes('/legacy/') ? ssh(`sha256sum ${destination}`).trim().split(/\s+/)[0] : persistentAfter[destination]
  if (actual !== hash) {
    if (previousDefaults[path] === hash && createHash('sha256').update(await readFile('build/openwrt-status-package/files'+path)).digest('hex') === actual) {
      updatedDefaults.push(path);continue
    }
    if (smsBefore.has(path)) {
      const backup=path.replace(/\.json$/,'.pre-v2.json'), archived=persistentAfter[backup]
      const current=JSON.parse(ssh(`cat ${path}`)) as {version:number;records:Record<string,unknown>[]}
      if (archived===hash && current.version===2 && smsBefore.get(path)!.records.every(row=>current.records.some(candidate=>smsIdentity(candidate)===smsIdentity(row) && (row.status!=='read' || candidate.status==='read')))) {
        migratedArchives.push(path);continue
      }
    }
    throw new Error('Persistent configuration changed during upgrade: ' + destination)
  }
}
const after = untouched()
if (before !== after) throw new Error('Unexpected configuration change outside network.wwan')
const summary = ssh(`
/etc/init.d/cpe-status enabled && echo STARTUP_ENABLED
for attempt in 1 2 3 4 5 6; do
  if test -f /tmp/cpe-status/wwan-manager.json && grep -q '"status": "ready"' /tmp/cpe-status/wwan-manager.json; then break; fi
  sleep 2
done
cat /tmp/cpe-status/wwan-manager.json 2>/dev/null || true
echo
ubus -S call service list '{"name":"cpe-status"}'
uci -q get network.wwan.auto
uci -q get network.wwan.apn
uci -q get network.wwan.modes
ubus -S call network.interface.wwan status
`)
await writeFile('build/router-audit/installed-services.json', JSON.stringify({ apk: name, sha256, otherInterfacesUnchanged: before === after, persistentFilesPreserved: Object.keys(persistentBefore).length-updatedDefaults.length-migratedArchives.length, updatedDefaults, migratedArchives, persistentBefore, persistentAfter, summary }, null, 2))
console.log(summary)
console.log(JSON.stringify({ apk: name, sha256, otherInterfacesUnchanged: true, persistentFilesPreserved: Object.keys(persistentBefore).length-updatedDefaults.length-migratedArchives.length,updatedDefaults,migratedArchives }))
