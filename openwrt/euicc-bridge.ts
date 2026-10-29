// Adapted from fildunsky/luci-app-5gmodem esim.sh run_lpac() and
// esim-apdu-bridge.sh, commit f495ea89c87c19194672666280e143e58993f7fa.
// Copyright 2026 Fil Dunsky; GPL-3.0-only. Our adaptations use ucode JSON
// parsing, owned-channel cleanup, verified TLS and the caller's process group.
export const euiccBridgeRunner = String.raw`#!/bin/sh
set -eu
umask 077
exec 5>&1
directory=$(mktemp -d "__ENV__{CPE_STATUS_CACHE:-/tmp/cpe-status}/lpac-bridge.XXXXXX")
child= bridge=
cleanup() {
  [ -z "$child" ] || kill "$child" 2>/dev/null || true
  [ -z "$bridge" ] || kill "$bridge" 2>/dev/null || true
  rm -f "$directory/in" "$directory/out" "$directory/request" "$directory/body" "$directory/headers" "$directory/at" "$directory/ca.pem"
  rmdir "$directory" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP
mkfifo "$directory/in" "$directory/out"
# Hold both ends while starting the children, avoiding FIFO open deadlocks.
exec 3<>"$directory/in" 4<>"$directory/out"
"__ENV__{CPE_STATUS_EUICC_BRIDGE:-/usr/libexec/cpe-status/esim-apdu-bridge}" "$directory" "$CPE_LPAC_OUTPUT" <"$directory/out" >"$directory/in" 3>&- 4>&- & bridge=$!
"$@" <"$directory/in" >"$directory/out" 3>&- 4>&- & child=$!
exec 3>&- 4>&-
rc=0
wait "$child" || rc=$?
child=
wait "$bridge" || rc=$?
bridge=
exit "$rc"
`.replaceAll('__ENV__', '$')

