// Protocol corrections are separate from the global APN database and per-ICCID
// user settings. A shared rule contains no ICCID, username or password.
export const apnProtocolRuntime = String.raw`
const apnProtocolPath=getenv('CPE_STATUS_APN_PROTOCOL') || '/etc/cpe-status/dualstack_toone.json';
function apnProtocolStore() {
  let value=readJSON(apnProtocolPath);
  if (!stat(apnProtocolPath)) return {schema_version:1,rules:{}};
  if (value?.schema_version!=1 || type(value.rules)!='object') die('IP 协议回退记录格式无效，已保留原文件');
  return value;
}
function apnHome(sim) {
  if (!match(sim?.imsi || '',/^[0-9]{14,16}$/) || index([2,3],sim.mncLength)<0) return null;
  return {mcc:substr(sim.imsi,0,3),mnc:substr(sim.imsi,3,sim.mncLength)};
}
function apnProtocolKey(sim,apn) {
  let home=apnHome(sim);
  return home && match(apn || '',/^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/) ? home.mcc+'-'+home.mnc+'-'+lc(apn) : '';
}
function apnSelectedCustom(sim) { return sim?.iccid ? (readJSON(apnOverridePath) || {})[sim.iccid]?.apn : null; }
function apnProtocolApply(settings,sim,custom) {
  if (custom) return settings;
  let key=apnProtocolKey(sim,settings.apn);
  if (!key) return settings;
  let all=apnProtocolStore(), rule=all.rules[key], trial=all.trial;
  if (rule?.pdptype=='ipv4' || (trial?.key==key && trial.iccid==sim.iccid)) return {...settings,pdptype:'ipv4'};
  return settings;
}
function apnProtocolInfo(sim,current) {
  let key=apnProtocolKey(sim,current.apn);
  if (!key) return null;
  let all=apnProtocolStore(), rule=all.rules[key], trial=all.trial;
  if (rule?.pdptype!='ipv4' && !(trial?.key==key && trial.iccid==sim.iccid)) return null;
  return {...apnHome(sim),apn:current.apn,pdptype:'ipv4',confirmed:rule?.pdptype=='ipv4',testing:trial?.key==key && trial.iccid==sim.iccid,user_override:!!apnSelectedCustom(sim)};
}
`

