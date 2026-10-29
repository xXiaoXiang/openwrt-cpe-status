import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { packageManifest, packageRelease } from '../project.ts'
import { sdkTargets, sdkArchitecture, apkFilename, type SdkArchitecture } from './sdk-targets.ts'

const version = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: publish-release.ts vX.Y.Z [notes-file|-] [aarch64_cortex-a53|x86_64|all] [--prune-old-apks] [--include-lpac]')
const pruneOldApks = process.argv.includes('--prune-old-apks')
const includeLpac = process.argv.includes('--include-lpac')
const revision = version.slice(1) === packageManifest.version ? packageRelease : 0
const architectures = process.argv[4] === 'all' ? Object.keys(sdkTargets) as SdkArchitecture[] : [sdkArchitecture(process.argv[4])]
const apks = await Promise.all(architectures.map(async architecture => {
  const name = apkFilename(version.slice(1), revision, architecture)
  const path = `build/sdk-test/${architecture}/${name}`
  const apk = await readFile(path)
  const metadata = await readFile(`build/sdk-test/${architecture}/package-metadata.yaml`, 'utf8')
  if (!metadata.includes(`\n  arch: ${architecture}\n`) || !metadata.includes(`\n  version: ${version.slice(1)}-r${revision}\n`)) throw new Error('APK metadata does not match release: ' + path)
  return { architecture, name, apk, hash: createHash('sha256').update(apk).digest('hex') }
}))
// Verify all artifacts before creating or changing a public release. LPAC keeps
// its own version; the plugin version must never relabel a third-party binary.
const attachments: { name: string; apk: Buffer; hash: string }[] = []
if (includeLpac) {
  for (const architecture of architectures) {
    const root = `build/lpac-sdk/${architecture}`
    const metadata = await readFile(`${root}/package-metadata.yaml`, 'utf8')
    const manifest = (await readFile(`${root}/SHA256SUMS`, 'utf8')).trim()
    const match = /^([a-f0-9]{64})  (lpac-[\w.+-]+\.apk)$/.exec(manifest)
    if (!match || !match[2].endsWith(`-${architecture}.apk`)) throw new Error('Invalid LPAC checksum manifest: ' + architecture)
    const packageVersion = match[2].slice(5, -(`-${architecture}.apk`.length))
    if (!metadata.includes(`\n  arch: ${architecture}\n`) || !metadata.includes(`\n  version: ${packageVersion}\n`)
      || !metadata.includes('driver_http_curl.so') || !metadata.includes('libcurl')) throw new Error('LPAC metadata mismatch: ' + architecture)
    const apk = await readFile(`${root}/${match[2]}`)
    const hash = createHash('sha256').update(apk).digest('hex')
    if (hash !== match[1]) throw new Error('LPAC checksum mismatch: ' + architecture)
    attachments.push({ name: match[2], apk, hash })
  }
  const name = 'lpac-2.3.0_p9-r2-curl-source.tar.gz'
  const apk = await readFile('build/lpac-sdk/' + name)
  const sums = (await readFile('build/lpac-sdk/source-SHA256SUMS', 'utf8')).trim()
  const hash = createHash('sha256').update(apk).digest('hex')
  if (sums !== `${hash}  ${name}`) throw new Error('LPAC source checksum mismatch')
  attachments.push({ name, apk, hash })
}
const artifacts = [...apks, ...attachments]
const checksumFile = Buffer.from(artifacts.map(item => `${item.hash}  ${item.name}`).join('\n') + '\n')
artifacts.push({ name: 'SHA256SUMS', apk: checksumFile, hash: createHash('sha256').update(checksumFile).digest('hex') })
const credential = execFileSync('git', ['credential','fill'], { input: 'protocol=https\nhost=github.com\n\n', cwd: homedir(), encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true })
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9)
if (!token) throw new Error('GitHub credential unavailable')
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }
const endpoint = 'https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/releases'
const notes = process.argv[3] && process.argv[3] !== '-' ? (await readFile(process.argv[3], 'utf8')).trim() : undefined
let response = await fetch(`${endpoint}/tags/${version}`, { headers })
let release: { id: number; upload_url: string; html_url: string; body: string }
if (response.status === 404) {
  const tag = await fetch(`https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/git/ref/tags/${version}`, { headers })
  if (!tag.ok) throw new Error(`Push the release tag first: ${tag.status}`)
  response = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ tag_name: version, name: `CPE Status ${version}`, draft: true, body: notes || '发布说明和模块适配、安装及配置方法见仓库 README.md 与 DEV.md。' }) })
}
if (!response.ok) throw new Error(`GitHub release failed: ${response.status}`)
release = await response.json() as typeof release
const assets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!assets.ok) throw new Error(`Cannot list release assets: ${assets.status}`)
interface ReleaseAsset { id: number; name: string; digest?: string; browser_download_url: string }
const existing = await assets.json() as ReleaseAsset[]
async function verify(asset: ReleaseAsset, expected: string) {
  let digest = asset.digest
  if (!digest) {
    const download = await fetch(asset.browser_download_url)
    if (!download.ok) throw new Error(`Cannot verify existing asset: ${download.status}`)
    digest = 'sha256:' + createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex')
  }
  if (digest !== 'sha256:' + expected) throw new Error('Existing release asset checksum mismatch: ' + asset.name)
}
for (const item of artifacts) {
  const current = existing.find(asset => asset.name === item.name)
  if (current) { await verify(current, item.hash); continue }
  const legacy = 'architecture' in item && item.architecture === 'aarch64_cortex-a53' ? existing.find(asset => asset.name === `luci-app-cpe-status-${version.slice(1)}-r${revision}.apk`) : undefined
  if (legacy) {
    await verify(legacy, item.hash)
    const renamed = await fetch(`${endpoint}/assets/${legacy.id}`, { method: 'PATCH', headers, body: JSON.stringify({ name: item.name }) })
    if (!renamed.ok) throw new Error(`APK rename failed: ${renamed.status}`)
    continue
  }
  const upload = await fetch(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(item.name), { method:'POST', headers: { ...headers, 'Content-Type':'application/octet-stream' }, body: new Uint8Array(item.apk) })
  if (!upload.ok) throw new Error(`APK upload failed: ${upload.status}`)
}
const finalAssets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!finalAssets.ok) throw new Error(`Cannot verify release assets: ${finalAssets.status}`)
let published = await finalAssets.json() as ReleaseAsset[]
for (const item of artifacts) {
  const asset = published.find(value => value.name === item.name)
  if (!asset) throw new Error('Uploaded APK is missing: ' + item.name)
  await verify(asset, item.hash)
}
// Only prune after all requested replacements have uploaded and passed checksum
// verification. Restrict deletion to this version and the requested architectures.
const removed: string[] = []
if (pruneOldApks) {
  for (const asset of published) {
    const match = /^luci-app-cpe-status-([\d.]+)-r\d+(?:-(aarch64_cortex-a53|x86_64))?\.apk$/.exec(asset.name)
    const architecture = match?.[2] || 'aarch64_cortex-a53'
    if (!match || match[1] !== version.slice(1) || !architectures.includes(architecture as SdkArchitecture)
      || apks.some(item => item.name === asset.name)) continue
    const deleted = await fetch(`${endpoint}/assets/${asset.id}`, { method: 'DELETE', headers })
    if (!deleted.ok) throw new Error(`Cannot remove obsolete APK ${asset.name}: ${deleted.status}`)
    removed.push(asset.name)
  }
  const refreshed = await fetch(`${endpoint}/${release.id}/assets`, { headers })
  if (!refreshed.ok) throw new Error(`Cannot verify remaining release assets: ${refreshed.status}`)
  published = await refreshed.json() as ReleaseAsset[]
  if (published.some(asset => removed.includes(asset.name))) throw new Error('Obsolete APK still exists')
}
const rows = published.filter(asset => /-(aarch64_cortex-a53|x86_64)\.apk$/.test(asset.name)).map(asset => {
  const architecture = /-(aarch64_cortex-a53|x86_64)\.apk$/.exec(asset.name)![1]
  const hash = asset.digest?.replace(/^sha256:/, '') || artifacts.find(item => item.name === asset.name)?.hash || '-'
  return `| ${architecture} | [${asset.name}](${asset.browser_download_url}) | \`${hash}\` |`
})
const intro = notes ?? release.body.split('\n\nImmortalWrt 25.12.2')[0]
const verification = published.some(asset => asset.name.endsWith('-x86_64.apk')) ? '\n\nx86_64 包已完成 SDK 构建及包完整性、架构和依赖检查，尚未进行 x86 路由器实机验证。' : ''
const updated = await fetch(`${endpoint}/${release.id}`, { method: 'PATCH', headers, body: JSON.stringify({ draft: false, make_latest: 'true', body: `${intro}\n\nImmortalWrt 25.12.2 APK\n\n| 架构 | 下载 | SHA256 |\n| --- | --- | --- |\n${rows.join('\n')}${verification}` }) })
if (!updated.ok) throw new Error(`Release notes update failed: ${updated.status}`)
console.log(JSON.stringify({ release: release.html_url, artifacts: artifacts.map(({name,hash}) => ({ name, sha256: hash })), removed }))
