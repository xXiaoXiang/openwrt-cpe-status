import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { packageManifest, packageRelease } from '../project.ts'

const version = process.argv[2]
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Usage: publish-release.ts vX.Y.Z [notes-file]')
const revision = version.slice(1) === packageManifest.version ? packageRelease : 0
const apkPath = `build/sdk-test/luci-app-cpe-status-${version.slice(1)}-r${revision}.apk`
const apk = await readFile(apkPath)
const hash = createHash('sha256').update(apk).digest('hex')
const credential = execFileSync('git', ['credential','fill'], { input: 'protocol=https\nhost=github.com\n\n', cwd: homedir(), encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, windowsHide: true })
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9)
if (!token) throw new Error('GitHub credential unavailable')
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
const endpoint = 'https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/releases'
let response = await fetch(`${endpoint}/tags/${version}`, { headers })
let release: { id: number; upload_url: string; html_url: string }
if (response.status === 404) {
  const tag = await fetch(`https://api.github.com/repos/xXiaoXiang/openwrt-cpe-status/git/ref/tags/${version}`, { headers })
  if (!tag.ok) throw new Error(`Push the release tag first: ${tag.status}`)
  const body = process.argv[3] ? await readFile(process.argv[3], 'utf8') : '发布说明和模块适配、安装及配置方法见仓库 README.md 与 DEV.md。'
  response = await fetch(endpoint, { method:'POST', headers, body: JSON.stringify({ tag_name: version, name: `CPE Status ${version}`, body: `${body.trim()}\n\nImmortalWrt 25.12.2 / aarch64_cortex-a53 APK\n\n软件包：\`${basename(apkPath)}\`\n\nSHA256: \`${hash}\`` }) })
}
if (!response.ok) throw new Error(`GitHub release failed: ${response.status}`)
release = await response.json() as typeof release
const assets = await fetch(`${endpoint}/${release.id}/assets`, { headers })
if (!assets.ok) throw new Error(`Cannot list release assets: ${assets.status}`)
const existing = await assets.json() as { name: string }[]
if (!existing.some(asset => asset.name === basename(apkPath))) {
  const upload = await fetch(release.upload_url.split('{')[0] + '?name=' + encodeURIComponent(basename(apkPath)), { method:'POST', headers: { ...headers, 'Content-Type':'application/octet-stream' }, body: apk })
  if (!upload.ok) throw new Error(`APK upload failed: ${upload.status}`)
}
console.log(JSON.stringify({ release: release.html_url, apk: basename(apkPath), sha256: hash }))
