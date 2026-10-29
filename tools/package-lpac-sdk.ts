// Build the user's patched LPAC with native curl/HTTPS in the existing SDKs.
// This tool never installs packages on a router or invokes card operations.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { sdkArchitecture, sdkTargets } from './sdk-targets.ts'

const host = 'baron@baron-omen.bulan'
const root = 'cpe-status-build/lpac-curl'
const architecture = sdkArchitecture(process.argv[3])
const sdkRoot = sdkTargets[architecture].root
const action = process.argv[2] || 'status'
const version = '2.3.0_p9', release = 2
const filename = `lpac-${version}-r${release}-${architecture}.apk`
const destination = resolve('build/lpac-sdk', architecture)
const options = ['-o','BatchMode=yes','-o','ConnectTimeout=10','-o',`UserKnownHostsFile=${homedir()}/.ssh/known_hosts`]
async function run(binary: string, args: string[], input?: string) {
  const child = spawn(binary,args,{windowsHide:true,stdio:['pipe','inherit','inherit']})
  child.stdin.end(input)
  await new Promise<void>((done,fail)=>{child.on('error',fail);child.on('close',code=>code===0?done():fail(new Error(`${binary} exited ${code}`)))})
}
const ssh = (script: string) => run('ssh',[...options,host,'sh -s'],script+'\n')
const inspect = `set -eu
out="$HOME/${root}/${architecture}"
sdk="$HOME/${sdkRoot}/sdk"
grep -q BUILD_SUCCESS "$out/build.log"
cd "$sdk"
staging=$(find staging_dir -maxdepth 1 -type d -name 'target-*' | head -n 1)
curl_library=$(find "$staging/usr/lib" -type f -name 'libcurl.so.*' | head -n 1)
test -n "$curl_library"
readelf -d "$curl_library" > "$out/libcurl-elf.txt"
grep -q 'libssl.so' "$out/libcurl-elf.txt"
grep -q 'libcrypto.so' "$out/libcurl-elf.txt"
mkdir -p "$out/dependencies"
find bin -type f \\( -name 'libcurl4-*.apk' -o -name 'libopenssl3-*.apk' -o -name 'ca-bundle-*.apk' -o -name 'libqmi-*.apk' -o -name 'libmbim-*.apk' -o -name 'glib2-*.apk' \\) -exec cp -p -t "$out/dependencies" {} +
(cd "$out/dependencies" && sha256sum *.apk > SHA256SUMS)
if test '${architecture}' = x86_64; then
  image=$(find build_dir -type d -path '*/.pkgdir/lpac' | head -n 1)
  loader=$(find staging_dir -path '*/toolchain-*/lib/ld-musl-x86_64.so.1' | head -n 1)
  test -n "$image"; test -n "$loader"
  libraries="$PWD/$image/usr/lib:$PWD/$staging/usr/lib:$PWD/$(dirname "$loader")"
  LPAC_DRIVER_HOME="$PWD/$image/usr/lib/lpac" LPAC_APDU=stdio LPAC_HTTP=curl \\
    "$loader" --library-path "$libraries" "$image/usr/lib/lpac/lpac" driver list </dev/null > "$out/driver-list.json" 2> "$out/driver-list.stderr"
  grep -q 'curl' "$out/driver-list.json"
  curl_binary=$(find build_dir -path '*/curl-*/src/.libs/curl' -type f | head -n 1)
  if test -n "$curl_binary"; then
    OPENSSL_CONF=/dev/null "$loader" --library-path "$libraries" "$curl_binary" --version > "$out/curl-version.txt"
    grep -q 'OpenSSL' "$out/curl-version.txt"
    grep -q 'https' "$out/curl-version.txt"
  fi
fi
cmp "$out/sdk.config.before" .config
echo LPAC_INSPECTION_PASSED
`

