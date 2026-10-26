import { statusRuntime } from './status-collector.ts'

// sms_tool's AT reader has a fixed five-second alarm. QSCAN needs a separate
// bounded comgt reader; only the locked control worker invokes this script.
// Always run with -s to skip comgt's default SIM/network setup script.
export const cellScanAt = String.raw`opengt
set com 115200n81
set comecho off
set senddelay 0.01
waitquiet 0.2 0.2
let $c = $env("CPE_SCAN_COMMAND")
send $c
send "^m"
:read
get 180 "^m^j" $s
if % = -1 goto timeout
if len($s) = 0 goto read
print $s,"\n"
let f=0
:trim
if f >= len($s) goto read
if $mid($s,f,1) = "\n" goto skip
if $mid($s,f,1) = "\r" goto skip
if $mid($s,f,1) = " " goto skip
goto terminal
:skip
let f=f+1
goto trim
:terminal
if $mid($s,f,2) = "OK" exit 0
if $mid($s,f,5) = "ERROR" exit 1
if $mid($s,f,10) = "+CME ERROR" exit 1
if $mid($s,f,10) = "+CMS ERROR" exit 1
goto read
:timeout
exit 1
`

// Polling this helper only reads files. It never starts or repeats a scan.
export const cellScanReader = statusRuntime + String.raw`
if (length(ARGV)) die('Scan result reader accepts no arguments');
let previous = readJSON(directory + '/cell-scan.json');
if (previous?.device != port) previous = null;
let active = readJSON(directory + '/scan-active.json');
let job = active && match(active.id || '', /^[0-9]+-[0-9]+$/) ? readJSON(directory + '/control-' + active.id + '.json') : null;
if (job?.device != port || job?.profile_key != profileKey || job?.interface != iface || job?.kind != 'scan') job = null;
let scanning = job?.status == 'pending' && time() - job.started < 225;
print(sprintf('%J\n', { status: scanning ? 'deferred' : job?.status == 'pending' ? 'error' : job?.status || 'ok', scanning,
  job_id: job?.id, data: previous ? { raw: previous.raw, records: previous.records, sampled_at: previous.sampled_at } : null,
  message: scanning ? '正在扫描 LTE / NR 小区，保留当前列表' : job?.status == 'pending' ? '扫描超时，保留当前列表' : job?.message || '' }));
`
