// Validate the APK's emitted hooks, not just the TypeScript generator.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathMigrationPrepare, statusHelperNames } from '../openwrt/path-migration.ts'
import { packageManifest, packageRelease } from '../project.ts'
import { sdkArchitecture } from './sdk-targets.ts'

const raw = await readFile(`build/sdk-test/${sdkArchitecture(process.argv[2])}/package-metadata.yaml`, 'utf8')
assert.ok(raw.includes('  version: ' + packageManifest.version + '-r' + packageRelease + '\n'))
function hook(name: string) {
  const body = raw.split('  ' + name + ': |\n')[1]?.split(/\n  [a-z-]+: |\n# data block/)[0]
  assert.ok(body, 'Missing APK hook: ' + name)
  return body.split('\n').map(line => line.replace(/^    /, '')).join('\n')
}
const normalize = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n')
assert.equal(normalize(hook('pre-install')), normalize('#!/bin/sh\n' + pathMigrationPrepare + '\nexit 0'))
assert.equal(normalize(hook('pre-upgrade')), normalize('#!/bin/sh\nexport PKG_UPGRADE=1\n' + pathMigrationPrepare + '\nexit 0'))
assert.ok(hook('post-upgrade').includes('"${IPKG_INSTROOT}/usr/libexec/cpe-status/migrate"'))

const paths = new Map<string, string>()
let directory = '', file = ''
for (const line of raw.split(/\r?\n/)) {
  const d = line.match(/^  - name: (.+)$/), f = line.match(/^      - name: (.+)$/), h = line.match(/^        hash: ([a-f0-9]{64})$/)
  if (d) directory = '/' + d[1]
  if (f) file = directory + '/' + f[1]
  if (h) paths.set(file, h[1])
}
assert.ok(paths.has('/etc/cpe-status/config.json'))
assert.ok(!paths.has('/etc/cpe-status.json') && !paths.has('/etc/config.json'))
assert.deepEqual([...paths.keys()].filter(path => path.startsWith('/usr/libexec/')).sort(), [...statusHelperNames, 'migrate', 'qos-collector.pl'].map(name => '/usr/libexec/cpe-status/' + name).sort())
const source = 'build/openwrt-status-package/files'
for (const [path, expected] of paths) {
  if (path.startsWith('/lib/')) continue // SDK-owned bookkeeping files.
  assert.equal(createHash('sha256').update(await readFile(source + path)).digest('hex'), expected, 'APK/source mismatch: ' + path)
}
const acl = JSON.parse(await readFile(source + '/usr/share/rpcd/acl.d/luci-app-cpe-status.json', 'utf8'))['luci-app-cpe-status']
for (const kind of ['read', 'write']) for (const path of Object.keys(acl[kind].file)) assert.ok(paths.has(path), 'ACL points to missing helper: ' + path)
for (const name of await readdir(source + '/usr/libexec/cpe-status')) {
  if (name === 'migrate') continue
  assert.ok(!/\/usr\/libexec\/cpe-status-|\/etc\/cpe-status\.json/.test(await readFile(source + '/usr/libexec/cpe-status/' + name, 'utf8')), 'Old runtime path: ' + name)
}
console.log(JSON.stringify({ files: paths.size, helpers: 29, apk_hooks_preserved: true, apk_source_hashes_match: true, config_and_acl_paths_valid: true }))
