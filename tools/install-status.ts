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
execFileSync('scp', ['-O', ...sshOptions, apk, `${router}:/root/${name}`], { stdio: 'inherit', windowsHide: true })
const verified = ssh(`sha256sum /root/${name}`).trim().split(/\s+/)[0]
if (verified !== sha256) throw new Error('Router APK checksum mismatch')
console.log(ssh(`apk add --network=no --allow-untrusted${reinstall} /root/${name}\napk list --installed luci-app-cpe-status`))
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
await writeFile('build/router-audit/installed-services.json', JSON.stringify({ apk: name, sha256, otherInterfacesUnchanged: before === after, summary }, null, 2))
console.log(summary)
console.log(JSON.stringify({ apk: name, sha256, otherInterfacesUnchanged: true }))
