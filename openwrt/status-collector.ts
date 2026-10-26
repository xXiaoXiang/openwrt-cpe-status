import { rm500q } from '../adapters/quectel-rm500q-gl-r11.ts'
import { cacheSeconds } from '../shared/cache-policy.ts'

export const statusGroups = {
  status: { ttl: cacheSeconds.status, names: ['simPin', 'signal', 'operator', 'registration', 'registration5g', 'provider'] },
  radio: { ttl: cacheSeconds.radio, names: ['radio'] },
  cells: { ttl: cacheSeconds.cells, names: ['serving', 'neighbors', 'carriers'] },
  temperature: { ttl: cacheSeconds.temperature, names: ['temperature'] },
  identity: { ttl: cacheSeconds.identity, names: ['manufacturer', 'model', 'revision', 'imei'] },
  sim: { ttl: cacheSeconds.sim, names: ['iccid', 'imsi', 'phone', 'smsCenter'] },
  roaming: { ttl: cacheSeconds.roaming, names: ['roamingPreference'] },
  mode: { ttl: cacheSeconds.mode, names: ['mode'] },
}
const groups = Object.fromEntries(Object.entries(statusGroups).map(([key, group]) => [key, { ttl: group.ttl, command: 'AT' + group.names.map(name => rm500q.commands[name].command.slice(2)).join(';') }]))

