import { apnRuntime } from './apn-control.ts'
import { statusRuntime } from './status-collector.ts'
import { bandRuntime } from './band-control.ts'
import { radioSettingsRuntime } from './radio-settings.ts'
import { qmiNetworkModes } from '../shared/radio-settings.ts'
import { operatorRuntime } from './operators.ts'

// The write helper starts a bounded background job. The read helper only reads
// its private result file; read ACLs can never submit a control operation.
const resultRuntime = statusRuntime + String.raw`
function reply(value) { print(sprintf('%J\n', value)); }
function longOperator(kind) { return index(['operator', 'operator-scan'], kind) >= 0; }
function jobPath(id) {
  if (!match(id || '', /^[0-9]+-[0-9]+$/)) die('Invalid control job');
  return directory + '/control-' + id + '.json';
}
`

export const modemControlResult = resultRuntime + String.raw`
if (length(ARGV) != 1) { reply({ status: 'error', message: 'Expected control job ID' }); exit(0); }
let job = readJSON(jobPath(ARGV[0]));
if (!job || job.device != port || job.interface != iface) {
  reply({ status: 'error', message: '控制任务不存在，请刷新检查实际状态' }); exit(0);
}
if (job.status == 'pending' && time() - job.started >= (longOperator(job.kind) ? 245 : job.kind == 'scan' ? 225 : 65)) {
  reply({ status: 'deferred', message: '设置已提交，尚未确认最终状态，请稍后刷新', submitted: true }); exit(0);
}
reply(job);
`

