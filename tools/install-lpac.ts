// Install the verified ARM64 curl build; real-card verification is read-only.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const router=process.env.CPE_ROUTER || 'root@192.168.2.248'
const options=['-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts']
const root=resolve('build/lpac-sdk/aarch64_cortex-a53')
const name='lpac-2.3.0_p9-r2-aarch64_cortex-a53.apk'
const expected=JSON.parse(await readFile(`${root}/verified.json`,'utf8')) as {filename:string;sha256:string}
const hash=createHash('sha256').update(await readFile(`${root}/${name}`)).digest('hex')
if (expected.filename!==name || hash!==expected.sha256) throw new Error('LPAC artifact checksum mismatch')
const ssh=(script:string)=>execFileSync('ssh',[...options,router,'sh -s'],{input:script+'\n',encoding:'utf8',windowsHide:true,timeout:90_000})
if (ssh('cat /etc/apk/arch').trim()!=='aarch64_cortex-a53') throw new Error('Target architecture mismatch')
execFileSync('scp',['-O',...options,`${root}/${name}`,`${router}:/root/${name}`],{stdio:'inherit',windowsHide:true})
const backup='/root/lpac-before-curl-'+Date.now()
const output=ssh(String.raw`set -eu
printf '%s  %s\n' '__HASH__' '/root/__APK__' | sha256sum -c -
test -d /usr/lib/lpac
lock=/tmp/cpe-status/lock
mkdir -p /tmp/cpe-status
acquired=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if mkdir "$lock" 2>/dev/null; then acquired=1; break; fi
  sleep 1
done
test "$acquired" = 1 || { echo 'Modem lock is busy; nothing installed'; exit 1; }
echo "$$" > "$lock/pid"
trap 'test "$(cat "$lock/pid" 2>/dev/null)" != "$$" || { rm -f "$lock/pid"; rmdir "$lock"; }' EXIT
if pidof lpac >/dev/null; then echo 'LPAC is busy; nothing installed'; exit 1; fi
umask 077
backup=__BACKUP__
mkdir "$backup"
cp /etc/config/lpac "$backup/lpac.config"
tar -czf "$backup/lpac-files.tgz" -C / usr/bin/lpac usr/lib/lpac etc/config/lpac
apk list --installed > "$backup/packages.before" 2>/dev/null
before=$(uci export network | sha256sum)
apk add --simulate --network=no --allow-untrusted /root/__APK__
apk add --network=no --allow-untrusted /root/__APK__
uci set lpac.global.http_backend='curl'
uci commit lpac
after=$(uci export network | sha256sum)
test "$before" = "$after" || { echo 'Unexpected network configuration change'; exit 1; }
readonly_lpac() {
  label="$1"; shift
  /usr/bin/setsid /usr/bin/lpac "$@" </dev/null > "$backup/$label.json" 2> "$backup/$label.stderr" & child=$!
  (sleep 10; /bin/kill -TERM -"$child"; sleep 1; /bin/kill -KILL -"$child") >/dev/null 2>&1 & guard=$!
  rc=0; wait "$child" || rc=$?
  /bin/kill -KILL -"$child" 2>/dev/null || true
  kill "$guard" 2>/dev/null || true
  wait "$guard" 2>/dev/null || true
  test "$rc" = 0 || { cat "$backup/$label.stderr"; exit "$rc"; }
}
readonly_lpac drivers driver list
readonly_lpac chip chip info
printf '\nCPE_LPAC_READONLY_RESULT\n'
cat "$backup/drivers.json" "$backup/chip.json"
printf '\nHTTP_BACKEND='; uci get lpac.global.http_backend
printf 'APDU_BACKEND='; uci get lpac.global.apdu_backend
printf 'BACKUP=%s\n' "$backup"
apk list --installed lpac 2>/dev/null
`.replaceAll('__HASH__',hash).replaceAll('__APK__',name).replaceAll('__BACKUP__',backup))
const result=output.split('CPE_LPAC_READONLY_RESULT\n')[1] || ''
const events=result.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}) as {type:string;payload:Record<string,unknown>}[]
const drivers=events.find(event=>event.type==='driver')?.payload
const chip=events.find(event=>event.type==='lpa')?.payload
if (!Array.isArray(drivers?.LPAC_HTTP) || !drivers.LPAC_HTTP.includes('curl')) throw new Error('Installed curl HTTP driver is missing')
const data=chip?.data as {eidValue?:string} | undefined
if (chip?.code!==0 || !/^[0-9]{32}$/.test(data?.eidValue || '')) throw new Error('Installed LPAC did not read the eUICC chip')
const summary={router,version:'2.3.0_p9-r2',sha256:hash,backup,http_backend:'curl',drivers,eid_suffix:data?.eidValue?.slice(-6),read_only:true,network_config_unchanged:true}
await mkdir('build/router-audit',{recursive:true})
await writeFile('build/router-audit/lpac-install.json',JSON.stringify(summary,null,2))
console.log(output.split('CPE_LPAC_READONLY_RESULT\n')[0])
console.log(JSON.stringify(summary,null,2))
