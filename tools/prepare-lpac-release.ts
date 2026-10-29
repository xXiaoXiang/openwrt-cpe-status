// Fetch existing, verified SDK artifacts without changing or rebuilding LPAC.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { sdkTargets, type SdkArchitecture } from './sdk-targets.ts'

const host = 'baron@baron-omen.bulan'
const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', `UserKnownHostsFile=${homedir()}/.ssh/known_hosts`]
const root = 'cpe-status-build/lpac-curl'
const sourceName = 'lpac-2.3.0_p9-r2-curl-source.tar.gz'
const script = `set -eu
cd "$HOME/${root}"
for arch in aarch64_cortex-a53 x86_64; do
  grep -q BUILD_SUCCESS "$arch/build.log"
  (cd "$arch" && sha256sum -c SHA256SUMS)
  grep -q "^  arch: $arch$" "$arch/package-metadata.yaml"
  grep -q driver_http_curl.so "$arch/package-metadata.yaml"
  grep -q libcurl.so "$arch/curl-plugin-elf.txt"
  grep -q libssl.so "$arch/libcurl-elf.txt"
  grep -q libcrypto.so "$arch/libcurl-elf.txt"
done
grep -q '"curl"' x86_64/driver-list.json
cmp aarch64_cortex-a53/dl/lpac-2.3.0_p9.tar.zst x86_64/dl/lpac-2.3.0_p9.tar.zst
mkdir -p release-source
cp aarch64_cortex-a53/dl/lpac-2.3.0_p9.tar.zst release-source/
cp -a package release-source/openwrt
cp curl-support.patch upstream-commit.txt lpac-source-ref.txt release-source/
for arch in aarch64_cortex-a53 x86_64; do
  mkdir -p "release-source/$arch"
  cp "$arch/sdk.config" "$arch/build.sh" "release-source/$arch/"
done
tar -czf '${sourceName}' -C release-source .
sha256sum '${sourceName}' > source-SHA256SUMS
`
execFileSync('ssh', [...options, host, 'sh -s'], { input: script + '\n', stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
await mkdir('build/lpac-sdk', { recursive: true })
for (const file of [sourceName, 'source-SHA256SUMS']) {
  execFileSync('scp', [...options, `${host}:${root}/${file}`, 'build/lpac-sdk/'], { stdio: 'inherit', windowsHide: true })
}
const sourceHash = createHash('sha256').update(await readFile(`build/lpac-sdk/${sourceName}`)).digest('hex')
if ((await readFile('build/lpac-sdk/source-SHA256SUMS', 'utf8')).trim() !== `${sourceHash}  ${sourceName}`) throw new Error('LPAC source checksum mismatch')
for (const architecture of Object.keys(sdkTargets) as SdkArchitecture[]) {
  const directory = `build/lpac-sdk/${architecture}`
  const name = `lpac-2.3.0_p9-r2-${architecture}.apk`
  await mkdir(directory, { recursive: true })
  for (const file of [name, 'SHA256SUMS', 'package-metadata.yaml', 'curl-plugin-elf.txt', 'libcurl-elf.txt']) {
    execFileSync('scp', [...options, `${host}:${root}/${architecture}/${file}`, directory], { stdio: 'inherit', windowsHide: true })
  }
  const hash = createHash('sha256').update(await readFile(`${directory}/${name}`)).digest('hex')
  if ((await readFile(`${directory}/SHA256SUMS`, 'utf8')).trim() !== `${hash}  ${name}`) throw new Error('LPAC checksum mismatch: ' + architecture)
  await writeFile(`${directory}/verified.json`, JSON.stringify({ filename: name, sha256: hash, architecture, curl: true, tls: 'OpenSSL', source: sourceName }, null, 2))
  console.log(JSON.stringify({ name, sha256: hash, sourceHash }))
}
