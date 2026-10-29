// Isolated FIFO/APDU/HTTPS relay integration. All modem, HTTP and lpac I/O
// is mocked; this never downloads or changes a real eUICC profile.
import { execFileSync } from 'node:child_process'
import { euiccBridge, euiccBridgeRunner, euiccBridgeCli, euiccRspRootCa } from '../openwrt/euicc-bridge.ts'
import { X509Certificate } from 'node:crypto'
if (new X509Certificate(euiccRspRootCa).fingerprint256.replaceAll(':', '').toLowerCase() !== '5e3e91fd454327c3af5d32a7a73bbc59fe43aa7d85fd32d5db44423f80a56bb3') throw new Error('RSP CA fingerprint mismatch')
const root = '/tmp/cpe-bridge-check-' + Date.now()
const replace = (value: string) => value.replaceAll('__ROOT__', JSON.stringify(root))
const mockLpac = replace(String.raw`#!/usr/bin/ucode
import {open} from 'fs';
let input=open('/dev/stdin','r'), wire=open('/dev/stdout','w');
function ask(type,payload) {
  wire.write(sprintf('%J\n',{type,payload})); wire.flush();
  let result=json(input.read('line'));
  if (result.type!=type) die('Incorrect protocol response'); return result.payload;
}
if (getenv('LPAC_APDU')=='stdio') {
  if (ask('apdu',{func:'connect'}).ecode!=0) die('connect');
  if (ask('apdu',{func:'logic_channel_open',param:'A0000005591010FFFFFFFF8900000100'}).ecode!=2) die('open');
  let result=ask('apdu',{func:'transmit',param:'00A4040000'});
  if (ARGV[0]=='failure' ? result.ecode!=-1 : result.data!='9000') die('transmit');
}
wire.write('{"type":"progress","payload":{"code":0,"message":"fixture"}}\n'); wire.flush();
let reply=ask('http',{url:'https://example.test/gsma/es9',tx:'7b7d',headers:['Content-Type: application/json',"X-Quoted: a'b$(false)"]});
if (ARGV[0]=='tls-failure') {
  if (reply.rcode!=0) die('TLS error was hidden');
  wire.write('{"type":"lpa","payload":{"code":-1,"message":"transport failed"}}\n'); wire.flush(); exit(0);
}
if (reply.rcode!=200 || reply.rx!='7b226f6b223a747275657d') die('HTTPS response corrupted: '+sprintf('%J',reply));
let rejected=ask('http',{url:'https://example.test/gsma/es9',tx:'',headers:['X-Test: bad\r\nInjected: header']});
if (rejected.rcode!=0) die('Invalid header was accepted');
wire.write('{"type":"lpa","payload":{"code":0,"message":"success","data":{}}}\n'); wire.flush();
if (getenv('LPAC_APDU')=='stdio') {
  if (ask('apdu',{func:'logic_channel_close',param:'02'}).ecode!=0) die('close after final result');
  if (ask('apdu',{func:'disconnect'}).ecode!=0) die('disconnect after final result');
}
`)
const sms = replace(String.raw`#!/usr/bin/ucode
import {readfile,open} from 'fs';
const cmd=ARGV[3], f=open(__ROOT__+'/at-events','a'); f.write(cmd+'\n'); f.close();
if (cmd=='AT+CCHO="A0000005591010FFFFFFFF8900000100"') print('\r\n2\r\n');
else if (cmd=='AT+CCHC=2') print('\r\n');
else if (cmd=='AT+CGLA=2,10,"00A4040000"') print(readfile(__ROOT__+'/failure') ? '\r\nERROR\r\n' : '\r\n+CGLA: 4,"9000"\r\n');
else die('Unexpected AT operation: '+cmd);
`)
const curl = replace(String.raw`#!/usr/bin/ucode
import {writefile,readfile,open} from 'fs';
const f=open(__ROOT__+'/http-events','a'); f.write(sprintf('%J\n',ARGV)); f.close();
let head=ARGV[index(ARGV,'--dump-header')+1], body=ARGV[index(ARGV,'--output')+1];
let data=ARGV[index(ARGV,'--data-binary')+1];
if (index(ARGV,'--cacert')<0 || index(readfile(ARGV[index(ARGV,'--cacert')+1]),'CUSTOM_CA_FIXTURE')<0) die('CA bundle not applied');
if ((index(ARGV,'--insecure')>=0)!=(getenv('CPE_LPAC_TLS_VERIFY')=='0')) die('TLS verification setting ignored');
if (readfile(__ROOT__+'/curl-failure')) exit(60);
if (readfile(substr(data,1))!='{}' || ARGV[length(ARGV)-1]!='https://example.test/gsma/es9') die('HTTP request corrupted');
writefile(head,'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nContent-Type: application/json\r\n\r\n');
writefile(body,'{"ok":true}');
`)
const files = { bridge: euiccBridge, runner: euiccBridgeRunner, cli: euiccBridgeCli, lpac: mockLpac, 'bin/sms_tool': sms, 'bin/curl': curl, 'early-exit': '#!/bin/sh\nexit 64\n', hang: '#!/bin/sh\nsleep 30 &\necho $! > '+root+'/hung-child\nwait\n', 'custom-ca.pem': 'CUSTOM_CA_FIXTURE\n', 'rsp-ca.pem': euiccRspRootCa }
const script = ['set -eu', 'umask 077', `mkdir -p ${root}/bin ${root}/cache`,
  ...Object.entries(files).map(([name, contents]) => `cat > '${root}/${name}' <<'CPE_BRIDGE_EOF'\n${contents}\nCPE_BRIDGE_EOF`),
  `chmod +x ${root}/bridge ${root}/runner ${root}/cli ${root}/lpac ${root}/early-exit ${root}/hang ${root}/bin/*`,
  `ucode -c -o /dev/null ${root}/bridge`, `sh -n ${root}/runner`,
  `export PATH=${root}/bin:"$PATH" CPE_STATUS_CACHE=${root}/cache CPE_STATUS_EUICC_BRIDGE=${root}/bridge CPE_LPAC_OUTPUT=${root}/events LPAC_APDU=stdio LPAC_HTTP=stdio LPAC_APDU_AT_DEVICE=/dev/ttyUSB2`,
  `export CPE_LPAC_CA_BUNDLE=${root}/custom-ca.pem CPE_LPAC_RSP_CA=${root}/rsp-ca.pem`,
  'run_fixture() { /usr/bin/setsid "$@" & child=$!; (sleep 12; /bin/kill -TERM -"$child"; sleep 1; /bin/kill -KILL -"$child") >/dev/null 2>&1 & guard=$!; rc=0; wait "$child" || rc=$?; kill "$guard" 2>/dev/null || true; wait "$guard" 2>/dev/null || true; return "$rc"; }',
  `: > ${root}/events`, `run_fixture ${root}/runner ${root}/lpac`,
  `test "$(grep -c CGLA ${root}/at-events)" = 1`, `test "$(wc -l < ${root}/http-events)" = 1`,
  `test "$(wc -l < ${root}/events)" = 2`,
  `export LPAC_APDU=uqmi`, `run_fixture ${root}/runner ${root}/lpac`,
  `test "$(grep -c CGLA ${root}/at-events)" = 1`,
  `export LPAC_APDU=stdio`, `echo yes > ${root}/failure`, `run_fixture ${root}/runner ${root}/lpac failure`,
  `test "$(grep -c CGLA ${root}/at-events)" = 2`,
  `export LPAC_APDU=uqmi CPE_LPAC_TLS_VERIFY=0`, `run_fixture ${root}/runner ${root}/lpac`,
  `export CPE_LPAC_TLS_VERIFY=1`, `echo yes > ${root}/curl-failure`, `run_fixture ${root}/runner ${root}/lpac tls-failure`,
  // Repeated immediate exits exercise the FIFO startup race without any APDU.
  `for i in 1 2 3 4 5; do rc=0; run_fixture ${root}/runner ${root}/early-exit || rc=$?; test "$rc" = 64; done`,
  `test -z "$(ls -A ${root}/cache)"`,
  `export CPE_STATUS_LPAC_RUNNER=${root}/runner CPE_STATUS_LPAC_NATIVE=${root}/early-exit CPE_STATUS_LOCK=${root}/cache/lock`,
  `rc=0; run_fixture ${root}/cli profile list || rc=$?; test "$rc" = 64; test ! -d ${root}/cache/lock`,
  `rm ${root}/curl-failure`, `export CPE_STATUS_LPAC_NATIVE=${root}/lpac`,
  // Only the fake LPAC receives these profile arguments, never the real card.
  `run_fixture ${root}/cli profile list > ${root}/console`,
  `grep -q '"direction": "request"' ${root}/console`, `grep -q '"direction": "response"' ${root}/console`,
  `grep -q '7b226f6b223a747275657d' ${root}/console`,
  `run_fixture ${root}/cli --log ${root}/selected.log profile list > ${root}/quiet`,
  `test ! -s ${root}/quiet`, `grep -q '"direction": "response"' ${root}/selected.log`,
  `test -z "$(ls -A ${root}/cache)"`,
  `export CPE_STATUS_LPAC_NATIVE=${root}/hang CPE_LPAC_TIMEOUT=2`,
  `rc=0; run_fixture ${root}/cli profile download || rc=$?; test "$rc" = 124; test ! -d ${root}/cache/lock`,
  `test ! -f ${root}/cache/euicc-cli-download.json`, `test -z "$(ls -A ${root}/cache)"`,
  `hung=$(cat ${root}/hung-child); if test -f /proc/$hung/stat; then grep -q ') Z ' /proc/$hung/stat; fi`,
  `printf '%s\n' '{"stdio_apdu_http":true,"uqmi_stdio_http":true,"invalid_headers_rejected":true,"no_apdu_retries":true,"temporary_files_cleaned":true,"tls_settings_and_failure_verified":true,"immediate_exit_no_deadlock":true,"cli_timeout_releases_lock":true}'`,
  `find ${root} -type f -exec rm -f {} \\;`, `find ${root} -depth -type d -exec rmdir {} \\;`,
].join('\n')
try {
  console.log(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=C:/Users/Baron/.ssh/known_hosts', process.env.CPE_ROUTER || 'root@192.168.2.248', 'sh -s'], { input: script + '\n', encoding: 'utf8', windowsHide: true, timeout: 45_000 }))
} catch (error) { console.error('Fixture retained at ' + root); throw error }