if (action === 'prepare') {
  await ssh(`set -eu
mkdir -p "$HOME/${root}"
cd "$HOME/${root}"
if test ! -d upstream/.git; then
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch v2.3.0-r4 https://github.com/fildunsky/lpac-build.git upstream
fi
test "$(git -C upstream describe --tags --exact-match)" = v2.3.0-r4
test -z "$(git -C upstream status --porcelain)"
mkdir -p package
rsync -a --delete upstream/openwrt/ package/
python3 - <<'CPE_LPAC_PATCH'
from pathlib import Path
root=Path('package')
p=root/'Makefile'
s=p.read_text()
assert s.count('-DLPAC_WITH_HTTP_CURL=OFF')==1
assert s.count('PKG_RELEASE:=1')==1
s=s.replace('-DLPAC_WITH_HTTP_CURL=OFF','-DLPAC_WITH_HTTP_CURL=ON')
s=s.replace('PKG_RELEASE:=1','PKG_RELEASE:=2')
assert '+LPAC_WITH_UQMI:uqmi' in s
s=s.replace('+LPAC_WITH_UQMI:uqmi','+LPAC_WITH_UQMI:uqmi +libcurl +ca-bundle')
s=s.replace('and MBIM - plus the stdio HTTP bridge','and MBIM - plus native curl/HTTPS and the stdio HTTP bridge')
p.write_text(s)
p=root/'files/lpac.uci'
s=p.read_text(); assert "http_backend\\t'stdio'" in s
p.write_text(s.replace("http_backend\\t'stdio'","http_backend\\t'curl'"))
p=root/'files/lpac.sh'
s=p.read_text(); assert 'global http_backend stdio' in s
start=s.index('# stdio,')
end=s.index('HTTP_DEBUG=',start)
s=s[:start]+'# This build includes driver_http_curl.so and HTTPS support.\\nHTTP_BACKEND="$(uci_get lpac global http_backend curl)"\\n'+s[end:]
p.write_text(s)
CPE_LPAC_PATCH
git -C upstream rev-parse HEAD > upstream-commit.txt
git ls-remote https://github.com/fildunsky/lpac.git 'refs/tags/v2.3.0-fm350-p9*' > lpac-source-ref.txt
git diff --no-index upstream/openwrt package > curl-support.patch || test "$?" = 1
printf 'LPAC_CURL_SOURCE_READY\\n'
`)
} else if (action === 'start') {
  const job = `#!/bin/sh
set -eu
task_root="$HOME/${root}"
sdk_root="$HOME/${sdkRoot}"
out="$task_root/${architecture}"
test -f "$task_root/package/Makefile"
mkdir -p "$out"
mkdir "$sdk_root/build.lock" || { echo 'SDK is busy'; exit 1; }
cp "$sdk_root/sdk/.config" "$out/sdk.config.before"
trap 'cp "$out/sdk.config.before" "$sdk_root/sdk/.config"; rmdir "$sdk_root/build.lock"' EXIT
cd "$sdk_root/sdk"
./scripts/feeds install libqmi libmbim uqmi curl ca-bundle
mkdir -p package/lpac-curl
rsync -a --delete "$task_root/package/" package/lpac-curl/
sed -i -E '/^CONFIG_ALL=/d; /^CONFIG_ALL_KMODS=/d; /^CONFIG_ALL_NONSHARED=/d; /^CONFIG_PACKAGE_lpac=/d; /^CONFIG_LPAC_WITH_/d; /^# CONFIG_LPAC_WITH_/d; /^CONFIG_LIBCURL_(OPENSSL|MBEDTLS|WOLFSSL|GNUTLS|NOSSL|HTTP)=/d; /^# CONFIG_LIBCURL_(OPENSSL|MBEDTLS|WOLFSSL|GNUTLS|NOSSL|HTTP) is not set/d; s/^CONFIG_PACKAGE_(kmod-[^=]*)=.*/# CONFIG_PACKAGE_\\1 is not set/' .config
sed -i '/^CONFIG_LIBQMI_COLLECTION_/d; /^# CONFIG_LIBQMI_COLLECTION_/d' .config
cat >> .config <<'CPE_LPAC_CONFIG'
# CONFIG_ALL is not set
# CONFIG_ALL_KMODS is not set
# CONFIG_ALL_NONSHARED is not set
CONFIG_PACKAGE_lpac=m
# CONFIG_LPAC_WITH_PCSC is not set
CONFIG_LPAC_WITH_AT=y
CONFIG_LPAC_WITH_QMI=y
CONFIG_LPAC_WITH_UQMI=y
CONFIG_LPAC_WITH_MBIM=y
CONFIG_LIBQMI_COLLECTION_FULL=y
# CONFIG_LIBQMI_COLLECTION_BASIC is not set
# CONFIG_LIBQMI_COLLECTION_MINIMAL is not set
CONFIG_LIBCURL_OPENSSL=y
# CONFIG_LIBCURL_MBEDTLS is not set
# CONFIG_LIBCURL_WOLFSSL is not set
# CONFIG_LIBCURL_GNUTLS is not set
# CONFIG_LIBCURL_NOSSL is not set
CONFIG_LIBCURL_HTTP=y
CPE_LPAC_CONFIG
make defconfig </dev/null
grep -q '^CONFIG_LIBCURL_OPENSSL=y$' .config
grep -q '^CONFIG_LIBCURL_HTTP=y$' .config
grep -q '^CONFIG_LIBQMI_COLLECTION_FULL=y$' .config
make package/lpac-curl/clean V=s </dev/null
make package/lpac-curl/compile -j4 V=s DL_DIR="$out/dl" </dev/null
apk_path=$(find bin -type f -name 'lpac-${version}-r${release}.apk' | head -n 1)
test -n "$apk_path"
cp "$apk_path" "$out/${filename}"
cp .config "$out/sdk.config"
cp "$task_root/curl-support.patch" "$task_root/upstream-commit.txt" "$task_root/lpac-source-ref.txt" "$out/"
staging_dir/host/bin/apk --allow-untrusted verify "$out/${filename}"
staging_dir/host/bin/apk adbdump "$out/${filename}" > "$out/package-metadata.yaml"
grep -q '^  arch: ${architecture}$' "$out/package-metadata.yaml"
grep -q 'driver_http_curl.so' "$out/package-metadata.yaml"
grep -q 'libcurl' "$out/package-metadata.yaml"
curl_plugin=$(find build_dir/target-* -path '*/.pkgdir/lpac/usr/lib/lpac/driver/driver_http_curl.so' | head -n 1)
test -n "$curl_plugin"
readelf -h "$curl_plugin" > "$out/curl-plugin-elf.txt"
readelf -d "$curl_plugin" >> "$out/curl-plugin-elf.txt"
grep -q 'libcurl.so' "$out/curl-plugin-elf.txt"
cp package/lpac-curl/Makefile "$out/Makefile"
cd "$out"
sha256sum '${filename}' > SHA256SUMS
printf '\\nBUILD_SUCCESS\\n'
`
  await ssh(`set -eu
mkdir -p "$HOME/${root}/${architecture}"
cat > "$HOME/${root}/${architecture}/build.sh" <<'CPE_LPAC_BUILD_EOF'
${job}
CPE_LPAC_BUILD_EOF
nohup sh "$HOME/${root}/${architecture}/build.sh" > "$HOME/${root}/${architecture}/build.log" 2>&1 < /dev/null &
echo "build_pid=$!"
`)
} else if (action === 'status') {
  await ssh(`tail -c 10000 "$HOME/${root}/${architecture}/build.log" | tr '\\r' '\\n' | tail -n 8 | cut -c1-240`)
} else if (action === 'finalize') {
  // Resume artifact checks if the SDK removed the intermediate ipkg directory
  // after a successful compile; do not rebuild all runtime dependencies.
  await ssh(`set -eu
out="$HOME/${root}/${architecture}"
cd "$HOME/${sdkRoot}/sdk"
staging_dir/host/bin/apk --allow-untrusted verify "$out/${filename}"
grep -q '^  arch: ${architecture}$' "$out/package-metadata.yaml"
for plugin in driver_http_curl.so driver_apdu_qmi.so driver_apdu_mbim.so driver_apdu_at.so driver_apdu_uqmi.so; do grep -q "$plugin" "$out/package-metadata.yaml"; done
grep -q '^CONFIG_LIBQMI_COLLECTION_FULL=y$' "$out/sdk.config"
curl_plugin=$(find build_dir/target-* -path '*/.pkgdir/lpac/usr/lib/lpac/driver/driver_http_curl.so' | head -n 1)
test -n "$curl_plugin"
readelf -h "$curl_plugin" > "$out/curl-plugin-elf.txt"
readelf -d "$curl_plugin" >> "$out/curl-plugin-elf.txt"
grep -q 'libcurl.so' "$out/curl-plugin-elf.txt"
cp package/lpac-curl/Makefile "$out/Makefile"
(cd "$out" && sha256sum '${filename}' > SHA256SUMS)
cmp "$out/sdk.config.before" .config
printf '\\nBUILD_SUCCESS\\n' >> "$out/build.log"
echo LPAC_ARTIFACTS_READY
`)
} else if (action === 'inspect') {
  await ssh(inspect)
} else if (action === 'fetch') {
  await ssh(inspect)
  await mkdir(destination,{recursive:true})
  for (const file of [filename,'SHA256SUMS','package-metadata.yaml','sdk.config','curl-plugin-elf.txt','libcurl-elf.txt','Makefile','curl-support.patch','upstream-commit.txt','lpac-source-ref.txt','build.log','build.sh',...(architecture==='x86_64'?['driver-list.json','driver-list.stderr']:[])]) {
    await run('scp',[...options,`${host}:${root}/${architecture}/${file}`,destination])
  }
  await run('scp',[...options,'-r',`${host}:${root}/${architecture}/dependencies`,destination])
  const dependencySums = (await readFile(`${destination}/dependencies/SHA256SUMS`,'utf8')).trim().split('\n')
  for (const line of dependencySums) {
    const entry = /^([a-f0-9]{64})  ([a-zA-Z0-9._+-]+\.apk)$/.exec(line)
    if (!entry) throw new Error('Unexpected dependency manifest')
    const hash = createHash('sha256').update(await readFile(`${destination}/dependencies/${entry[2]}`)).digest('hex')
    if (hash !== entry[1]) throw new Error('Dependency checksum mismatch: '+entry[2])
  }
  const sum = (await readFile(`${destination}/SHA256SUMS`,'utf8')).trim()
  const expected = sum.split(/\s+/)
  const hash = createHash('sha256').update(await readFile(`${destination}/${filename}`)).digest('hex')
  if (expected[0] !== hash || expected[1] !== filename) throw new Error('LPAC checksum mismatch')
  await writeFile(`${destination}/verified.json`,JSON.stringify({filename,sha256:hash,architecture,curl:true,tls:'OpenSSL',installed:false},null,2))
  console.log(`Verified: ${destination}/${filename}`)
} else throw new Error('Usage: package-lpac-sdk.ts prepare|start|status|finalize|inspect|fetch [aarch64_cortex-a53|x86_64]')
