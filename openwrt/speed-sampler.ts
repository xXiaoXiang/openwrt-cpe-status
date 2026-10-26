// Independent of modem reads and of the browser refresh interval.
export const speedSampler = String.raw`#!/usr/bin/ucode
import { readfile, writefile, rename, mkdir, glob, readlink } from 'fs';
const directory = getenv('CPE_STATUS_CACHE') || '/tmp/cpe-status';
mkdir(directory, 0700);
const pid = +readlink('/proc/self');
let previous = null;
while (true) {
  let now = +split(readfile('/proc/uptime'), ' ')[0], counters = [];
  for (let file in glob('/sys/class/net/*/statistics/rx_bytes')) {
    push(counters, { interface: split(file, '/')[4], rx: +readfile(file), tx: +readfile(replace(file, 'rx_bytes', 'tx_bytes')) });
  }
  if (previous && now > previous.time) {
    let path = directory + '/speed.json', temp = path + '.' + pid;
    if (writefile(temp, sprintf('%J', { wall_time: time(), time: now, previous_time: previous.time, counters, previous_counters: previous.counters }))) rename(temp, path);
  }
  previous = { time: now, counters };
  // sleep() takes milliseconds. Rates use actual monotonic elapsed time,
    // Fast sampling is enabled only for a 1-second dashboard refresh setting.
  let policy = null;
  try { policy = json(readfile(directory + '/speed-policy.json')); } catch(e) {}
  sleep(policy?.interval_ms == 1000 ? 500 : 1000);
}
`

export const speedSettings = String.raw`#!/usr/bin/ucode
import { writefile, readfile, rename, mkdir, readlink } from 'fs';
const directory = getenv('CPE_STATUS_CACHE') || '/tmp/cpe-status';
if (length(ARGV) == 1 && ARGV[0] == 'read') {
  function read(path) { try { return json(readfile(directory + '/' + path + '.json')); } catch(e) { return null; } }
  print(sprintf('%J\n', { speed: read('speed'), wwan: read('wwan-manager') })); exit(0);
}
let interval = +ARGV[0];
if (length(ARGV) != 1 || index([0,1000,2000,3000,5000,10000], interval) < 0) die('Invalid refresh interval');
mkdir(directory, 0700);
let path = directory + '/speed-policy.json', temp = path + '.' + readlink('/proc/self');
writefile(temp, sprintf('%J', { interval_ms: interval })); rename(temp, path);
print('{}\n');
`
