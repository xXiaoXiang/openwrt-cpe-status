// Historical migration inventory from the original UDX710/oFono backend.
// Retained for provenance only: commands, cache times and support below describe
// the initial port, not the current plugin. See modem.d/*.conf and DEV.md instead.
export const modemInventory = [
  ['/device', 'Modem.GetProperties', 'manufacturer,model,revision,imei,radio', '设备标识300秒；射频10秒'],
  ['/device/imeisv', 'Modem.GetProperties', 'revision', '原接口返回 SVN；CGMR 不能冒充 SVN，暂不移植'],
  ['/sim', 'SimManager / MessageManager.GetProperties', 'simPin,iccid,imsi,phone,smsCenter', '30秒；不猜 IMSI 的 MNC 长度'],
  ['/sim/slot', 'SimManager.GetProperties', '未移植', '单模块/单 SIM；后续按 QUIMSLOT 能力扩展'],
  ['/network', 'NetworkRegistration / RadioSettings.GetProperties', 'registration,registration5g,operator,signal,mode,serving', '注册/运营商/信号10秒；制式偏好/小区30秒'],
  ['/network/signal-strength', 'NetworkRegistration.GetProperties', 'signal', '数据已归并 /network；不另发同类命令'],
  ['/network/nitz', 'NetworkRegistration.GetProperties', 'clock', '30秒；CCLK 是模块时钟，不能证明 NITZ 已同步'],
  ['/network/operators', 'GetOperators', 'operator', '仅已知当前运营商；扫描另行触发'],
  ['/network/operators/scan', 'Scan', 'operatorScan', '用户显式触发；缓存300秒；超时180秒'],
  ['/network/register-auto', 'Register / AT+COPS=0', 'operatorAuto', '写入不缓存；不把命令完成当作已注册'],
  ['/network/register-manual', 'NetworkOperator.Register / AT+COPS=1', 'operatorManual', '写入不缓存；明确 PLMN，保留设置直至恢复自动'],
  ['/cells', 'NetworkMonitor.GetServingCellInformation + SPENGMD', 'serving,neighbors', '共享30秒；SWR旧结果最多额外120秒；只剩2个显式查询'],
  ['/location/cell-info', 'ServingCell + NetworkRegistration + SPENGMD', 'serving,neighbors', '与 /cells 共享；不再重新触发相同底层小区采集'],
  ['/qos', 'AT+CGEQOSRDP', 'qos', '30秒；官方手册未列出，默认不采集，支持后再启用'],
  ['/data GET', 'ConnectionManager.GetContexts', 'netifd status；attach/contextsActive仅作诊断', '10秒；主机接口 up 与 Modem PDP 激活分开'],
  ['/data POST', 'ConnectionContext.Active', 'netifd ifup/ifdown', '由协议驱动管理 QMI/MBIM，禁止 AT+CGACT 替代拨号'],
  ['/apn GET', 'ConnectionManager.GetContexts', 'contexts,contextsActive', '10秒；与 APN 页共用，不伪造激活状态'],
  ['/apn POST', 'ConnectionContext.SetProperty', 'apnSet', 'PDP定义写入后回读；netifd APN/密码另由网络接口配置'],
  ['/roaming', 'ConnectionManager.RoamingAllowed / Registration.Status', 'registration；数据漫游策略待协议驱动实现', 'QNWPREFCFG roam_pref 是注册策略，不能等同数据漫游开关'],
  ['/airplane-mode GET/POST', 'Modem.Powered/Online', 'radio,airplaneSet', '读取10秒；写后每10秒核实，单次读5秒，整体最多60秒'],
  ['/radio-mode GET/POST', 'RadioSettings.TechnologyPreference', 'mode,modeSet', '读取30秒；写入后回读'],
  ['/band-lock GET/POST', 'UDX710 SP-band AT commands', 'lteBands,nsaBands,nrBands,bandCapabilities,bandSet', '配置30秒；能力300秒；NSA/SA分别设置；恢复持久化基线'],
  ['/cell-lock GET/POST', 'UDX710 SP-cell AT commands', '未移植', '不把 UDX710 私有锁小区命令套用到移远'],
  ['/ims/status', 'IpMultimediaSystem.GetProperties', '未启用', '不通过存在 ims APN 推断 VoLTE 注册'],
  ['/sms/list,/sms/conversation,/sms/stats', '本地 SQLite；D-Bus 短信监听', 'smsPduMode,smsList', '改为 SIM/Modem 存储，3接口共用10秒快照；不是原有历史库'],
  ['/sms/send,/sms/clear', 'MessageManager.SendMessage / SQLite', 'smsSend,smsDelete', '确认提示符与最终+CMGS/OK；禁止自动重发；删除逐条确认'],
  ['/euicc', 'LPAC chip info / profile list', '独立 LPAC/APDU 插件', '成功/失败探测缓存10秒；chip info硬超时10秒'],
  ['/euicc/profile/*,/euicc/notifications/*', 'LPAC 子进程', '独立 LPAC/APDU 插件', '与 AT 调度互斥，子进程输出/超时有界；非普通 AT 正则映射'],
  ['/at', 'Modem.SendAtcmd', '共享串口队列的原始命令', '不缓存，15秒；不提供 UDX710 私有快捷操作'],
  ['/stats,/network/interfaces,/connectivity', '/proc,/sys,netlink,ping', 'OpenWrtHost + temperature', '主机stats1秒、netifd10秒、ping15秒；另附QTEMP模块温度30秒'],
  ['data watchdog', '周期读取 Context/ConnectionManager', '由 netifd 协议驱动负责重连', '新项目不再后台轮询 Modem；网页关闭后无周期 AT 查询'],
] as const

export const excludedPages = ['设备详情独立页', '电话与通话设置', 'UDX710 USB gadget切换', 'UDX710 OTA', 'init.sh管理', 'Web Terminal', '短信/来电推送']
