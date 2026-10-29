import { apnRuntime } from './apn-control.ts'
import { statusRuntime } from './status-collector.ts'
import { apnRecoveryRuntime } from './apn-protocol.ts'

export const wwanManager = statusRuntime + apnRuntime + String.raw`
function quote(value) { return "'" + replace(value, /'/g, "'\\''") + "'"; }
function uci(key) { return trim(bounded('uci -q get network.wwan.' + key, 3)); }
function report(status, message, extra) { save(directory + '/wwan-manager.json', { status, message, ...(extra || {}), time: time() }); }
function net(action) { bounded(action + ' wwan', 5); }
function invalidate(simChanged) {
  unlink(directory+'/apn-active.json');
  let snapshot = readJSON(directory + '/snapshot.json');
  if (snapshot) { snapshot.sampled = {}; delete snapshot.attempted; if (simChanged) { snapshot.raw.sim = ''; delete snapshot.sim_identity; snapshot.raw.status = ''; snapshot.raw.cells = ''; } save(directory + '/snapshot.json', snapshot); }
  for (let name in ['bands.json', 'cell-locks.json', 'operators.json']) unlink(directory + '/' + name);
}
function autoApnSupported() {
  return profileEnabled('autoApn') && profileHas('simPin') && profileHas('iccid') && profileHas('imsi') && profileHas('radio');
}
function prepare() {
  if (iface != 'wwan') die('自动 APN 仅允许管理 wwan');
  if (config.autoApn === false) return false;
  if (profile && !autoApnSupported()) { report('unsupported', 'Not applicable'); return true; }
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
  let raw = at(profileCommand(cmd)); return uc(profileRow(cmd, raw).data || '');
}
function choose(entries, sim, current) {
  let valid=apnCandidates(entries,sim), specific=filter(valid,apnSpecific);
  if (length(specific)) valid=specific;
  for (let row in valid) if (row.apn == current) return row;
  return valid[0];
}
function localApns() {
  let value = readJSON('/etc/cpe-status/apns.local.json');
  if (!value || type(value.apns) != 'array') die('本地 APN 扩展配置无效');
  for (let row in value.apns) {
    if (!match(row.mcc || '', /^[0-9]{3}$/) || !match(row.mnc || '', /^[0-9]{2,3}$/) || !match(row.apn || '', /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/)) die('本地 APN 扩展条目格式无效');
  }
  return value.apns;
}
` + apnRecoveryRuntime + String.raw`
function tick() {
  if (downloadActivity().active) return;
  refreshProfile();
  let state = readJSON(directory + '/sim-identity.json');
  if (!stat(port) || !profile) {
    if (!state || state.present !== false) { net('ifdown'); save(directory + '/sim-identity.json', { ...(state || {}), present: false }); invalidate(true); }
    report('waiting', profileError || 'Modem 不存在，wwan 已停用'); return;
  }
  if (!autoApnSupported()) { report('unsupported', 'Not applicable'); return; }
  let usb=apnUsbToken();
  if (state && usb && state.usb_token!=usb) {
    if (state.usb_token) { state.present=false; state.configured=false; state.imsi=''; state.imsi_checked=0; invalidate(true); }
    state.usb_token=usb; state.checked=0; save(directory+'/sim-identity.json',state);
  }
  try { apnRecoveryTick(state); } catch(e) { report('error',''+e); }
  if (state?.checked && time() - state.checked < 30) return;
  if (manualReadPending() && state?.configured!==false && state?.present!==false && !state?.profile_switch_pending) return;
  let netifd = null;
  try { netifd = json(bounded('ubus -S call network.interface.wwan status 2>/dev/null', 3)); } catch(e) {}
  if (!netifd || index(['qmi', 'mbim'], netifd.proto) < 0) { report('waiting', '等待 netifd 的 wwan 接口就绪'); return; }
  let lock = getenv('CPE_STATUS_LOCK') || directory + '/lock';
  if (!mkdir(lock, 0700)) {
    let owner = +text(lock + '/pid');
    if (owner && !stat('/proc/' + owner)) { unlink(lock + '/pid'); rmdir(lock); }
    return;
  }
  writefile(lock + '/pid', '' + pid);
  try {
    let raw = at(profileBatch(['simPin','iccid'])), iccid = null, pin = null;
    try { iccid = profileRow('iccid', raw).iccid; pin = profileRow('simPin', raw).pin_required; } catch(e) {}
    let imsi = state?.present && state.iccid == iccid ? state.imsi : '';
    let imsiChecked = state?.imsi_checked || 0;
    if (iccid && pin == profile.simReadyValue && (!imsi || time() - imsiChecked >= 300)) {
      imsi = profileRow('imsi', at(profileCommand('imsi'))).imsi || '';
      if (imsi) imsiChecked = time();
    }
    if (profileAbsent(raw)) {
      if (state?.present !== false) { net('ifdown'); invalidate(true); }
      save(directory + '/sim-identity.json', { ...(state || {}), present: false, checked: time() }); report('waiting', 'SIM 未插入，wwan 已停用');
    } else if (!iccid || !imsi || pin != profile.simReadyValue) {
      if (!state?.present) net('ifdown');
      report('waiting', '等待 SIM 解锁及归属信息');
    } else {
      let sim = { present: true, iccid, imsi, usb_token:usb, checked: time(), imsi_checked: imsiChecked }, changed = state?.iccid != sim.iccid || state?.imsi != sim.imsi || state?.present !== true;
      if (!changed && state.configured && state.apnStamp == text('/etc/cpe-status/apns.local.json')) { state.checked = time(); state.imsi_checked = imsiChecked; save(directory + '/sim-identity.json', state); }
      else {
        // EF_AD byte 4 supplies the home MNC length; never use serving PLMN.
        let ad = binary('simAdministrative'), digit = length(ad) >= 8 ? substr(ad, 7, 1) : '';
        sim.mncLength = digit == '2' ? 2 : digit == '3' ? 3 : null;
        sim.gid = binary('simGroup');
        let spn = binary('simProvider'); sim.spn = '';
        // GSM default alphabet's printable ASCII subset is sufficient for most
        // APN SPN filters; unsupported encodings do not falsely match an MVNO.
        if (length(spn) >= 4 && substr(spn, 2, 2) != '80' && substr(spn, 2, 2) != '81' && substr(spn, 2, 2) != '82') {
          for (let i = 2; i + 1 < length(spn); i += 2) { let byte = hex(substr(spn, i, 2)); if (byte == 255) break; if (byte < 32 || byte > 126) { sim.spn = ''; break; } sim.spn += chr(byte); }
        }
        let override = (readJSON(apnOverridePath) || {})[sim.iccid];
        if (override) override = apnValidate(override);
        let apn = override ? { apn: override.apn, carrier: '用户配置', mcc: substr(sim.imsi,0,3), mnc: substr(sim.imsi,3,sim.mncLength || 2) } : (choose(localApns(), sim, '') || choose(apnOfficialEntries(), sim, uci('apn')));
        if (!apn) {
          net('ifdown');
          save(directory + '/sim-identity.json', sim); invalidate(true);
          report('unmatched', '无法唯一匹配 SIM 归属 APN，wwan 保持关闭', { mcc: substr(sim.imsi, 0, 3) });
        } else {
          requireProfile();
          let adopt = apn.apn == uci('apn') && (!state?.iccid || state.iccid == sim.iccid);
          let username = adopt ? uci('username') : apn.user || '', password = adopt ? uci('password') : apn.password || '';
          let pdptype = adopt && index(['ip', 'ipv4', 'ipv6', 'ipv4v6'], uci('pdptype')) >= 0 ? uci('pdptype') : apn.protocol == 'IPV6' ? 'ipv6' : apn.protocol == 'IPV4V6' ? 'ipv4v6' : 'ipv4';
          let auth = !length(username) && !length(password) ? 'none' : adopt ? uci('auth') || 'none' : ({ '1': 'pap', '2': 'chap', '3': 'both' })[apn.authtype] || 'none';
          let values = apnProtocolApply(override || { apn: apn.apn, pdptype, auth, username, password },sim,!!override), commands = [];
          for (let key, value in values) if (uci(key) != value) push(commands, 'uci set ' + quote('network.wwan.' + key + '=' + value));
          let restart = length(commands) > 0 || state?.profile_changed === true || (state?.iccid && state.iccid != sim.iccid);
          if (restart && (netifd.up || netifd.pending)) net('ifdown');
          if (length(commands)) {
            let saved = bounded(join(' && ', commands) + ' && uci commit network && echo CPE_APN_SAVED', 8);
            if (index(saved, 'CPE_APN_SAVED') < 0) die('APN 配置保存失败，wwan 保持关闭');
          }
          for (let key, value in values) if (uci(key) != value) die('APN 配置回读不一致，wwan 保持关闭');
          let desired = readJSON(directory + '/user-data.json'), radio = profileRow('radio', at(profileCommand('radio')));
          if (desired?.enabled !== false && radio.functionality == profile.radioStates.online && (restart || (!netifd.up && !netifd.pending))) {
            let submitted = bounded('ifup wwan && echo CPE_IFUP_SUBMITTED', 5);
            if (index(submitted, 'CPE_IFUP_SUBMITTED') < 0) die('APN 已保存，等待 wwan 启动成功后重试');
          }
          sim.configured = true; sim.apn = apn.apn; sim.apnStamp = text('/etc/cpe-status/apns.local.json'); save(directory + '/sim-identity.json', sim); invalidate(true);
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
  /usr/libexec/cpe-status/migrate || return 1
  /usr/libexec/cpe-status/wwan --prepare
  procd_open_instance speed
  procd_set_param command /usr/libexec/cpe-status/speed
  procd_set_param respawn 3600 5 5
  procd_close_instance
  procd_open_instance qos
  procd_set_param command /usr/libexec/cpe-status/qos-watch
  procd_set_param term_timeout 12
  procd_set_param respawn 3600 5 5
  procd_close_instance
  procd_open_instance wwan
  procd_set_param command /usr/libexec/cpe-status/wwan
  procd_set_param respawn 3600 5 5
  procd_close_instance
  procd_open_instance sms
  procd_set_param command /usr/libexec/cpe-status/sms-poll
  procd_set_param respawn 3600 5 5
  procd_close_instance
}
`
export const smsPoll = String.raw`#!/bin/sh
umask 077
while :; do
  /usr/libexec/cpe-status/messaging sync >/dev/null 2>&1
  sleep 30
done
`
