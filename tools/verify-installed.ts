import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { snapshotRoutes, type StatusSnapshot } from '../shared/status-snapshot.ts'
import { packageManifest } from '../project.ts'
import { createProfileCache, type ProfileReply } from '../frontend/src/api/profileCache.ts'

const script = `set -eu
test ! -e /www/luci-static/resources/openwrt-modem
test -f /www/luci-static/resources/cpe-status/index.html
grep -q 'cpe-status/index.html' /www/luci-static/resources/view/modem/cpe-status.js
grep -q '/etc/cpe-status/modem.d/2c7c0800.conf' /lib/apk/packages/luci-app-cpe-status.conffiles_static
echo '>>> files'
apk info -L luci-app-cpe-status
echo '>>> profile-hash'
sha256sum /etc/cpe-status/modem.d/2c7c0800.conf
echo '>>> snapshot'
/usr/libexec/cpe-status-snapshot
echo '>>> profile'
/usr/libexec/cpe-status-snapshot profile
echo '>>> config-before'
tar -xzOf /root/cpe-status-pre-v1.tar.gz etc/cpe-status.json | sha256sum
echo '>>> config-after'
sha256sum /etc/cpe-status.json
echo '>>> web'
wget -qO- http://127.0.0.1/luci-static/resources/cpe-status/index.html
echo
echo '>>> done'
`
const output = execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8',process.env.CPE_ROUTER || 'root@192.168.6.248','sh -s'], { input: script, encoding: 'utf8', timeout: 60000, windowsHide: true })
const section = (name: string) => output.split('>>> ' + name + '\n')[1]?.split('>>> ')[0].trim()
const profiles = createProfileCache()
const loadProfile = async () => JSON.parse(execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8',process.env.CPE_ROUTER || 'root@192.168.6.248','/usr/libexec/cpe-status-snapshot profile'], { encoding: 'utf8', timeout: 15000, windowsHide: true })) as ProfileReply
await profiles.get(async () => JSON.parse(section('profile')!) as ProfileReply)
let snapshot = await profiles.hydrate(JSON.parse(section('snapshot')!) as StatusSnapshot, loadProfile)
const requiredRoutes = ['/api/device','/api/network','/api/cells','/api/sim']
for (let attempt = 0; attempt < 12 && requiredRoutes.some(name => snapshotRoutes(snapshot)[name].status === 'deferred'); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  snapshot = await profiles.hydrate(JSON.parse(execFileSync('ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=8',process.env.CPE_ROUTER || 'root@192.168.6.248','/usr/libexec/cpe-status-snapshot'], { encoding: 'utf8', timeout: 15000, windowsHide: true })) as StatusSnapshot, loadProfile)
}
assert.equal(snapshot.error, undefined)
assert.equal(snapshot.adapter?.id, 'quectel-rm500q-gl')
assert.deepEqual(snapshot.warnings ?? {}, {})
const routes = snapshotRoutes(snapshot)
for (const name of ['/api/device','/api/network','/api/cells','/api/sim']) assert.equal(routes[name].status, 'ok', name)
const hash = createHash('sha256').update(await readFile('modem.d/2c7c0800.conf')).digest('hex')
assert.equal(section('profile-hash')?.split(/\s+/)[0], hash)
assert.equal(section('config-before')?.split(/\s+/)[0], section('config-after')?.split(/\s+/)[0])
assert.ok(section('web')?.includes('<div id="root">'))
await mkdir('build/sdk-test', { recursive: true })
await writeFile(`build/sdk-test/apk-files-${packageManifest.version}.txt`, section('files')! + '\n')
const report = { version: packageManifest.version, oldStaticDirectoryRemoved: true, obsoleteMarkerRemoved: true, newStaticHttpOk: true, profileMatchesPackage: true, upgradeConfigPreserved: true, originalConfigurationUnchanged: true, modemDataOk: true }
await writeFile('build/profile-live/installed.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