export const euiccBridge = String.raw`#!/usr/bin/ucode
// GPL-3.0-only; adapted from Fil Dunsky's 5gmodem eSIM bridge (see source).
import {open,fdopen,readfile,writefile,stat,unlink} from 'fs';
// Reopening /dev/stdout opens the FIFO again and can block forever when lpac
// exits before the relay starts. Use the already-open descriptors instead.
const dir=ARGV[0], output=ARGV[1], input=fdopen(0,'r'), wire=fdopen(1,'w');
const console=output=='-' ? fdopen(5,'w') : null, trace=getenv('CPE_LPAC_TRACE')=='1';
const port=getenv('LPAC_APDU_AT_DEVICE') || '/dev/ttyUSB2';
let channel=null;
function quote(v) { return "'"+replace(v,/'/g,"'\\''")+"'"; }
function response(kind,payload) { wire.write(sprintf('%J\n',{type:kind,payload})); wire.flush(); }
function note(message) { warn('eUICC bridge: '+message+'\n'); }
function event(line) {
  let f=console || open(output,'a'); if (!f) die('Cannot append LPAC output');
  f.write(line+'\n'); f.flush(); if (!console) f.close();
}
function relay(kind,payload) {
  if (trace) event(sprintf('%J',{type:kind,direction:'response',payload}));
  response(kind,payload);
}
function bin(value) {
  if (type(value)!='string' || length(value)%2 || match(value,/[^0-9a-f]/i)) die('Invalid hexadecimal payload');
  let result=''; for (let i=0;i<length(value);i+=2) result+=chr(hex(substr(value,i,2))); return result;
}
function hexify(value) { let result=''; for (let i=0;i<length(value);i++) result+=sprintf('%02x',ord(substr(value,i,1))); return result; }
function at(cmd) {
  if (!match(port,/^\/dev\/tty[A-Za-z0-9_.-]+$/)) die('Invalid AT port');
  let path=dir+'/at';
  let rc=system('sms_tool -d '+quote(port)+' at '+quote(cmd)+' >'+quote(path)+' 2>/dev/null');
  let raw=replace(readfile(path) || '',/\r/g,''); unlink(path);
  // sms_tool may consume the terminating OK. Validate the operation-specific
  // response below, and reject explicit modem errors instead of requiring it.
  if (rc || match(raw,/(^|\n)(ERROR|\+CME ERROR|\+CMS ERROR)(:|\n|$)/)) die('AT command failed: '+split(cmd,'=')[0]);
  return raw;
}
function apdu(p) {
  let param=p.param || '';
  if (p.func=='connect') return {ecode:0};
  if (p.func=='disconnect') { if (channel!=null) { at('AT+CCHC='+channel); channel=null; } return {ecode:0}; }
  if (p.func=='logic_channel_open') {
    if (channel!=null || !match(param,/^[0-9a-f]{10,64}$/i) || length(param)%2) die('Invalid logical-channel request');
    let raw=at('AT+CCHO="'+uc(param)+'"'), found=match(raw,/(^|\n)(\+CCHO:\s*)?([0-9]+)\s*(\n|$)/);
    if (!found || +found[3]<1 || +found[3]>19) die('No logical channel returned');
    channel=+found[3]; return {ecode:channel};
  }
  if (p.func=='logic_channel_close') {
    if (!match(param,/^[0-9a-f]{2}$/i) || hex(param)!=channel) die('Logical channel is not owned by this bridge');
    at('AT+CCHC='+channel); channel=null; return {ecode:0};
  }
  if (p.func=='transmit') {
    if (channel==null || length(param)<8 || length(param)>131072 || !match(param,/^[0-9a-f]+$/i) || length(param)%2) die('Invalid APDU');
    // CGLA lengths count hex characters. Never resend a write after a lost
    // response, and never close channels belonging to another application.
    let raw=at('AT+CGLA='+channel+','+length(param)+',"'+uc(param)+'"');
    let found=match(raw,/\+CGLA:\s*([0-9]+)\s*,\s*"([0-9a-f]+)"/i);
    if (!found || +found[1]!=length(found[2]) || length(found[2])%2) die('Invalid CGLA response');
    return {ecode:0,data:found[2]};
  }
  die('Unknown APDU bridge operation');
}
function http(p) {
  if (type(p.url)!='string' || !match(p.url,/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?\/[^\r\n]*$/) || length(p.url)>4096) die('Invalid HTTPS endpoint');
  let tx=bin(p.tx || ''), headers=p.headers || [];
  if (length(tx)>4194304 || type(headers)!='array' || length(headers)>32) die('HTTP request limit exceeded');
  let request=dir+'/request', body=dir+'/body', head=dir+'/headers';
  writefile(request,tx); unlink(body); unlink(head);
  let args='';
  for (let h in headers) {
    if (type(h)!='string' || length(h)>8192 || match(h,/[\r\n]/) || !match(h,/^[a-zA-Z0-9-]+:/)) die('Invalid HTTP header');
    args+=' -H '+quote(h);
  }
  // Upstream's HTTP relay uses GNU wget (OpenSSL), with curl as fallback.
  // curl is installed by our package; keep TLS verification enabled.
  let cmd='curl --silent --show-error --compressed --proto =https --connect-timeout 15 --max-time 60 --max-filesize 8388608 --dump-header '+quote(head)+' --output '+quote(body)+' -H '+quote('Connection: close')+args;
  if (length(tx)) cmd+=' --data-binary '+quote('@'+request);
  let certificates='';
  for (let ca in ['/etc/ssl/certs/ca-certificates.crt',getenv('CPE_LPAC_RSP_CA') || '/usr/share/cpe-status/certs/gsma-ci.pem',getenv('CPE_LPAC_CA_BUNDLE') || '/etc/cpe-status/esim-ca.pem']) {
    let pem=readfile(ca); if (pem) certificates+=pem+'\n';
  }
  if (length(certificates)) { writefile(dir+'/ca.pem',certificates); cmd+=' --cacert '+quote(dir+'/ca.pem'); }
  // Test RSP servers may use a private test CA. Never silently retry without
  // validation; the user must explicitly opt out or supply their CA bundle.
  if (getenv('CPE_LPAC_TLS_VERIFY')=='0') { note('TLS certificate verification disabled by explicit setting'); cmd+=' --insecure'; }
  let rc=system(cmd+' '+quote(p.url));
  let matches=match(readfile(head) || '',/HTTP\/[0-9.]+\s+([0-9]{3})/g), code=0;
  if (matches) for (let line in matches) { let m=match(line,/\s([0-9]{3})/); if (m) code=+m[1]; }
  if (rc || !code || (stat(body)?.size || 0)>8388608) die('HTTPS transport failed');
  let result={rcode:code,rx:hexify(readfile(body) || '')};
  unlink(request); unlink(body); unlink(head); return result;
}
let line;
while ((line=input.read('line'))!=null) {
  line=trim(line); if (!length(line)) continue;
  let request=null;
  try { request=json(line); } catch(e) { event(line); continue; }
  if (index(['apdu','http'],request?.type)<0) {
    // LPAC can print its final result before closing the channel. Keep the
    // relay alive through disconnect, until the lpac process closes stdout.
    event(line); continue;
  }
  if (trace) event(sprintf('%J',{...request,direction:'request'}));
  try {
    if (request.type=='apdu' && getenv('LPAC_APDU')!='stdio') die('Unexpected APDU bridge request');
    if (request.type=='http' && getenv('LPAC_HTTP')!='stdio') die('Unexpected HTTP bridge request');
    relay(request.type,request.type=='apdu' ? apdu(request.payload) : http(request.payload));
  } catch(e) { note(''+e); relay(request.type,request.type=='apdu' ? {ecode:-1} : {rcode:0,rx:''}); }
}
if (channel!=null) { try { at('AT+CCHC='+channel); } catch(e) { note('Owned-channel cleanup failed'); } }
input.close();
`

