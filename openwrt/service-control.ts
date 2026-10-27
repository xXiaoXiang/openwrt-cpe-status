// Separate read/write executables keep a read-only LuCI session from invoking
// init actions. Both are fixed to this package's service, never network/rpcd.
export const serviceStatus = String.raw`#!/usr/bin/ucode
import { connect } from 'ubus';
function reply(value) { print(sprintf('%J\n', value)); }
if (length(ARGV)) { reply({ status: 'error', message: 'Status does not accept arguments' }); exit(1); }
try {
  let bus = connect();
  if (!bus) die('无法读取服务状态');
  let services = bus.call('service', 'list', { name: 'cpe-status' });
  if (type(services) != 'object') die('无法读取服务状态');
  let instances = services['cpe-status']?.instances || {}, running = 0, processes = [];
  for (let name in ['wwan', 'speed', 'sms', 'qos']) {
    let active = instances[name]?.running === true;
    if (active) running++;
    push(processes, { name, running: active });
  }
  reply({ status: 'ok', data: { running, total: length(processes), processes, enabled: system('/etc/init.d/cpe-status enabled >/dev/null 2>&1') == 0 } });
} catch(e) { reply({ status: 'error', message: '' + e }); exit(1); }
`

export const serviceControl = String.raw`#!/usr/bin/ucode
function reply(value) { print(sprintf('%J\n', value)); }
if (length(ARGV) != 1 || index(['start','stop','restart','enable','disable'], ARGV[0]) < 0) {
  reply({ status: 'error', message: 'Invalid CPE service action' }); exit(1);
}
let result = system('/etc/init.d/cpe-status ' + ARGV[0] + ' >/dev/null 2>&1');
reply(result == 0 ? { status: 'ok', message: 'OK' } : { status: 'error', message: '服务操作失败，请检查系统日志' });
exit(result == 0 ? 0 : 1);
`