export const modemControl = resultRuntime + bandRuntime + radioSettingsRuntime + operatorRuntime + apnRuntime + String.raw`
mkdir(directory, 0700);
if (iface != 'wwan') { reply({ status: 'error', message: '此插件仅允许管理 wwan 接口' }); exit(0); }
const controlScript = getenv('CPE_STATUS_CONTROL_SCRIPT') || '/usr/libexec/cpe-status-control';
if (ARGV[0] != '--run') {
  let target = null;
  if (ARGV[0] == 'apn') {
    try { if (length(ARGV) != 2) die('Invalid APN arguments'); target = apnValidate(json(ARGV[1])); } catch(e) { reply({ status: 'error', message: '' + e }); exit(0); }
  } else if (ARGV[0] == 'operator-scan') {
    if (length(ARGV) != 1) { reply({ status: 'error', message: '无效的运营商扫描参数' }); exit(0); }
    target = 'scan';
  } else if (ARGV[0] == 'operator') {
    if (length(ARGV) != 2 || (ARGV[1] != 'auto' && !match(ARGV[1], /^[0-9]{5,6}$/))) { reply({ status: 'error', message: '运营商必须为5或6位PLMN，或auto' }); exit(0); }
    target = ARGV[1];
  } else if (ARGV[0] == 'scan') {
    if (length(ARGV) != 1) { reply({ status: 'error', message: '扫描不接受自定义AT参数' }); exit(0); }
    target = '3,1';
  } else if (ARGV[0] == 'bands') {
    try {
      if (length(ARGV) != 4) die('Expected LTE / SA / NSA band lists');
      target = { lte: bandList(ARGV[1]), sa: bandList(ARGV[2]), nsa: bandList(ARGV[3]) };
    } catch(e) { reply({ status: 'error', message: '' + e }); exit(0); }
  } else if (ARGV[0] == 'mode') {
    if (length(ARGV) != 2 || index(allowedModes, ARGV[1]) < 0) { reply({ status: 'error', message: '无效的网络模式' }); exit(0); }
    target = ARGV[1];
  } else if (ARGV[0] == 'cell') {
    try {
      let rat = ARGV[1], action = ARGV[2];
      if (index(['lte', 'nr'], rat) < 0 || index(['lock', 'unlock'], action) < 0) die('Invalid cell operation');
      target = { rat, action };
      if (action == 'unlock') { if (length(ARGV) != 3) die('Invalid unlock arguments'); }
      else {
        if (length(ARGV) != (rat == 'lte' ? 5 : 7)) die('Invalid lock arguments');
        for (let value in slice(ARGV, 3)) if (!match(value, /^(0|[1-9][0-9]*)$/) || length(value) > 7) die('Invalid numeric cell parameter');
        target.arfcn = +ARGV[3]; target.pci = +ARGV[4];
        if (target.arfcn > (rat == 'lte' ? 262143 : 3279165) || target.pci > (rat == 'lte' ? 503 : 1007)) die('小区频点或PCI超出范围');
        if (rat == 'nr') {
          target.band = +ARGV[5]; target.scs_khz = +ARGV[6];
          if (target.pci == 0 || target.arfcn == 0 || target.band < 1 || target.band > 255 || index([15, 30], target.scs_khz) < 0) die('NR锁定需要非零PCI、频点、FR1频段及15/30kHz SCS');
        }
      }
    } catch(e) { reply({ status: 'error', message: '' + e }); exit(0); }
  } else if (length(ARGV) != 2 || (ARGV[0] != 'data' && ARGV[0] != 'airplane') || (ARGV[1] != '0' && ARGV[1] != '1')) {
    reply({ status: 'error', message: 'Invalid control or boolean target' }); exit(0);
  } else target = ARGV[1] == '1';
  // A separate short reservation lock prevents concurrent browser sessions
  // from starting two jobs while the first worker is waiting for the AT lock.
  let reservation = directory + '/control-lock';
  if (!mkdir(reservation, 0700)) {
    let info = stat(reservation);
    if (info && time() - info.mtime > 5) rmdir(reservation);
    if (!mkdir(reservation, 0700)) { reply({ status: 'deferred', message: '控制请求正在提交，请稍后重试', submitted: false }); exit(0); }
  }
  try {
    let active = readJSON(directory + '/control-active.json');
    let job = active ? readJSON(jobPath(active.id)) : null;
    if (job && job.status == 'pending' && time() - job.started < (longOperator(job.kind) ? 250 : job.kind == 'scan' ? 230 : 75)) {
      reply({ status: 'deferred', message: '已有控制任务正在执行，请稍后重试', submitted: false });
    } else {
      let id = time() + '-' + pid;
      job = { id, device: port, interface: iface, kind: ARGV[0], target, started: time(), status: 'pending', submitted: false };
      save(jobPath(id), job);
      save(directory + '/control-active.json', { id });
      if (job.kind == 'scan') save(directory + '/scan-active.json', { id });
      if (longOperator(job.kind)) save(directory + '/operator-active.json', { id });
      // Absolute executable path is generated or supplied by the local test.
      if (!match(controlScript, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid control executable');
      system(controlScript + ' --run ' + id + ' </dev/null >' + directory + '/control-worker.log 2>&1 &');
      reply({ status: 'pending', job_id: id, submitted: true });
      for (let file in glob(directory + '/control-*.json')) {
        let info = stat(file);
        let scan = readJSON(directory + '/scan-active.json');
        let operator = readJSON(directory + '/operator-active.json');
        if (info && time() - info.mtime > 300 && file != directory + '/control-active.json' && file != (scan ? jobPath(scan.id) : '') && file != (operator ? jobPath(operator.id) : '')) unlink(file);
      }
    }
  } catch(e) { reply({ status: 'error', message: '' + e, submitted: false }); }
  rmdir(reservation);
  exit(0);
}
if (length(ARGV) != 2) exit(1);
let path = jobPath(ARGV[1]), job = readJSON(path);
if (!job || job.status != 'pending' || job.device != port || job.interface != iface) exit(1);
let lock = directory + '/lock', acquired = false, deadline = job.started + (longOperator(job.kind) ? 240 : job.kind == 'scan' ? 220 : 60);
let lockDeadline = (longOperator(job.kind) || job.kind == 'scan') ? job.started + 25 : deadline;
while (time() < lockDeadline) {
  if (mkdir(lock, 0700)) { acquired = true; break; }
  let owner = +text(lock + '/pid'), info = stat(lock);
  if ((!owner || !stat('/proc/' + owner)) && info && time() - info.mtime >= 2) { unlink(lock + '/pid'); rmdir(lock); continue; }
  command('sleep 1');
}
// Re-read after taking the AT lock: the same job must never execute twice.
job = readJSON(path);
if (!acquired) {
  job.status = 'deferred'; job.message = 'ModemReadDeferred: 等待 Modem 控制锁超时，未提交设置'; save(path, job); exit(0);
}
writefile(lock + '/pid', '' + pid);
if (job.status != 'pending') { unlink(lock + '/pid'); rmdir(lock); exit(0); }
let radioRaw = '', network = null, modeRaw = '';
const qmiModes = __QMI_MODES__;
function budget(maximum) { return max(1, min(maximum, deadline - time())); }
function queryRadio() {
  let raw = bounded('sms_tool -d ' + port + ' at ' + "'AT+CFUN?'", budget(5));
  let found = match(raw, /\+CFUN:\s*([0-9]+)\s*(\r?\n|$)/);
  if (!found) return null;
  radioRaw = raw;
  return +found[1];
}
function readNetwork() {
  let dump = null;
  try { dump = json(bounded('ubus -S call network.interface dump', budget(3))); } catch(e) {}
  if (!dump || !dump.interface) die('无法读取 netifd 接口状态');
  let parent = null;
  for (let row in dump.interface) if (row.interface == iface) { parent = row; break; }
  if (!parent || (parent.proto != 'qmi' && parent.proto != 'mbim')) die('数据控制只支持配置的 QMI/MBIM 接口');
  let device = parent.l3_device || '';
  for (let row in dump.interface) if (!device && (row.interface == iface + '_4' || row.interface == iface + '_6')) device = row.l3_device || '';
  let addresses = match(device, /^[a-zA-Z0-9_.:@-]{1,64}$/) ? bounded('ip -o addr show dev ' + device, budget(2)) : '';
  network = { parent, networks: dump.interface, addresses };
  return parent;
}
function hasAddress() {
  for (let row in network.networks) if (row.up && (row.interface == iface || row.interface == iface + '_4' || row.interface == iface + '_6')) {
    if (length(row['ipv4-address'] || [])) return true;
    for (let addr in (row['ipv6-address'] || [])) if (match(addr.address || '', /^[23][0-9a-f]{3}:/i)) return true;
  }
  return !!match(network.addresses, /\binet\s+[0-9.]+\/[0-9]+.*scope global|\binet6\s+[23][0-9a-f]{3}:[^\n]*scope global/i);
}
function networkReady(target) {
  let net = readNetwork();
  if (target) return net.up == true && !net.pending && hasAddress();
  if (net.up || net.pending) return false;
  for (let row in network.networks) if ((row.interface == iface + '_4' || row.interface == iface + '_6') && (row.up || row.pending)) return false;
  return true;
}
function setNetwork(target) {
  if (iface != 'wwan') die('此插件仅允许管理 wwan');
  if (job.kind == 'data') save(directory + '/user-data.json', { enabled: target });
  job.submitted = true;
  let pending = readJSON(directory + '/qmi-mode-pending.json');
  if (target && network?.parent.proto == 'qmi' && pending?.device == port && pending.interface == iface) {
    // ifup reloads UCI before restarting this interface. Direct ubus up would
    // reuse the old netifd configuration and lose the saved RAT preference.
    let result = bounded('ifup ' + iface + ' && echo CPE_INTERFACE_RELOADED', budget(5));
    if (!match(result, /CPE_INTERFACE_RELOADED/)) die('QMI模式已保存，尚未完成拨号配置加载');
    unlink(directory + '/qmi-mode-pending.json');
    return;
  }
  bounded('ubus -S call network.interface ' + (target ? 'up' : 'down') + " '{\"interface\":\"" + iface + "\"}'", budget(5));
}
function persistQmiMode(mode) {
  let net = readNetwork();
  if (net.proto != 'qmi') return false;
  let name = 'network.' + iface, value = qmiModes[mode];
  if (!value || trim(bounded('uci -q get ' + name + '.proto', budget(3))) != 'qmi') die('无法确认QMI接口配置，网络模式未保存到OpenWrt');
  if (trim(bounded('uci -q get ' + name + '.modes', budget(3))) != value) {
    job.submitted = true;
    let result = bounded("uci set '" + name + ".modes=" + value + "' && uci commit network && echo CPE_QMI_MODE_SAVED", budget(5));
    if (!match(result, /CPE_QMI_MODE_SAVED/)) die('模块已确认模式，但OpenWrt QMI模式保存失败');
    if (trim(bounded('uci -q get ' + name + '.modes', budget(3))) != value) die('OpenWrt QMI模式保存回读不一致');
    save(directory + '/qmi-mode-pending.json', { device: port, interface: iface, mode });
  }
  job.qmi_mode = value;
  let pending = readJSON(directory + '/qmi-mode-pending.json');
  return pending?.device == port && pending.interface == iface;
}
function waitNetwork(target) {
  while (time() < deadline) {
    if (networkReady(target)) return;
    command('sleep 1');
  }
  die('ModemReadDeferred: 数据接口请求已提交，尚未确认连接状态');
}
function waitRadio(target) {
  while (time() < deadline) {
    let started = time();
    if (queryRadio() == target) return;
    // Real CFUN reads start at most once every 10 seconds and wait at most 5s.
    let delay = min(deadline - time(), max(0, started + 10 - time()));
    if (delay > 0) command('sleep ' + delay);
  }
  die('ModemReadDeferred: 射频设置已提交，60秒内尚未确认状态');
}
function updateSnapshot() {
  let snapshot = readJSON(directory + '/snapshot.json');
  if (!snapshot || snapshot.device != port) return null;
  if (index(['bands', 'mode', 'cell', 'operator', 'operator-scan', 'apn'], job.kind) >= 0 && job.submitted) {
    // Keep the previous dashboard results visible while the network reconnects.
    snapshot.sampled.status = 0; snapshot.sampled.cells = 0;
    if (snapshot.attempted) { delete snapshot.attempted.status; delete snapshot.attempted.cells; }
  }
  if (modeRaw) { try { modeReply(modeRaw); snapshot.raw.mode = modeRaw; snapshot.sampled.mode = time(); } catch(e) {} }
  if (radioRaw) {
    snapshot.raw.radio = radioRaw; snapshot.sampled.radio = time();
    let line = match(radioRaw, /\+CFUN:\s*[0-9]+/)[0];
    snapshot.raw.status = replace(snapshot.raw.status || '', /\+CFUN:\s*[0-9]+/, line);
    if (index(snapshot.raw.status, '+CFUN:') < 0) snapshot.raw.status += '\n' + line + '\n';
    // Preserve badge data; only schedule the changed radio group for refresh.
    if (job.kind == 'airplane') {
      snapshot.sampled.status = time() - cacheSeconds.status;
      snapshot.sampled.cells = 0;
      if (snapshot.attempted) delete snapshot.attempted.cells;
    }
  }
  if (network && snapshot.host) {
    snapshot.host.net = network.parent; snapshot.host.networks = network.networks;
    snapshot.host.device_addresses = network.addresses; snapshot.host.network_interface = iface;
    snapshot.host.time = 0; // next read refreshes host addresses/resources
  }
  if (snapshot.attempted) delete snapshot.attempted.status;
  if (job.submitted && job.status != 'ok') {
    let key = job.kind == 'airplane' ? 'radio' : job.kind == 'mode' ? 'mode' : null;
    if (key) { snapshot.sampled[key] = 0; if (snapshot.attempted) delete snapshot.attempted[key]; }
  }
  save(directory + '/snapshot.json', snapshot);
  return snapshot;
}
function apnLog(message) {
  job.logs ||= []; push(job.logs, '+' + (time() - job.started) + 's  ' + message);
  save(directory + '/apn-job.json', { device: port, interface: iface, logs: job.logs });
}
try {
  if (job.kind == 'apn') {
    let settings = apnSettings(), target = apnValidate(job.target);
    let identity = bounded('sms_tool -d ' + port + ' at ' + apnQuote('AT+CPIN?;+QCCID'), budget(5));
    let iccid = match(identity, /\+QCCID:\s*([0-9]{18,22})/);
    if (!iccid || index(identity, 'READY') < 0) die('SIM 未就绪，未修改 APN');
    if (queryRadio() != 1) die('请先关闭飞行模式再保存并重拨');
    apnLog('已确认 SIM，正在保存 wwan APN 配置');
    let commands = [];
    for (let key, value in target) push(commands, 'uci set ' + apnQuote('network.wwan.' + key + '=' + value));
    let saved = bounded(join(' && ', commands) + ' && uci commit network && echo CPE_APN_SAVED', budget(8));
    if (index(saved, 'CPE_APN_SAVED') < 0) die('APN 保存失败');
    for (let key, value in target) if (apnUci(key) != value) die('APN 配置回读不一致');
    mkdir('/etc/cpe-status', 0700);
    let overrides = readJSON(apnOverridePath) || {};
    overrides[iccid[1]] = target; save(apnOverridePath, overrides);
    save(directory + '/wwan-manager.json', { status: 'ready', message: '已使用此 SIM 的自定义 APN', apn: target.apn, carrier: '用户配置', time: time() });
    job.submitted = true;
    save(directory + '/user-data.json', { enabled: true });
    apnLog('APN 已保存，正在断开 wwan');
    bounded('ifdown wwan', budget(5));
    waitNetwork(false);
    apnLog('正在使用新配置拨号');
    let dial = bounded('ifup wwan && echo CPE_APN_IFUP', budget(5));
    if (index(dial, 'CPE_APN_IFUP') < 0) die('APN 已保存，wwan 拨号请求未确认');
    let last = '';
    while (time() < deadline) {
      let ready = networkReady(true), net = network.parent;
      let state = net.up ? ready ? '连接成功，已获得 IP 地址' : '链路已开启，等待 IP 地址' : net.pending ? 'netifd 正在拨号' : '等待 wwan 连接';
      if (state != last) { apnLog(state); last = state; }
      if (ready) break;
      if (length(net.errors || [])) { apnLog('netifd: ' + sprintf('%J', net.errors)); }
      command('sleep 2');
    }
    if (!networkReady(true)) die('ModemReadDeferred: APN 已保存并提交重拨，尚未确认 IP 地址');
    let raw = bounded('sms_tool -d ' + port + ' at ' + apnQuote('AT+CGDCONT?;+CGACT?'), budget(5));
    if (index(raw, '+CGACT:') >= 0) save(directory + '/apn-active.json', { device: port, ...apnActive(raw) });
    job.data = { settings: apnSettings(), ...(readJSON(directory + '/apn-active.json') || { active: false }), logs: job.logs };
    job.status = 'ok'; job.message = 'APN 已保存，wwan 已重新连接';
  } else if (longOperator(job.kind)) {
    requireRm500q();
    if (queryRadio() != 1) die('请先关闭飞行模式');
    let atScript = getenv('CPE_STATUS_OPERATOR_AT_SCRIPT') || '/usr/libexec/cpe-status-operator-at';
    if (!match(atScript, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid operator AT executable');
    let cmd = job.kind == 'operator-scan' ? 'AT+COPS=?' : job.target == 'auto' ? 'AT+COPS=0' : 'AT+COPS=1,2,"' + job.target + '"';
    job.at_command = cmd; job.submitted = true;
    let raw = bounded("CPE_OPERATOR_COMMAND='" + cmd + "' gcom -d " + port + ' -s ' + atScript, budget(185));
    job.at_reply = raw;
    if (job.kind == 'operator-scan') {
      if (atError(raw) || !match(raw, /(^|\n)\s*OK\s*(\n|$)/) || index(raw, '+COPS:') < 0) die('运营商扫描失败：' + (atError(raw) || '未完整结束或超时') + '；保留原列表');
      save(directory + '/operator-scan.json', { device: port, raw, sampled_at: time() });
      job.status = 'ok'; job.message = '运营商扫描完成';
      try { job.data = readOperator(); } catch(e) {}
    } else {
      let confirmed = false;
      while (time() < deadline - 20) {
        try {
          job.data = readOperator();
          confirmed = job.data.registered && (job.target == 'auto' ? job.data.mode == 0 : job.data.mode == 1 && job.data.plmn == job.target);
        } catch(e) { job.read_error = '' + e; }
        if (confirmed || atError(raw)) break;
        command('sleep 3');
      }
      if (!confirmed) {
        if (atError(raw)) die('运营商注册未确认：' + atError(raw));
        die('ModemReadDeferred: 选网已提交，尚未确认注册成功，请稍后读取状态');
      }
      // Keep OpenWrt's next QMI dial aligned with the confirmed COPS choice.
      let net = readNetwork();
      if (net.proto == 'qmi') {
        let name = 'network.' + iface, plmn = job.target == 'auto' ? '0' : job.target;
        if (trim(bounded('uci -q get ' + name + '.proto', budget(3))) != 'qmi') die('模块已注册，但无法确认QMI配置');
        let saved = bounded("uci set '" + name + '.plmn=' + plmn + "' && uci commit network && echo CPE_PLMN_SAVED", budget(5));
        if (!match(saved, /CPE_PLMN_SAVED/) || trim(bounded('uci -q get ' + name + '.plmn', budget(3))) != plmn) die('模块已注册，但OpenWrt选网配置保存失败');
        save(directory + '/qmi-mode-pending.json', { device: port, interface: iface });
      }
      job.status = 'ok'; job.message = job.target == 'auto' ? '已确认自动选网并注册' : '已确认注册到所选PLMN';
    }
  } else if (job.kind == 'scan') {
    requireRm500q();
    if (queryRadio() != 1) die('请先关闭飞行模式再扫描小区');
    let scanScript = getenv('CPE_STATUS_SCAN_AT_SCRIPT') || '/usr/libexec/cpe-status-scan-at';
    if (!match(scanScript, /^\/[a-zA-Z0-9_./-]+$/)) die('Invalid scan executable');
    job.submitted = true;
    // Leave five seconds to collect OK after the modem's 180-second scan.
    let raw = bounded('gcom -d ' + port + ' -s ' + scanScript, budget(185));
    if (atError(raw)) die('小区扫描失败：' + atError(raw));
    if (!match(raw, /(^|\n)\s*OK\s*(\n|$)/)) die('小区扫描未完整结束或已超时，保留原列表');
    job.data = { raw, sampled_at: time() };
    save(directory + '/cell-scan.json', { device: port, raw, sampled_at: job.data.sampled_at });
    job.status = 'ok'; job.message = '扫描完成，列表已固定；再次扫描才会更新';
  } else if (job.kind == 'mode') {
    requireRm500q();
    modeRaw = radioAt('AT+QNWPREFCFG="mode_pref"');
    if (modeReply(modeRaw) != job.target) {
      job.submitted = true;
      let raw = radioAt('AT+QNWPREFCFG="mode_pref",' + job.target);
      job.at_reply = raw;
      // Even ERROR/timeout is followed by a real query; never assume success.
      modeRaw = radioAt('AT+QNWPREFCFG="mode_pref"');
      if (atError(raw)) die('网络模式设置失败：' + atError(raw));
      while (modeReply(modeRaw) != job.target && time() < deadline - 6) { command('sleep 2'); modeRaw = radioAt('AT+QNWPREFCFG="mode_pref"'); }
    }
    if (modeReply(modeRaw) != job.target) die('ModemReadDeferred: 已提交网络模式，尚未确认设置');
    let wasActive = readNetwork().up == true || network.parent.pending == true;
    if (persistQmiMode(job.target) && wasActive) {
      setNetwork(true);
      waitNetwork(true);
      modeRaw = radioAt('AT+QNWPREFCFG="mode_pref"');
    }
    job.data = { mode: modeReply(modeRaw) };
    if (job.data.mode != job.target) die('ModemReadDeferred: OpenWrt已保存模式，重拨后尚未确认模块制式');
    job.status = 'ok'; job.message = job.qmi_mode ? '模块已确认网络模式，已保存到OpenWrt QMI拨号配置' : '模块已确认网络模式，重新注册可能需要一些时间';
  } else if (job.kind == 'cell') {
    requireRm500q();
    let target = job.target, name = target.rat == 'lte' ? 'common/4g' : 'common/5g';
    if (target.action == 'lock') job.preflight = radioAt('AT+QENG="servingcell"');
    let values = target.action == 'unlock' ? '0' : target.rat == 'lte' ? '1,' + target.arfcn + ',' + target.pci : target.pci + ',' + target.arfcn + ',' + target.scs_khz + ',' + target.band;
    job.at_command = 'AT+QNWLOCK="' + name + '",' + values;
    job.submitted = true;
    let raw = radioAt(job.at_command); job.at_reply = raw;
    job.data = readCellLocks();
    if (atError(raw)) die('小区设置失败：' + atError(raw));
    while (!lockConfirmed(job.data, target) && time() < deadline - 11) { command('sleep 2'); job.data = readCellLocks(); }
    if (!lockConfirmed(job.data, target)) die('ModemReadDeferred: 小区设置已提交，模块回读尚未确认');
    job.status = 'ok'; job.message = target.action == 'unlock' ? '模块已确认解除小区锁定' : '模块已确认小区锁定配置；不代表已注册或数据可用';
  } else if (job.kind == 'bands') {
    let before = readBands();
    // Validate every group before sending the first write.
    for (let key in keys(bandNames)) for (let band in job.target[key]) {
      if (index(before.supported[key], band) < 0) die('模块不支持所选频段：' + key + ' ' + band);
    }
    job.applied = [];
    for (let key, name in bandNames) {
      if (join(':', before.enabled[key]) == join(':', job.target[key])) continue;
      if (time() >= deadline - 6) die('ModemReadDeferred: 等待频段设置确认超时');
      job.submitted = true;
      let raw = bandAt('AT+QNWPREFCFG="' + name + '",' + join(':', job.target[key]));
      if (match(raw, /(^|\n)(ERROR|\+CME ERROR:)/)) die('模块拒绝频段设置：' + key);
      // Always read back, including replies without OK (sms_tool strips it).
      let confirmed = readBands();
      if (join(':', confirmed.enabled[key]) != join(':', job.target[key])) die('模块尚未确认频段设置：' + key);
      push(job.applied, key);
    }
    job.data = readBands();
    for (let key in keys(bandNames)) if (join(':', job.data.enabled[key]) != join(':', job.target[key])) die('最终频段回读与请求不一致');
    job.status = 'ok'; job.message = '模块已确认频段设置，网络可能需要重新注册';
  } else {
  let net = readNetwork();
  if (job.kind == 'data') {
    if (job.target && queryRadio() != 1) die('飞行模式或射频未开启，不能启动数据连接');
    if (!networkReady(job.target)) { setNetwork(job.target); waitNetwork(job.target); }
    job.data = { active: job.target, pending: false, interface: iface, protocol: net.proto };
  } else {
    let before = queryRadio();
    if (before == null) die('无法读取射频状态，未切换飞行模式');
    let statePath = directory + '/control-state.json', state = readJSON(statePath);
    if (state && (state.device != port || state.interface != iface)) state = null;
    if (job.target) {
      if (!state || !state.airplane) {
        state = { device: port, interface: iface, airplane: true, resume_data: net.up == true || net.pending == true };
        save(statePath, state);
      }
      // Stop auto-dial before disabling RF; QMI setup forces the modem online.
      if (!networkReady(false)) { setNetwork(false); waitNetwork(false); }
    }
    let target = job.target ? 4 : 1;
    if (before != target) {
      job.submitted = true;
      let raw = bounded('sms_tool -d ' + port + ' at ' + "'AT+CFUN=" + target + "'", budget(15));
      if (match(raw, /(^|\n)(ERROR|\+CME ERROR:)/)) die('模块拒绝射频切换请求');
      waitRadio(target);
    }
    // Query again even for idempotent requests, and never restore data before
    // the modem confirms full functionality.
    else if (queryRadio() != target) waitRadio(target);
    if (!job.target && state?.airplane) {
      if (state.resume_data) setNetwork(true);
      // RF confirmation completes airplane-off; data dialing continues via
      // netifd and is reflected by later snapshots, without holding RF pending.
      state.airplane = false; save(statePath, state);
      readNetwork();
    }
    job.data = { enabled: job.target, online: !job.target, powered: true, data_active: network.parent.up == true };
  }
  job.status = 'ok'; job.message = '设备已确认操作状态';
  }
} catch(e) {
  job.message = '' + e;
  job.status = index(job.message, 'ModemReadDeferred:') >= 0 ? 'deferred' : 'error';
  if (job.kind == 'apn') apnLog(job.message);
  if (job.kind == 'bands') {
    if (job.submitted) job.message += '；部分设置可能已生效，请核对模块回读结果';
    try { job.data = readBands(); } catch(readError) {
      unlink(directory + '/bands.json'); job.read_error = '' + readError;
    }
  }
  if (job.kind == 'mode' && modeRaw) { try { job.data = { mode: modeReply(modeRaw) }; } catch(readError) {} }
}
try { job.snapshot = updateSnapshot(); } catch(e) { job.cache_warning = '' + e; }
job.finished = time();
save(path, job);
unlink(lock + '/pid'); rmdir(lock);
`.replace('__QMI_MODES__', JSON.stringify(qmiNetworkModes))