// Standalone CLI entry point: a real shell PID owns the shared lock, and a
// private process group bounds both lpac and the relay even outside the API.
export const euiccBridgeCli = String.raw`#!/bin/sh
set -eu
umask 077
log_file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --log) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo '--log requires a file path' >&2; exit 64; }; log_file=$2; shift 2;;
    --log=*) log_file=__ENV__{1#--log=}; [ -n "$log_file" ] || exit 64; shift;;
    --) shift; break;;
    *) break;;
  esac
done
case "__ENV__{1:-}" in chip|profile|notification|driver) ;; *) echo 'Usage: cpe-status-lpac-test [--log FILE] chip info | profile list | profile download -a CODE' >&2; exit 64;; esac
cache=__ENV__{CPE_STATUS_CACHE:-/tmp/cpe-status}
lock=__ENV__{CPE_STATUS_LOCK:-$cache/lock}
seconds=__ENV__{CPE_LPAC_TIMEOUT:-180}
case "$seconds" in ''|*[!0-9]*) echo 'Invalid timeout' >&2; exit 64;; esac
[ "$seconds" -ge 1 ] && [ "$seconds" -le 600 ] || exit 64
mkdir -p "$cache"
mkdir "$lock" 2>/dev/null || { echo 'Modem 正忙，请稍后重试' >&2; exit 75; }
echo $$ > "$lock/pid"
child= guard= marker= temporary=
download_marker=
cleanup() {
  trap '' TERM INT HUP
  [ -z "$child" ] || /bin/kill -KILL -"$child" 2>/dev/null || true
  [ -z "$guard" ] || /bin/kill -KILL -"$guard" 2>/dev/null || true
  [ -z "$child" ] || wait "$child" 2>/dev/null || true
  [ -z "$guard" ] || wait "$guard" 2>/dev/null || true
  [ -z "$marker" ] || rm -f "$marker"
  [ -z "$temporary" ] || rmdir "$temporary" 2>/dev/null || true
  if [ -n "$download_marker" ] && grep -q '"pid":'"$$"',' "$download_marker" 2>/dev/null; then rm -f "$download_marker"; fi
  if [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [ "$1" = profile ] && [ "__ENV__{2:-}" = download ]; then
  download_marker=$cache/euicc-cli-download.json
  printf '{"pid":%s,"until":%s}\n' "$$" "$(( $(date +%s) + seconds + 5 ))" > "$download_marker.$$"
  mv "$download_marker.$$" "$download_marker"
fi
export LPAC_DRIVER_HOME=__ENV__{LPAC_DRIVER_HOME:-/usr/lib/lpac}
export LPAC_APDU=__ENV__{CPE_TEST_APDU:-uqmi} LPAC_HTTP=stdio
export LPAC_APDU_QMI_DEVICE=__ENV__{LPAC_APDU_QMI_DEVICE:-/dev/cdc-wdm0}
export LPAC_APDU_QMI_UIM_SLOT=__ENV__{LPAC_APDU_QMI_UIM_SLOT:-1}
export LPAC_APDU_AT_DEVICE=__ENV__{LPAC_APDU_AT_DEVICE:-/dev/ttyUSB2}
export CPE_LPAC_OUTPUT=- CPE_LPAC_TRACE=1
temporary=$(mktemp -d "$cache/lpac-cli.XXXXXX")
marker=$temporary/timeout
runner=__ENV__{CPE_STATUS_LPAC_RUNNER:-/usr/libexec/cpe-status/lpac-run}
native=__ENV__{CPE_STATUS_LPAC_NATIVE:-/usr/lib/lpac/lpac}
if [ -n "$log_file" ]; then
  /usr/bin/setsid "$runner" "$native" "$@" </dev/null >"$log_file" 2>&1 & child=$!
else
  /usr/bin/setsid "$runner" "$native" "$@" </dev/null & child=$!
fi
/usr/bin/setsid /bin/sh -c 'sleep "$1"; touch "$2"; /bin/kill -TERM -"$3"; sleep 1; /bin/kill -KILL -"$3"' sh "$seconds" "$marker" "$child" >/dev/null 2>&1 & guard=$!
rc=0
wait "$child" || rc=$?
if [ -f "$marker" ]; then echo 'LPAC 超时，操作已终止' >&2; rc=124; fi
exit "$rc"
`.replaceAll('__ENV__', '$')

