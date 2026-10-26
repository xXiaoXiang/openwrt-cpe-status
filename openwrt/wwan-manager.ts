import { apnRuntime } from './apn-control.ts'
import { statusRuntime } from './status-collector.ts'

export const wwanManager = statusRuntime + apnRuntime + String.raw`
function quote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function uci(key) { return trim(bounded('uci -q get network.wwan.' + key, 3)); }
function report(status, message, extra) { save(directory + '/wwan-manager.json', { status, message, ...(extra || {}), time: time() }); }
function net(action) { bounded(action + ' wwan', 5); }
function invalidate(simChanged) {
  let snapshot = readJSON(directory + '/snapshot.json');
  if (snapshot) { snapshot.sampled = {}; delete snapshot.attempted; if (simChanged) { snapshot.raw.sim = ''; snapshot.raw.status = ''; snapshot.raw.cells = ''; } save(directory + '/snapshot.json', snapshot); }
  for (let name in ['bands.json', 'cell-locks.json', 'operators.json']) unlink(directory + '/' + name);
}
function prepare() {
  if (iface != 'wwan') die('自动 APN 仅允许管理 wwan');
  if (config.autoApn === false) return false;
  if (index(['qmi', 'mbim'], uci('proto')) < 0) { report('waiting', '仅管理已有的 wwan QMI/MBIM 接口'); return false; }
  mkdir('/etc/cpe-status', 0700);
  if (!stat('/etc/cpe-status/wwan-original.json')) save('/etc/cpe-status/wwan-original.json', { auto: uci('auto'), apn: uci('apn'), pdptype: uci('pdptype'), auth: uci('auth'), username: uci('username'), password: uci('password') });
  if (uci('auto') != '0') {
    let result = bounded("uci set network.wwan.auto='0' && uci commit network && echo CPE_SAVED", 5);
    if (index(result, 'CPE_SAVED') < 0) die('不能关闭 wwan 自动启动');
  }
  return true;
}
function at(cmd) { return bounded('sms_tool -d ' + port + ' at ' + quote(cmd) + ' 2>/dev/null', 5); }
function binary(cmd) {
  let raw = at(cmd), value = match(raw, /\+CRSM:\s*144,\s*0,\s*"([0-9A-Fa-f]+)"/);
  return value ? uc(value[1]) : '';
}
function choose(entries, sim, current) {
  let valid = [], lengths = {}, specific = [], generic = [];
  for (let row in entries) if (index(sim.imsi, row.mcc + row.mnc) == 0 && (!sim.mncLength || length(row.mnc) == sim.mncLength)) {
    lengths[length(row.mnc)] = true;
    let pattern = row.mvno_match_data || '', accepted = false;
    if (!row.mvno_type) accepted = true;
    else if (row.mvno_type == 'imsi' && length(pattern) && length(pattern) <= length(sim.imsi)) {
      accepted = true;
      for (let i = 0; i < length(pattern); i++) if (substr(pattern, i, 1) != 'x' && substr(pattern, i, 1) != 'X' && substr(pattern, i, 1) != substr(sim.imsi, i, 1)) accepted = false;
    } else if (row.mvno_type == 'iccid') { for (let prefix in split(pattern, ',')) if (length(prefix) && index(sim.iccid, prefix) == 0) accepted = true; }
    else if (row.mvno_type == 'gid') accepted = length(pattern) && index(uc(sim.gid || ''), uc(pattern)) == 0;
    else if (row.mvno_type == 'spn') accepted = length(pattern) && lc(sim.spn || '') == lc(pattern);
    if (accepted) push(row.mvno_type ? specific : generic, row);
  }
  if (length(keys(lengths)) > 1) return null;
  valid = length(specific) ? specific : generic;
  for (let row in valid) if (row.apn == current) return row;
  return valid[0];
}
function tick() {
  let state = readJSON(directory + '/sim-identity.json');
  if (!stat(port)) {
    if (!state || state.present !== false) { net('ifdown'); save(directory + '/sim-identity.json', { ...(state || {}), present: false }); invalidate(true); }
    report('waiting', 'Modem 不存在，wwan 已停用'); return;
  }
  if (state?.checked && time() - state.checked < 30) return;
  let netifd = null;
  try { netifd = json(bounded('ubus -S call network.interface.wwan status 2>/dev/null', 3)); } catch(e) {}
  if (!netifd || index(['qmi', 'mbim'], netifd.proto) < 0) { report('waiting', '等待 netifd 的 wwan 接口就绪'); return; }
  let lock = directory + '/lock';
  if (!mkdir(lock, 0700)) {
    let owner = +text(lock + '/pid');
    if (owner && !stat('/proc/' + owner)) { unlink(lock + '/pid'); rmdir(lock); }
    return;
  }
  writefile(lock + '/pid', '' + pid);
  try {
    let raw = at('AT+CPIN?;+QCCID'), iccid = match(raw, /\+QCCID:\s*([0-9]{18,22})/), imsi = state?.present && state.iccid == iccid?.[1] ? state.imsi : '';
    let imsiChecked = state?.imsi_checked || 0;
    if (iccid && index(raw, 'READY') >= 0 && (!imsi || time() - imsiChecked >= 300)) {
      let found = match(at('AT+CIMI'), /(^|\n)\s*([0-9]{14,16})\s*(\r?\n|$)/); imsi = found ? found[2] : '';
      if (imsi) imsiChecked = time();
    }
    if (match(raw, /SIM not inserted|\+CME ERROR: *10([^0-9]|$)/i)) {
      if (state?.present !== false) { net('ifdown'); invalidate(true); }
      save(directory + '/sim-identity.json', { ...(state || {}), present: false, checked: time() }); report('waiting', 'SIM 未插入，wwan 已停用');
    } else if (!iccid || !imsi || index(raw, 'READY') < 0) {
      if (!state?.present) net('ifdown');
      report('waiting', '等待 SIM 解锁及归属信息');
    } else {
      let sim = { present: true, iccid: iccid[1], imsi, checked: time(), imsi_checked: imsiChecked }, changed = state?.iccid != sim.iccid || state?.imsi != sim.imsi || state?.present !== true;
      if (!changed && state.configured) { state.checked = time(); state.imsi_checked = imsiChecked; save(directory + '/sim-identity.json', state); }
      else {
        // EF_AD byte 4 supplies the home MNC length; never use serving PLMN.
        let ad = binary('AT+CRSM=176,28589,0,0,4'), digit = length(ad) >= 8 ? substr(ad, 7, 1) : '';
        sim.mncLength = digit == '2' ? 2 : digit == '3' ? 3 : null;
        sim.gid = binary('AT+CRSM=176,28478,0,0,1');
        let spn = binary('AT+CRSM=176,28486,0,0,17'); sim.spn = '';
        // GSM default alphabet's printable ASCII subset is sufficient for most
        // APN SPN filters; unsupported encodings do not falsely match an MVNO.
        if (length(spn) >= 4 && substr(spn, 2, 2) != '80' && substr(spn, 2, 2) != '81' && substr(spn, 2, 2) != '82') {
          for (let i = 2; i + 1 < length(spn); i += 2) { let byte = hex(substr(spn, i, 2)); if (byte == 255) break; if (byte < 32 || byte > 126) { sim.spn = ''; break; } sim.spn += chr(byte); }
        }
        let override = (readJSON(apnOverridePath) || {})[sim.iccid];
        if (override) override = apnValidate(override);
        let apn = override ? { apn: override.apn, carrier: '用户配置', mcc: substr(sim.imsi,0,3), mnc: substr(sim.imsi,3,sim.mncLength || 2) } : choose(readJSON('/usr/share/cpe-status/apns.json') || [], sim, uci('apn'));
        if (!apn) {
          net('ifdown');
          save(directory + '/sim-identity.json', sim); invalidate(true);
          report('unmatched', '无法唯一匹配 SIM 归属 APN，wwan 保持关闭', { mcc: substr(sim.imsi, 0, 3) });
        } else {
          let adopt = apn.apn == uci('apn') && (!state?.iccid || state.iccid == sim.iccid);
          let username = adopt ? uci('username') : apn.user || '', password = adopt ? uci('password') : apn.password || '';
          let pdptype = adopt && index(['ip', 'ipv4', 'ipv6', 'ipv4v6'], uci('pdptype')) >= 0 ? uci('pdptype') : apn.protocol == 'IPV6' ? 'ipv6' : apn.protocol == 'IPV4V6' ? 'ipv4v6' : 'ipv4';
          let auth = !length(username) && !length(password) ? 'none' : adopt ? uci('auth') || 'none' : ({ '1': 'pap', '2': 'chap', '3': 'both' })[apn.authtype] || 'none';
          let values = override || { apn: apn.apn, pdptype, auth, username, password }, commands = [];
          for (let key, value in values) if (uci(key) != value) push(commands, 'uci set ' + quote('network.wwan.' + key + '=' + value));
          let restart = length(commands) > 0 || (state?.iccid && state.iccid != sim.iccid);
          if (restart && (netifd.up || netifd.pending)) net('ifdown');
          if (length(commands)) {
            let saved = bounded(join(' && ', commands) + ' && uci commit network && echo CPE_APN_SAVED', 8);
            if (index(saved, 'CPE_APN_SAVED') < 0) die('APN 配置保存失败，wwan 保持关闭');
          }
          for (let key, value in values) if (uci(key) != value) die('APN 配置回读不一致，wwan 保持关闭');
          let desired = readJSON(directory + '/user-data.json'), radio = at('AT+CFUN?');
          if (desired?.enabled !== false && match(radio, /\+CFUN:\s*1([^0-9]|$)/) && (restart || (!netifd.up && !netifd.pending))) {
            let submitted = bounded('ifup wwan && echo CPE_IFUP_SUBMITTED', 5);
            if (index(submitted, 'CPE_IFUP_SUBMITTED') < 0) die('APN 已保存，等待 wwan 启动成功后重试');
          }
          sim.configured = true; sim.apn = apn.apn; save(directory + '/sim-identity.json', sim); invalidate(true);
          report('ready', 'SIM 归属 APN 已配置', { carrier: apn.carrier, apn: apn.apn, mcc: apn.mcc, mnc: apn.mnc });
        }
      }
    }
  } catch(e) { report('error', '' + e); }
  unlink(lock + '/pid'); rmdir(lock);
}
mkdir(directory, 0700);
try {
  if (!prepare()) exit(0);
  if (ARGV[0] == '--prepare') exit(0);
  let startup = readJSON(directory + '/sim-identity.json');
  if (startup) { startup.configured = false; startup.checked = 0; save(directory + '/sim-identity.json', startup); }
  while (true) { tick(); sleep(2000); }
} catch(e) { report('error', '' + e); exit(1); }
`

// START=18 precedes netifd's START=20. Only wwan's autostart is changed.
export const cpeInit = String.raw`#!/bin/sh /etc/rc.common
START=18
STOP=89
USE_PROCD=1
start_service() {
  /usr/libexec/cpe-status-wwan --prepare
  procd_open_instance speed
  procd_set_param command /usr/libexec/cpe-status-speed
  procd_set_param respawn 3600 5 5
  procd_close_instance
  procd_open_instance wwan
  procd_set_param command /usr/libexec/cpe-status-wwan
  procd_set_param respawn 3600 5 5
  procd_close_instance
  procd_open_instance sms
  procd_set_param command /usr/libexec/cpe-status-sms-poll
  procd_set_param respawn 3600 5 5
  procd_close_instance
}
`
export const smsPoll = String.raw`#!/bin/sh
umask 077
while :; do
  /usr/libexec/cpe-status-messaging sync >/dev/null 2>&1
  sleep 30
done
`