// Runs inside the existing two-second connection watcher. Only host-side logs
// and netifd state are polled; no extra AT queries or separate daemon are needed.
// All effects execute under the same lock as user modem/APN operations.
export const apnRecoveryRuntime = String.raw`
const apnRecoveryWatch=directory+'/apn-protocol-watch.json';
function apnRecoveryLog(message) {
  let path=directory+'/apn-protocol-log.json', value=readJSON(path) || {logs:[]};
  push(value.logs,message); value.logs=slice(value.logs,-20); save(path,value);
}
function apnProtocolWrite(protocol) {
  if (index(['ipv4','ipv6','ipv4v6'],protocol)<0) die('IP 协议回退记录无效，未修改配置');
  let result=bounded('uci set '+apnQuote('network.wwan.pdptype='+protocol)+' && uci commit network && echo CPE_PROTOCOL_SAVED',5);
  if (index(result,'CPE_PROTOCOL_SAVED')<0 || apnSettings().pdptype!=protocol) die('IP 协议保存或回读失败');
}
function apnProtocolNetwork() {
  try { return json(bounded('ubus -S call network.interface.wwan status 2>/dev/null',2)); } catch(e) { return null; }
}
function apnProtocolIPv4(net) {
  if (!net?.up) return false;
  let networks=[];
  try { networks=json(bounded('ubus -S call network.interface dump 2>/dev/null',2))?.interface || []; } catch(e) {}
  for (let row in [net,...networks]) if (row.up===true && (row==net || row.interface=='wwan' || row.interface=='wwan_4')) {
    for (let address in row['ipv4-address'] || []) if (match(address.address || '',/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) && !match(address.address,/^(0\.|127\.|169\.254\.)/)) return true;
  }
  return false;
}
function apnProtocolRedial() {
  unlink(directory+'/apn-active.json');
  net('ifdown');
  if (index(bounded('ifup wwan && echo CPE_PROTOCOL_IFUP',5),'CPE_PROTOCOL_IFUP')<0) die('协议已保存，等待 wwan 重新拨号');
}
function apnRecoveryTick(sim) {
  // Once IPv4 is selected and no trial needs confirmation, stop log polling.
  if (!apnProtocolStore().trial && index(['ipv4v6','ipv6'],apnUci('pdptype'))<0) return;
  let now=time(), settings=apnSettings(), key=apnProtocolKey(sim,settings.apn), boot=text('/proc/sys/kernel/random/boot_id');
  let scope=join('|',[boot,sim?.iccid || '',key]), context=scope+'|'+settings.pdptype, watch=readJSON(apnRecoveryWatch), logs=null;
  try { logs=json(bounded('ubus -S call log read '+apnQuote('{"lines":256,"stream":false,"oneshot":true}')+' 2>/dev/null',2))?.log; } catch(e) {}
  let available=type(logs)=='array', last=available && length(logs) ? logs[length(logs)-1].id : watch?.last_id || 0;
  if (!watch || watch.context!=context || last<watch.last_id) watch={scope,context,last_id:last,since:now,retry_after:watch && watch.scope==scope ? watch.retry_after : 0};
  else if (available) {
    for (let row in logs) if (row.id>watch.last_id && row.time>=watch.since*1000 && row.time<=(now+5)*1000 && row.time>=(now-90)*1000 && match(row.msg || '',/^netifd: wwan \([0-9]+\): Unable to connect IPv6[[:space:]]*$/)) watch.failure={id:row.id,time:row.time};
    watch.last_id=last;
  }
  save(apnRecoveryWatch,watch);
  if (!sim?.configured || sim.present!==true || !key || sim.profile_changed || now-sim.checked>35) { delete watch.failure; save(apnRecoveryWatch,watch); return; }
  let all=apnProtocolStore(), trial=all.trial, custom=!!apnSelectedCustom(sim), desired=readJSON(directory+'/user-data.json');
  if (!trial && (!available || custom || desired?.enabled===false || index(['ipv4v6','ipv6'],settings.pdptype)<0 || !watch.failure || now-watch.failure.time/1000>90 || now<(watch.retry_after || 0))) {
    if (custom || desired?.enabled===false) { delete watch.failure; save(apnRecoveryWatch,watch); }
    return;
  }
  let lock=getenv('CPE_STATUS_LOCK') || directory+'/lock';
  if (!mkdir(lock,0700)) return;
  writefile(lock+'/pid',''+pid);
  try {
    // Re-read all writable inputs after taking the control lock.
    let current=readJSON(directory+'/sim-identity.json');
    if (current?.iccid!=sim.iccid || current.present!==true || !current.configured) die('ModemReadDeferred: 等待 SIM 确认');
    settings=apnSettings(); all=apnProtocolStore(); trial=all.trial;
    custom=!!apnSelectedCustom(current); desired=readJSON(directory+'/user-data.json');
    if (apnProtocolKey(current,settings.apn)!=key) die('ModemReadDeferred: APN 已变化');
    let netifd=apnProtocolNetwork();
    if (!netifd || index(['qmi','mbim'],netifd.proto)<0) die('ModemReadDeferred: 等待 wwan 状态');
    if (trial) {
      if (trial.key!=key || trial.iccid!=sim.iccid || custom || desired?.enabled===false || settings.pdptype!='ipv4') {
        delete all.trial; save(apnProtocolPath,all);
      } else {
        if (trial.boot_id!=boot || now<trial.started_at) { trial.boot_id=boot; trial.started_at=now; save(apnProtocolPath,all); }
        if (apnProtocolIPv4(netifd)) {
          all.rules[key]={...apnHome(current),apn:lc(settings.apn),pdptype:'ipv4',reason:'Unable to connect IPv6',confirmed_at:now};
          delete all.trial; save(apnProtocolPath,all);
          unlink(directory+'/apn-active.json');
          apnRecoveryLog('IPv4 连接成功，已保存此运营商/APN 的协议回退规则');
          report('ready','已自动改用 IPv4，并记住协议选择',{apn:settings.apn,pdptype:'ipv4'});
        } else if (now-trial.started_at>=90) {
          apnProtocolWrite(trial.previous_protocol);
          delete all.trial; save(apnProtocolPath,all);
          watch.retry_after=now+600; delete watch.failure; save(apnRecoveryWatch,watch);
          apnRecoveryLog('IPv4 连接未确认，已恢复原 IP 协议，暂不保存回退规则');
          apnProtocolRedial();
        }
      }
    } else if (netifd.up) { delete watch.failure; save(apnRecoveryWatch,watch); }
    else if (!custom && desired?.enabled!==false && netifd.pending && index(['ipv4v6','ipv6'],settings.pdptype)>=0 && watch.failure) {
      all.trial={key,...apnHome(current),apn:lc(settings.apn),iccid:sim.iccid,previous_protocol:settings.pdptype,started_at:now,boot_id:boot};
      save(apnProtocolPath,all);
      apnProtocolWrite('ipv4');
      apnRecoveryLog('检测到当前 wwan 拨号无法连接 IPv6，正在以 IPv4 重试');
      apnProtocolRedial();
    }
  } catch(e) { if (index(''+e,'ModemReadDeferred:')<0) { watch.retry_after=now+60; save(apnRecoveryWatch,watch); report('error',''+e); } }
  unlink(lock+'/pid'); rmdir(lock);
}
`