// Generated ucode is executed by rpcd's file.exec. No Node daemon, serial fd
// owner is needed. Separate write-authorized helpers control roaming/data/RF.
export const statusRuntime = String.raw`#!/usr/bin/ucode
import { readfile, writefile, mkdir, rmdir, unlink, rename, stat, popen, glob, readlink, chmod } from 'fs';
import { connect } from 'ubus';
const directory = getenv('CPE_STATUS_CACHE') || '/tmp/cpe-status';
const cacheSeconds = __CACHE_SECONDS__;
const script = getenv('CPE_STATUS_SCRIPT') || '/usr/libexec/cpe-status-snapshot';
const configPath = getenv('CPE_STATUS_CONFIG') || '/etc/cpe-status.json';
const pid = +readlink('/proc/self');
function text(path) { return trim(readfile(path) || ''); }
function readJSON(path) { try { return json(readfile(path)); } catch(e) { return null; } }
function command(cmd) {
  let stream = popen(cmd, 'r');
  if (!stream) return '';
  let result = stream.read('all') || '';
  stream.close();
  return result;
}
function save(path, value) {
  let temp = path + '.' + pid;
  if (!writefile(temp, sprintf('%J', value))) die('Cannot store snapshot');
  chmod(temp, 0600);
  if (!rename(temp, path)) die('Cannot store snapshot');
}
let config = readJSON(configPath) || {};
let port = config.device || '/dev/ttyUSB2', iface = config.networkInterface || 'wwan';
if (!match(port, /^\/dev\/tty(USB|ACM)[0-9]+$/) || !match(iface, /^[a-zA-Z0-9_]{1,32}$/)) die('Invalid AT port or interface');
// Synchronous subprocess watchdog works on BusyBox images without timeout.
// Commands come exclusively from generated helpers with validated parameters.
function bounded(cmd, seconds) {
  return command(cmd + ' & child=$!; (sleep ' + seconds + '; kill "$child" 2>/dev/null; sleep 1; kill -9 "$child" 2>/dev/null) >/dev/null 2>&1 & guard=$!; wait "$child"; rc=$?; kill "$guard" 2>/dev/null; wait "$guard" 2>/dev/null; exit "$rc"');
}
`.replace('__CACHE_SECONDS__', JSON.stringify(cacheSeconds))
export const statusCollector = statusRuntime + String.raw`const groups = __GROUPS__;
function host(previous, now) {
  let bus = connect(), system = readJSON(directory + '/system.json');
  if (!system || now - system.time >= cacheSeconds.system) {
    system = { time: now, board: bus ? bus.call('system', 'board', {}) : {}, cpuinfo: text('/proc/cpuinfo'), machine: trim(command('uname -m')) };
    save(directory + '/system.json', system);
  }
  let board = system.board;
  // One host query obtains the MBIM parent and its dynamic IPv4/IPv6 children.
  let networks = (bus ? bus.call('network.interface', 'dump', {}) : {})?.interface || [];
  let net = {}, device = '';
  for (let row in networks) if (row.interface == iface) { net = row; break; }
  device = net.l3_device || '';
  if (!device) for (let row in networks) if ((row.interface == iface + '_4' || row.interface == iface + '_6') && row.up && row.l3_device) { device = row.l3_device; break; }
  let device_addresses = match(device, /^[a-zA-Z0-9_.:@-]{1,64}$/) ? bounded('ip -o addr show dev ' + device, 2) : '';
  let counters = [];
  for (let file in glob('/sys/class/net/*/statistics/rx_bytes')) {
    let name = split(file, '/')[4], rx = +text(file), tx = +text(replace(file, 'rx_bytes', 'tx_bytes'));
    push(counters, { interface: name, rx, tx });
  }
  let result = { time: now, board, net, networks, network_interface: iface, device_addresses, meminfo: text('/proc/meminfo'), loadavg: text('/proc/loadavg'), uptime: text('/proc/uptime'),
    cpustat: text('/proc/stat'), cpuinfo: system.cpuinfo, machine: system.machine, disk: command('df -Pk'), counters, thermal: [],
    previous_counters: previous?.counters || [], previous_time: previous?.time || now };
  return result;
}
mkdir(directory, 0700);
let now = time(), path = directory + '/snapshot.json', previous = readJSON(path);
if (previous && previous.device != port) previous = null;
let failure = readJSON(directory + '/failure.json');
let fresh = previous && now - previous.host.time < cacheSeconds.host;
let update = ARGV[0] == '--refresh';
function output(value) {
  let speed = readJSON(directory + '/speed.json');
  if (value?.host && speed && time() - speed.wall_time < 3) {
    value.host.counters = speed.counters; value.host.previous_counters = speed.previous_counters;
    value.host.speed_time = speed.time; value.host.speed_previous_time = speed.previous_time;
  }
  print(sprintf('%J\n', value));
}
if (!update && fresh) { output(previous); exit(0); }
let lock = directory + '/lock';
if (!mkdir(lock, 0700)) {
  let owner = +text(lock + '/pid');
  if ((owner && stat('/proc/' + owner)) || (!owner && now - stat(lock).mtime < 2)) {
    output(previous || { error: 'ModemReadDeferred: snapshot collection in progress', retry_after_ms: 5000 }); exit(0);
  }
  unlink(lock + '/pid'); rmdir(lock);
  if (!mkdir(lock, 0700)) die('ModemReadDeferred: collector lock busy');
}
writefile(lock + '/pid', '' + pid);
if (!update && previous) {
  unlink(lock + '/pid'); rmdir(lock);
  if (!failure || now - failure.time >= cacheSeconds.failure) system(script + ' --refresh </dev/null >/dev/null 2>&1 &');
  previous.stale = true;
  output(previous); exit(0);
}
try {
  let result = previous && previous.device == port ? previous : { raw: {}, sampled: {}, source: 'quectel-sms-tool', device: port };
  for (let key, group in groups) {
    // CFUN remains queryable in flight mode. Avoid repeated serving/neighbor
    // queries while RF is off; the API explicitly returns an empty cell list.
    if (key == 'cells' && match(result.raw.radio || result.raw.status || '', /\+CFUN:\s*[04]\s*(\r?\n|$)/)) continue;
    if (key == 'sim' && match(result.raw.status || '', /(SIM not inserted|\+CME ERROR: *10([^0-9]|$))/i)) continue;
    if (result.sampled[key] && now - result.sampled[key] < group.ttl) continue;
    if (result.attempted?.[key] && now - result.attempted[key] < cacheSeconds.failure) continue;
    let identity = key == 'sim' ? readJSON(directory + '/sim-identity.json') : null;
    let reuse = identity?.present && identity.iccid && identity.imsi && now - identity.checked < 60;
    let atCommand = reuse ? 'AT+CNUM;+CSCA?' : group.command;
    let raw = bounded('sms_tool -d ' + port + ' at ' + "'" + atCommand + "'", 5);
    if (reuse) raw = '+QCCID: ' + identity.iccid + '\n' + identity.imsi + '\n' + raw;
    let expected = { status: '+CPIN:', radio: '+CFUN:', cells: '+QENG:', temperature: '+QTEMP:', identity: 'RM500Q', sim: '+QCCID:', roaming: '+QNWPREFCFG:', mode: '+QNWPREFCFG:' };
    if (index(raw, expected[key]) < 0) {
      if ((key == 'sim' || key == 'status') && match(raw, /(SIM not inserted|\+CME ERROR: *10([^0-9]|$))/i)) {
        result.raw[key] = raw; result.sampled[key] = now; result.raw.sim = ''; result.sampled.sim = 0; continue;
      }
      if (!result.raw[key]) result.raw[key] = raw;
      result.warnings ||= {};
      result.warnings[key] = 'AT query did not return expected fields';
      // Back off a failed group too; repeated page requests must not flood AT.
      result.attempted ||= {}; result.attempted[key] = now;
      continue;
    }
    result.raw[key] = raw; result.sampled[key] = now;
    if (result.warnings) delete result.warnings[key];
  }
  result.host = host(previous?.host, time());
  result.stale = length(keys(result.warnings || {})) > 0;
  save(path, result);
  unlink(directory + '/failure.json');
  output(result);
} catch(e) {
  save(directory + '/failure.json', { time: time() });
  print(sprintf('%J\n', previous || { error: 'ModemReadDeferred: ' + e, retry_after_ms: 10000 }));
}
unlink(lock + '/pid'); rmdir(lock);
`.replace('__GROUPS__', JSON.stringify(groups))