// Public GSMA RSP2 Root CI1, also distributed by the upstream 5gmodem bridge.
// SHA256 5e3e91fd454327c3af5d32a7a73bbc59fe43aa7d85fd32d5db44423f80a56bb3
export const euiccRspRootCa = `-----BEGIN CERTIFICATE-----
MIICSTCCAe+gAwIBAgIQbmhWeneg7nyF7hg5Y9+qejAKBggqhkjOPQQDAjBEMRgw
FgYDVQQKEw9HU00gQXNzb2NpYXRpb24xKDAmBgNVBAMTH0dTTSBBc3NvY2lhdGlv
biAtIFJTUDIgUm9vdCBDSTEwIBcNMTcwMjIyMDAwMDAwWhgPMjA1MjAyMjEyMzU5
NTlaMEQxGDAWBgNVBAoTD0dTTSBBc3NvY2lhdGlvbjEoMCYGA1UEAxMfR1NNIEFz
c29jaWF0aW9uIC0gUlNQMiBSb290IENJMTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABJ1qutL0HCMX52GJ6/jeibsAqZfULWj/X10p/Min6seZN+hf5llovbCNuB2n
unLz+O8UD0SUCBUVo8e6n9X1TuajgcAwgb0wDgYDVR0PAQH/BAQDAgEGMA8GA1Ud
EwEB/wQFMAMBAf8wEwYDVR0RBAwwCogIKwYBBAGC6WAwFwYDVR0gAQH/BA0wCzAJ
BgdngRIBAgEAME0GA1UdHwRGMEQwQqBAoD6GPGh0dHA6Ly9nc21hLWNybC5zeW1h
dXRoLmNvbS9vZmZsaW5lY2EvZ3NtYS1yc3AyLXJvb3QtY2kxLmNybDAdBgNVHQ4E
FgQUgTcPUSXQsdQI1MOyMubSXnlb6/swCgYIKoZIzj0EAwIDSAAwRQIgIJdYsOMF
WziPK7l8nh5mu0qiRiVf25oa9ullG/OIASwCIQDqCmDrYf+GziHXBOiwJwnBaeBO
aFsiLzIEOaUuZwdNUw==
-----END CERTIFICATE-----
`
