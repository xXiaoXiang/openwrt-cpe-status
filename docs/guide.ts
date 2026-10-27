export const guide = `# OpenWrt CPE Status 开发与配置说明

项目介绍与安装入口见 [README.md](README.md)。本文由 docs/guide.ts 生成，维护技术说明时修改源文件，构建只更新 DEV.md，不覆盖项目首页。

LuCI → Modem → CPE Status：**仪表盘、频段与小区设置、运营商与APN设置、AT控制台、短信**。浏览器运行 React；路由器使用 ucode / rpcd / netifd，无需 Node.js。ImmortalWrt 25.12.2 已完成 SDK APK 构建及 RM500Q-GL R13 实机读取验证。

公开仓库：https://github.com/xXiaoXiang/openwrt-cpe-status 。当前发布 v1.1.0，对应软件包 1.1.0-r7；版本与包修订号取自 project.ts。历史界面和行为基线可查看保留的 v0.3.0 标签。

LuCI 顶部显示 CPE 服务运行及开机自启状态，提供启动/停止、启用/禁用自启和重启；空间不足时自动分行。运行状态包含自动 APN、网速采样、短信同步及可选 QoS 监听四个后台任务，部分任务退出时显示“部分运行”。每5秒读取 procd 状态，不访问 Modem。禁用自启只影响下次开机；停止只结束本插件的后台任务，不执行 ifdown。服务控制使用专用写权限入口，只接受本插件服务的固定操作；只读账户仅能查看状态。升级保留已有自启设置。

## 构建

开发环境 Node.js 24+：

\`\`\`sh
node --experimental-transform-types tools/bootstrap.ts
npm install
npm run check
npm test
npm run build
\`\`\`

将 build/openwrt-status-package 复制到 OpenWrt / ImmortalWrt SDK 的 package/luci-app-cpe-status，执行 make package/luci-app-cpe-status/compile V=s。包依赖 luci-base、rpcd-mod-file、ucode、ucode-mod-fs、ucode-mod-ubus、sms-tool、comgt、adb，以及系统自带的 BusyBox sha256sum。build/openwrt-package 是保留的早期 Node 原型，不是当前推荐安装包。

tools/package-status-sdk.ts 的 start、status、fetch 接受第二个参数 aarch64_cortex-a53 或 x86_64，分别使用编译机上独立的 ImmortalWrt 25.12.2 SDK。产物保存到 build/sdk-test/<架构>/，APK 文件名添加对应架构后缀；包内名称和版本仍为 luci-app-cpe-status / 1.1.0-r7。SDK 下载必须与官方 SHA256 一致。ARM 对应 mediatek/filogic，x86_64 对应 x86/64；后者目前仅完成 SDK 构建与包检查，未实机运行。

tools/publish-release.ts v1.1.0 <发布说明文件或-> all 可发布两个架构，或将 all 改为单个架构。已有无架构后缀的 ARM 附件仅在摘要匹配后改名，保留原附件记录；不覆盖摘要不同的已有附件；显式指定 --prune-old-apks 时，在新包校验通过后删除同版本、所选架构的旧 APK 附件。tools/install-status.ts 默认安装 ARM 包，带架构后缀时先核对目标路由器 /etc/apk/arch 中配置的软件包架构。

静态资源统一安装到 **/www/luci-static/resources/cpe-status/**。升级脚本清理旧的 /www/luci-static/resources/openwrt-modem/ 并刷新 LuCI 缓存。

## 模块适配文件

源配置 **modem.d/2c7c0800.conf** 安装为 **/etc/cpe-status/modem.d/2c7c0800.conf**。文件是带 _comment、contracts 和每条命令 output 说明的严格 JSON，可直接编辑，无需修改 TypeScript 或重新编译。新增型号将对应 VID+PID 的八位小写十六进制文件放入同目录，修改 usbIds、modelPattern、commands 和规则即可。构建时复制 modem.d 中全部有效 .conf，不会覆盖为编译进代码的 RM500Q 命令。

后端沿配置专用 AT 端口的 sysfs USB 父设备读取 idVendor/idProduct，这与 lsusb 的 USB ID 一致；不会在多个模块中随意选择首个设备。读取文件后再验证型号；未知 ID、缺失文件、解析失败或型号不符均不会套用其他型号。默认端口 /dev/ttyUSB2，可在 /etc/cpe-status.json 修改。必须使用专用 AT 口，避免与其他 AT 程序同时使用。

配置包含：

- **commands**：语义名称（serving、neighbors、temperature、modeSet 等）、实际命令、读写类型、参数正则、超时、字段规则、输出说明与参考文档。
- **rules**：regex 的第一个捕获组交给 CSV 解析，或使用 captures；字段 index 从0开始，支持 string/number/hex/boolean、枚举 map、scale/offset、字段内 pattern 提取、范围校验和未知值。segments 处理多元组，repeat 处理计数后的重复结构。使用 POSIX/JavaScript 共有正则子集。
- **contracts**：各语义操作必须输出的字段、类型和单位。信号为真实 dBm/dB，频宽为 MHz；前端兼容层统一换算旧表格单位。MCC/MNC 必须保留为字符串。
- **groups**：仪表盘查询组合及缓存秒数。只允许读取命令；多个网页接口共享快照，不向只读接口开放写入。
- **bandOperations / radioStates / simReadyValue / simAbsentPattern**：频段操作与射频、SIM 状态定义。
- **console**：常用 AT 快捷按钮、IMEI 查询和修改所用操作，锁小区确认框也使用配置命令模板。
- **sms**：标准短信驱动及 ME/SM 存储、超时和成功标志。

新增型号可复用现有 LTE/NR、3GPP SIM 文件、频段、选网、PDP、短信、netifd 流程；专有功能或私有短信协议超出此声明式规则和已有驱动时，需要先扩展通用能力。短信当前委托 sms_tool 实现标准 3GPP CMGF/CPMS/CMGL/CMGS 和 PDU 编解码，不能仅修改几条正则支持任意私有协议。eUICC 仍停用，不探测普通 SIM 的 LPAC 能力。

adapters/rm500q-profile.ts 是维护者生成默认配置的 TypeScript 参考，tools/generate-modem-profile.ts 仅在明确需要更新默认模板时运行；普通构建直接读取 .conf。路由器上的配置修改由原生 SHA-256 指纹识别，相关旧缓存及旧控制任务不能用于新配置的结果确认。

### 不支持的操作、参数与缺省显示

在配置顶层的 unsupportedOperations 中，以语义操作名映射原因。声明优先于 commands，原命令可以保留供参考，也可以删除；组中的该操作会被跳过。比如仅 LTE 的模块可声明：

\`\`\`json
"unsupportedOperations": {
  "registration5g": "仅支持 LTE",
  "nrBands": "没有 5G SA 频段设置",
  "nrBandsSet": "没有 5G SA 频段设置",
  "nsaBands": "没有 5G NSA 频段设置",
  "nsaBandsSet": "没有 5G NSA 频段设置",
  "nrCellLock": "不支持 NR 锁小区",
  "nrCellLockSet": "不支持 NR 锁小区",
  "nrCellUnlock": "不支持 NR 锁小区"
}
\`\`\`

不能只禁用一个 NR 查询就假定所有 5G 功能关闭，必须按实际能力声明相关读、写操作。混合查询（serving、neighbors、carriers）仍可保留来读取 LTE；cellScan 的实际指令应按型号改成仅扫描其支持的 RAT。数据连接、自动 APN 和标准短信属于复合能力，分别可以用 dataControl、autoApn、sms 声明不支持。短信历史保留可读，禁止收发调用。

写参数在 parameters 的格式正则之外，可额外指定 parameterValues 白名单。例如 modeSet 定义内添加如下内容，界面将禁用 5G Only 和 LTE & 5G NR，后端也会在任何 AT 访问前拒绝这些模式：

\`\`\`json
"parameterValues": { "mode": ["AUTO", "LTE", "WCDMA:LTE", "WCDMA"] }
\`\`\`

整项读取或写入不支持时统一返回 {"status":"unsupported","message":"Not applicable","display":"-","reason":"配置原因"}，不会返回假的 false、0 或写入 OK，也不安排重试。不支持的频段组使用空数组并附带 unavailable:{"sa":"-","nsa":"-"}；锁定结果的对应 RAT 使用 status:unsupported，而非假定未锁定。前端保留原有布局，缺省显示 -，禁用对应按钮和值，不再显示等待动画。单个字段的未知值继续使用规则 optional/unknown 解析为 null，显示层再转为 -；不要将 - 填入数字或布尔字段。超时、ERROR 或解析失败不自动变为“不支持”，仍按失败/退避/旧数据保留逻辑处理。AT 控制台手动输入仍是显式调试通道；配置中不支持的快捷操作与 IMEI 写入按钮禁用。

## 缓存和控制

| 数据 | 缓存 |
|---|---|
| 网络注册/信号/运营商 | 2秒 |
| 服务小区/邻区/聚合 | 5秒共享缓存 |
| Modem 温度 | 4秒 |
| SIM、模块身份、漫游偏好、射频状态、网络模式 | 24小时，SIM变化或对应写入后更新 |
| 频段能力/偏好、小区锁定 | 24小时；进入页面、手动读取或应用后确认，不自动定时读取频段偏好 |
| 主机资源/地址 | 1秒；系统静态身份24小时 |
| 网速 | 前端1秒刷新时0.5秒采样，其余1秒；按真实时间差计算 |
| 短信同步 | 30秒；网页读取归档且遵循右上角刷新间隔 |

除网速、SIM/APN 管理和短信同步外，其他组按网页需求刷新。过期先返回上次成功数据，失败保留原采样时间并退避6秒；设置和所有串口读取共用锁。控制先提交后台任务，再轮询文件；以实际回读确认，不重复提交结果不明的写操作。飞行模式每10秒核对一次、单次最多5秒、整体60秒。

适配规则由 cpe-status-snapshot profile 单独提供，在同一前端页面会话内缓存并合并并发读取；普通快照和控制操作结果不再附带完整 adapter，只携带 profile_key 配置指纹和状态数据。指纹变化时重新读取规则并更新前端能力；旧快照与新规则不匹配时等待下一份快照，不混用解析规则。规则读取仅访问配置文件，不增加 AT 查询；路由器内部快照仍保留规则供本地工具使用。

网络模式设置先执行适配配置中的 modeSet，再用 mode 回读确认。QMI 接口还将对应 RAT 保存到 /etc/config/network 的 network.wwan.modes 并校验，例如 LTE:NR5G 对应 lte,5gnr。只修改 UCI 配置，不修改 /lib/netifd/proto/qmi.sh 等系统拨号脚本。模块回读与配置保存完成即返回 OK，界面结束加载且不显示成功提示；已启用的数据连接随后在后台 ifup wwan，网络注册、扫描和获取 IP 不延长模式等待。数据关闭时不主动拨号，待下次开启时加载配置。后台重拨提交结果记录在 /tmp/cpe-status/mode-reconnect.json，模式任务记录 modem_confirmed、config_saved 和 finished 时间以便区分等待阶段。

当前与邻区表跟随全局刷新且复用5秒缓存；全部小区和运营商扫描均须用户主动触发，完成后固定结果。小区主连接优先，再按频段排序副连接，最后邻区；LTE/NR 带宽各按配置枚举解码，不凭 COPS AcT=13 判定 NSA。

## APN、自动拨号与持久数据

- **/etc/cpe-status.json**：device、networkInterface、autoApn、smsStorage 等配置。
- **/etc/cpe-status/apns.local.json**：用户扩展，优先于内置库；安装后直接编辑，升级保留。
- **/etc/cpe-status/apn-overrides.json**：网页按 SIM 保存的自定义 APN，优先级最高。
- **/usr/share/cpe-status/apns.json**：运行时内置库，由 data/apns-conf_8.xml 编译。
- **/usr/share/cpe-status/apns-conf_8.xml**：原始库供查阅；只改设备上的 XML 不会改变运行时 JSON。
- **/etc/cpe-status/sms**：默认短信归档；短信页可改为持久挂载磁盘路径。
- **/tmp/cpe-status**：私有运行缓存，重启清空。

本地 APN 扩展示例：

\`\`\`json
{"apns":[{"carrier":"示例运营商","mcc":"454","mnc":"00","apn":"internet","protocol":"IPV4V6"}]}
\`\`\`

支持 user/password/authtype 及 mvno_type/mvno_match_data。匹配使用 IMSI、ICCID、EF_AD 的归属 MNC 长度及 SPN/GID，不以漫游地 PLMN 代替 SIM 归属。修改扩展库后后台在下一次 SIM 核对时重新匹配；无法唯一匹配时不擅自拨号。

自动 APN 服务 /etc/init.d/cpe-status 在开机网络服务前准备配置，**只管理已存在的 wwan QMI/MBIM 接口**，不操作 br-lan、wan 或其他接口。原配置备份到 /etc/cpe-status/wwan-original.json；将 wwan.auto 置0，模块消失时停止 wwan，SIM/APN 配置并回读成功后再 ifup wwan。可设 autoApn=false 停用，之后按需要自行恢复 wwan.auto。更改 APN 时只重拨 wwan，保留 modes/plmn 与小区锁定设置。

/etc/cpe-status.json、模块配置和本地 APN 扩展声明为升级配置；短信和各 SIM 覆盖记录不由包覆盖，系统升级也需保留 /etc/cpe-status/。挂载磁盘的短信历史应自行备份。

## 可选的 ADB QoS 采集

RM500Q 适配文件的 diagQos 声明 adb-diag-socket 能力。插件的 procd 后台任务在模块 ADB 可用后，将采集器临时复制到模块 /tmp，监听 LTE NAS 默认承载中的 QCI、上下行 APN-AMBR，取得数据后停止，最多等待90秒。模块持久文件、启动项和射频状态均不修改；前端读取路由器 /tmp/cpe-status/qos.json 缓存，不按页面刷新频率操作诊断接口。自动 APN 拨号、保存 APN 后重拨、手动开启数据、修改网络模式及手动关闭飞行模式前，统一请求监听，最多等待6秒让本次 DIAG 订阅就绪后继续；已有监听直接复用。仅等待监听准备，不等待 QoS 结果；失败不阻止拨号。

须自行开启模块 ADB，固件内须有 Perl 和 diag_socket_log。插件依赖路由器 adb，并按 AT 串口的 USB 父设备序列号选择 ADB 设备。没有 ADB、已有其他日志采集器或未捕获新承载时不伪造结果，不自动开关飞行模式。可以等待自然重连，最后才手动切换飞行模式。当前仅解码 LTE/EPS QCI（包括 NSA），不将它作为 SA 5QI。设 /etc/cpe-status.json 的 moduleQos=false 可停用。APN-AMBR 是网络下发的聚合速率配置，不是实测网速。

QoS 缓存没有定时过期，同一模块、SIM、APN 和启动周期内持续复用；ADB 短暂不可达不会清空已有结果。重新拨号时准备采集，新结果成功后替换旧值；未抓到新承载时保留原缓存。换 SIM、换 APN 或确认模块重新启动后不复用旧结果，路由器重启也会清空 /tmp 缓存。

模块侧临时文件为 /tmp/cpe-status-qos-collector.pl 和 /tmp/cpe-status-qos/ 下的结果、状态、日志、原掩码及锁文件。采集结束后停止自己的日志进程并恢复诊断掩码，文件不立即删除，每次采集覆盖，模块断电后由 tmpfs 清空；不写入模块持久分区。原始 DIAG 日志上限为 2 MiB。

## 验证与来源

历史浏览器测试已移除。npm test 仅运行主机网络与适配规则缓存的快速检查，覆盖 wwan_4 / wwan_6 地址、公网 IPv6 前缀、规则请求复用及指纹变化；其他单元测试及 tools/check-router-*.ts 保留为手动检查，不进入默认测试流程。tools/check-data-control.ts 是手动运行的短集成检查，在路由器 /tmp 使用模拟 AT/netifd 确认 wwan 上线即可完成开关，不影响真实连接。类型检查及构建按需执行，真实公网 IPv6 仍需支持 IPv6 的 SIM 实网核对。

配置参考移远官方 RG50xQ/RM5xxQ AT Manual V1.2：https://www.quectel.com/content/uploads/2024/02/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf 。R11为起点，已结合 RM500QGLABR13A03M4G 实际格式修订。NR QNWLOCK 为 PCI,ARFCN,SCS,Band，写后回读判断；不改变用户的 save_ctrl=0,0。

源码继承 project-cpe 的 GPL-3.0-only 许可，保留作者 1orz / xXiaoXiang 的声明；APN XML 保留 AOSP 原许可。参考实现包括 4IceG/luci-app-3ginfo-lite、4IceG/luci-app-modemband 和 obsy/modemband，相关来源与查阅版本保留在 docs/status-guide.ts。厂商 PDF 和设备日志不随仓库分发。
`
