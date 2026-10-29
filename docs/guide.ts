import { packageManifest, packageRelease } from '../project.ts'

export const guide = `# OpenWrt CPE Status 开发与配置说明

项目介绍与安装入口见 [README.md](README.md)。本文由 docs/guide.ts 生成，维护技术说明时修改源文件，构建只更新 DEV.md，不覆盖项目首页。

LuCI → Modem → CPE Status：**状态、频段/小区、运营商/APN、AT、短信、eUICC**。eUICC 入口仅在已安装 lpac 且检测到有效 EID 后显示。浏览器运行 React；路由器使用 ucode / rpcd / netifd，无需 Node.js。ImmortalWrt 25.12.2 已完成 SDK APK 构建及 RM500Q-GL R13 实机读取验证。

公开仓库：https://github.com/xXiaoXiang/openwrt-cpe-status 。当前发布 v${packageManifest.version}，对应软件包 ${packageManifest.version}-r${packageRelease}；版本与包修订号取自 project.ts。历史界面和行为基线可查看保留的 v0.3.0 标签。

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

tools/package-status-sdk.ts 的 start、status、fetch 接受第二个参数 aarch64_cortex-a53 或 x86_64，分别使用编译机上独立的 ImmortalWrt 25.12.2 SDK。产物保存到 build/sdk-test/<架构>/，APK 文件名添加对应架构后缀；包内名称和版本为 luci-app-cpe-status / ${packageManifest.version}-r${packageRelease}。SDK 下载必须与官方 SHA256 一致。ARM 对应 mediatek/filogic，x86_64 对应 x86/64；后者目前仅完成 SDK 构建与包检查，未实机运行。

tools/publish-release.ts v${packageManifest.version} <发布说明文件或-> all 可发布两个架构，或将 all 改为单个架构；追加 --include-lpac 同时发布经校验的 curl/HTTPS lpac 包及对应源码。已有无架构后缀的 ARM 附件仅在摘要匹配后改名，保留原附件记录；不覆盖摘要不同的已有附件；显式指定 --prune-old-apks 时，在新包校验通过后删除同版本、所选架构的旧 APK 附件。tools/install-status.ts 默认安装 ARM 包，带架构后缀时先核对目标路由器 /etc/apk/arch 中配置的软件包架构。

静态资源统一安装到 **/www/luci-static/resources/cpe-status/**。升级脚本清理旧的 /www/luci-static/resources/openwrt-modem/ 并刷新 LuCI 缓存。

## 模块适配文件

源配置 **modem.d/2c7c0800.conf** 安装为 **/etc/cpe-status/modem.d/2c7c0800.conf**。文件是带 _comment、contracts 和每条命令 output 说明的严格 JSON，可直接编辑，无需修改 TypeScript 或重新编译。新增型号将对应 VID+PID 的八位小写十六进制文件放入同目录，修改 usbIds、modelPattern、commands 和规则即可。构建时复制 modem.d 中全部有效 .conf，不会覆盖为编译进代码的 RM500Q 命令。

后端沿配置专用 AT 端口的 sysfs USB 父设备读取 idVendor/idProduct，这与 lsusb 的 USB ID 一致；不会在多个模块中随意选择首个设备。读取文件后再验证型号；未知 ID、缺失文件、解析失败或型号不符均不会套用其他型号。默认端口 /dev/ttyUSB2，可在 /etc/cpe-status/config.json 修改。必须使用专用 AT 口，避免与其他 AT 程序同时使用。

配置包含：

- **commands**：语义名称（serving、neighbors、temperature、modeSet 等）、实际命令、读写类型、参数正则、超时、字段规则、输出说明与参考文档。
- **rules**：regex 的第一个捕获组交给 CSV 解析，或使用 captures；字段 index 从0开始，支持 string/number/hex/boolean、枚举 map、scale/offset、字段内 pattern 提取、范围校验和未知值。segments 处理多元组，repeat 处理计数后的重复结构。使用 POSIX/JavaScript 共有正则子集。
- **contracts**：各语义操作必须输出的字段、类型和单位。信号为真实 dBm/dB，频宽为 MHz；前端兼容层统一换算旧表格单位。MCC/MNC 必须保留为字符串。
- **groups**：仪表盘查询组合及缓存秒数。只允许读取命令；多个网页接口共享快照，不向只读接口开放写入。
- **bandOperations / radioStates / simReadyValue / simAbsentPattern**：频段操作与射频、SIM 状态定义。
- **console**：常用 AT 快捷按钮、IMEI 查询和修改所用操作，锁小区确认框也使用配置命令模板。
- **sms**：标准短信驱动及 ME/SM 存储、超时和成功标志。

新增型号可复用现有 LTE/NR、3GPP SIM 文件、频段、选网、PDP、短信、netifd 流程；专有功能或私有短信协议超出此声明式规则和已有驱动时，需要先扩展通用能力。短信当前委托 sms_tool 实现标准 3GPP CMGF/CPMS/CMGL/CMGS 和 PDU 编解码，不能仅修改几条正则支持任意私有协议。

### eUICC 管理

自行安装支持模块的 lpac，确保可直接从 PATH 执行。没有安装时在检查缓存前就隐藏入口；只有 chip info 成功返回32位 EID 后才显示 eUICC。卡片通信设置弹窗可选择自动、AT、AT+CSIM、UQMI、QMI、MBIM、STDIO AT Bridge，分别设置 AT/WDM 端口和卡槽，以及自动/Curl/STDIO HTTP。配置保存在 /etc/cpe-status/euicc.json，升级保留，不修改 /etc/config/lpac。未配置时 QMI 默认 UQMI，MBIM 默认 MBIM，其余默认 AT；AT 默认 /dev/ttyUSB2，WDM 默认 network.wwan.device 或 /dev/cdc-wdm0，卡槽默认1。HTTP 自动优先已有 curl 驱动，只有 stdio 插件时自动使用 bridge。每次调用显式传入 LPAC_*；若存在 /usr/lib/lpac/lpac，直接调用以避免包装脚本覆盖设置。MBIM 使用代理并禁止自动槽位映射。

STDIO HTTP 由路由器 curl 完成 HTTPS，请求头和请求体按 LPAC stdio 协议转发，响应状态和字节转回 LPAC；不要求 lpac 内置 curl，可与原生 UQMI/QMI/MBIM/AT 独立组合。STDIO APDU 使用 AT CCHO/CGLA/CCHC。桥接调度和消息协议移植自 fildunsky/luci-app-5gmodem 的 esim.sh / esim-apdu-bridge.sh（f495ea89c87c19194672666280e143e58993f7fa，Fil Dunsky，GPL-3.0-only），源码为 openwrt/euicc-bridge.ts。保留现有进程组超时、队列和 AT 锁；私有 FIFO/HTTP 临时文件结束即清理，不盲目重发写 APDU、不关闭其他应用的逻辑通道。使用 fdopen 接管已有 FIFO 描述符，防止 lpac 错误命令提前退出时重新打开管道挂起。包内包含来源说明。AT bridge 仍通过 CGLA，RM500Q 下载优先使用已验证的 UQMI。

STDIO HTTPS 默认验证系统 CA 加包内 GSMA RSP2 Root CI1，可将额外可信 CA 放入 /etc/cpe-status/esim-ca.pem（升级保留）；不会修改系统全局 CA。prod.smdp-plus.rsp.goog 等测试服务器可能使用不同的私有测试 CA。卡片通信设置中可显式关闭 STDIO 的 HTTPS 证书校验，默认开启；关闭会降低服务器身份验证，仅在确认服务器可信时选择。原生 Curl 的 TLS 行为由 lpac 自身决定。

路由器 CLI 测试入口为 /usr/libexec/cpe-status/lpac-test，参数与 lpac 相同，例如 profile list。默认 UQMI + STDIO HTTP；CPE_TEST_APDU=stdio 切换 AT APDU bridge，CPE_LPAC_TLS_VERIFY=0 显式关闭本次 HTTPS 验证，CPE_LPAC_CA_BUNDLE 可指定补充 CA 路径。独立 shell PID 持有公共锁，默认180秒超时（CPE_LPAC_TIMEOUT 可设1–600秒），按进程组终止后释放锁。默认直接打印进度及 STDIO 请求/响应，direction=request 为 LPAC 发来的 HTTP/APDU 请求，direction=response 为 bridge 回传的 rcode/rx 或 ecode/data，十六进制内容保持原样。使用 --log /tmp/lpac.log profile list 将输出改写到指定文件；默认不保存日志文件。完整交互可能包含卡片数据和下载凭据，请在分享日志前处理敏感内容。不再使用交互 shell 中自行创建锁的 lpac_stdio 函数。

Profile 下载提交后使用独立进程会话执行，浏览器只读取任务进度，切换 Tab、打开其他 LuCI 插件或关闭浏览器不会取消任务。下载进度窗口提示留在页面等待结束。下载入队即暂停本插件的其他 Modem 刷新与写操作；前端保留旧数据、停止定时轮询，后端不再为刷新建立新任务，已有读任务等待后续恢复，短信同步、自动 APN/拨号管理和 QoS 的 ADB 访问也让路。仅查询本地任务状态来判断恢复时机；完成、失败、超时或工作进程退出后恢复，不因为页面卸载提前解除暂停。CLI 的 profile download 同样发布活动标记并在清理时移除。网速采样等只读路由器本地计数器的任务保留运行。其他插件自身发出的 Modem 命令不在本插件的调度范围内。

未实现通用的强制 SIM 刷新命令，已移除该按钮；普通刷新仅重新读取信息。已确认的 EID 缓存按 USB/SIM 身份隔离，改变通信设置不抹去同卡成功检测记录，方便配置失败后重新设置；换卡/USB 重连仍重新检测。

芯片检测与其他 Modem 操作共用队列和互斥锁，并发访问合并为同一任务。成功检测缓存24小时，普通 SIM 的否定结果缓存5分钟；USB 重连、SIM ICCID 或适配文件变化后重新检测。前端每5秒检查能力只读缓存/任务状态，不等于每5秒执行 chip info。配置列表和通知在打开相应页面及手动刷新时读取。chip info 超时10秒、列表20秒、单次写操作最多120秒；超时结束独立进程组及子进程并释放锁。

读取与写入分别经 /usr/libexec/cpe-status/euicc-read / /usr/libexec/cpe-status/euicc-control 提供，LuCI ACL 分开授权。写请求仅提交一次，随后轮询任务文件；切换、删除、昵称须回读确认。切换 Profile 前先准备 ADB DIAG（最多等待20秒订阅就绪），替换旧 Profile 的监听并清除旧 QoS。enable 只发一次，其返回异常后仍以实际列表确认；每轮先等2秒再读 profile list，最多4轮，临时 euicc_init 不跳过后续重试。确认目标 enabled 后直接用该次列表更新前端；仍未确认返回 unconfirmed，提示“判断Profile切换超时，请主动刷新页面”。切换开始即使 SIM/APN 缓存过期，确认后清除旧 IMSI；SIM/APN 管理依据实际卡身份配置并更新 wwan，APN 相同时也更新旧数据会话。采集结果保存在路由器 /tmp/cpe-status/qos-pending.json，等待目标 ICCID 确认后发布，不要求 APN 相同，也不等待 APN 配置完成，不因短暂确认延迟丢弃；旧启动周期/USB/任务不能回写新连接。失败不借用旧 Profile 数据，不自动切换飞行模式，不覆盖网络模式和运营商选择。下载激活码等参数放在权限0700的临时任务目录，工作进程取走后移除请求内容；结果与输出保留最多1小时。实机验证只使用只读命令，写路径通过隔离模拟程序验证。

自动 APN 改变时不额外订阅 DIAG，Profile 切换时准备的监听继续运行；采集结果按确认的 ICCID 归属，不与 APN 名称匹配。RM500Q 的 QCCID 允许末尾单个 F/f 填充，匹配时只提取数字 ICCID。

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

读取任务按频段、小区锁定状态、APN、当前运营商和基础快照去重，状态写入 /tmp/cpe-status/read-<类型>.json；相同端口与适配指纹的并发浏览器请求共用任务ID，不会因为轮询而重复排队。手动读取按入队顺序执行，优先于基础快照；后台快照在每组AT查询结束后检查并让出通道，SIM核对和短信同步也会让路。队列等待上限45秒，单次AT命令仍使用原有超时；失败退避6秒，工作进程退出会被识别并允许重新读取。旧数据保持到新结果成功返回。冷启动快照也由后台任务采集，LuCI RPC只提交或读取文件，不等待整批AT查询。ubus权限拒绝、超时和连接故障分别提示，超时不再误报成权限错误。

小区锁定状态查询使用与AT控制台相同的comgt终止行读取器，仍从适配文件获取命令并共享AT锁；R13实机曾出现sms_tool返回空内容或上一条QNWLOCK回复，不能据此确认当前状态。无效回复保留旧结果、标记任务失败并退避，不按24小时成功缓存处理。

适配规则由 /usr/libexec/cpe-status/snapshot profile 单独提供，在同一前端页面会话内缓存并合并并发读取；普通快照和控制操作结果不再附带完整 adapter，只携带 profile_key 配置指纹和状态数据。指纹变化时重新读取规则并更新前端能力；旧快照与新规则不匹配时等待下一份快照，不混用解析规则。规则读取仅访问配置文件，不增加 AT 查询；路由器内部快照仍保留规则供本地工具使用。

网络模式设置先执行适配配置中的 modeSet，再用 mode 回读确认。QMI 接口还将对应 RAT 保存到 /etc/config/network 的 network.wwan.modes 并校验，例如 LTE:NR5G 对应 lte,5gnr。只修改 UCI 配置，不修改 /lib/netifd/proto/qmi.sh 等系统拨号脚本。模块回读与配置保存完成即返回 OK，界面结束加载且不显示成功提示；已启用的数据连接随后在后台 ifup wwan，网络注册、扫描和获取 IP 不延长模式等待。数据关闭时不主动拨号，待下次开启时加载配置。后台重拨提交结果记录在 /tmp/cpe-status/mode-reconnect.json，模式任务记录 modem_confirmed、config_saved 和 finished 时间以便区分等待阶段。

当前与邻区表跟随全局刷新且复用5秒缓存；全部小区和运营商扫描均须用户主动触发，完成后固定结果。小区主连接优先，再按频段排序副连接，最后邻区；LTE/NR 带宽各按配置枚举解码，不凭 COPS AcT=13 判定 NSA。

## APN、自动拨号与持久数据

- **/etc/cpe-status/config.json**：device、networkInterface、autoApn、smsStorage 等配置。
- **/etc/cpe-status/apns.local.json**：用户扩展，优先于内置库；安装后直接编辑，升级保留。
- **/etc/cpe-status/apn-overrides.json**：以 ICCID 为键保存当前选择及 custom_apn 数组；一张卡可保存多套配置，APN、协议、认证、用户名和密码相同不重复保存。兼容旧版单条记录，自定义选择优先。
- **/etc/cpe-status/dualstack_toone.json**：独立保存经验证的 IPv4 回退规则，以 SIM 归属 MCC、MNC（保留前导零）及 APN 为键，同一运营商/APN 可跨 SIM 共用。规则只覆盖 IP 协议，不改变 APN、认证或用户名密码，也不写入 custom_apn。优先级为用户自定义完整配置 > 协议回退覆盖的全局配置 > 原全局配置；本地 APN 扩展同样可应用协议修正。
- **/etc/cpe-status/apn-database.json**：用户点击更新后安装的全球数据库，优先于包内数据库；.managed 文件保存插件写入时的校验值，升级保留。
- **/usr/share/cpe-status/apns.json**：运行时内置库，由项目内 data/apn-database.ts 生成，包含 GNOME MBPI + AOSP 数据；无需首次联网更新即可匹配。
- **/usr/share/cpe-status/apn-database-base.json**：内置数据库版本、条目数、上游摘要及安装文件校验值。
- **/usr/share/cpe-status/apns-conf_8.xml**：原有 AOSP XML 留作参考；当前内置库不再由此 XML 生成，只改设备上的 XML 不会改变运行时 JSON。
- **/etc/cpe-status/sms**：默认短信归档；短信页可改为持久挂载磁盘路径。
- **/tmp/cpe-status**：私有运行缓存，重启清空。

本地 APN 扩展示例：

\`\`\`json
{"apns":[{"carrier":"示例运营商","mcc":"454","mnc":"00","apn":"internet","protocol":"IPV4V6"}]}
\`\`\`

支持 user/password/authtype 及 mvno_type/mvno_match_data。匹配使用 IMSI、ICCID、EF_AD 的归属 MNC 长度及 SPN/GID，不以漫游地 PLMN 代替 SIM 归属。修改扩展库后后台在下一次 SIM 核对时重新匹配；无法唯一匹配时不擅自拨号。

运营商/APN 的选择框依次列出本 ICCID 的自定义配置、本地扩展和数据库匹配项，保留同一运营商的多条 APN，连接参数完全相同的选项合并。选择只填充表单，点击“保存APN”才保存并重新拨号。下拉列表按“来自修改”和“来自数据库”分组，手动入口为“手动修改”；蓝、绿底纹与小区表保持一致，并跟随深浅色。个人记录的红色删除按钮首次点击仅变为“确认删除个人APN设置”，第二次才提交；关闭列表取消确认。删除按当前 ICCID 和全部连接参数精确匹配，仅移除持久记录，不拨号；最后一条删除后移除此卡覆盖，其他卡和数据库不受影响。删除当前选择且仍有其他个人记录时，保留第一条作为下次使用的选择。已激活 APN 缓存绑定 USB 连接、ICCID、APN 及 IP 协议；换卡、Profile 切换、重拨时清除旧值，迟到的旧身份读取不能回写。只显示与当前配置匹配的实际激活 PDP。已知 Profile/SIM 变化优先重新识别并匹配 APN；USB 重连按设备会话识别，不等待30秒常规检查间隔。

“检测 APN 数据库更新”使用与 luci-app-5gmodem 相同的 openwrt-apn-autoconfig 全球数据，来源 GNOME MBPI + AOSP：https://darthanwalt.github.io/openwrt-apn-autoconfig/providers/providers.tsv 。一次点击检查并应用更新，独立后台任务去重；校验格式、条目、版本和内容摘要，下载/验证失败保留旧库，不允许版本倒退。包内 JSON/XML 或下载后的数据库被手动修改时不覆盖；本地扩展和 custom_apn 始终不由更新替换。更新不会改动当前 wwan 配置或触发重拨，新的候选显示在页面，下次实际匹配时采用新库。按 ICCID 选过的自定义配置持续优先。数据源的 NOTICE、Apache-2.0 和 MBPI-CC-PDDC 原文随包存放在 /usr/share/cpe-status/apn-database-source/；构建不联网。

维护者更新包内数据库：执行 node --experimental-transform-types tools/prepare-apn-source.ts，校验上游 TSV 后刷新 data/apn-database.ts、来源许可及隔离测试样本；正常打包直接读取本地数据。在线更新时同时比较安装包内的版本与上游摘要，相同内容不重复写入下载库。

自动 APN 服务 /etc/init.d/cpe-status 在开机网络服务前准备配置，**只管理已存在的 wwan QMI/MBIM 接口**，不操作 br-lan、wan 或其他接口。原配置备份到 /etc/cpe-status/wwan-original.json；将 wwan.auto 置0，模块消失时停止 wwan，SIM/APN 配置并回读成功后再 ifup wwan。可设 autoApn=false 停用，之后按需要自行恢复 wwan.auto。更改 APN 时只重拨 wwan，保留 modes/plmn 与小区锁定设置。

/etc/cpe-status/config.json、模块配置和本地 APN 扩展声明为升级配置；短信和各 SIM 覆盖记录不由包覆盖，系统升级也需保留 /etc/cpe-status/。挂载磁盘的短信历史应自行备份。

后端程序统一安装在 /usr/libexec/cpe-status/，包含 snapshot、apn、control、euicc-read 等入口及 QoS 采集器。主配置为 /etc/cpe-status/config.json。升级先保存旧版根目录主配置，再在启动服务前迁入新位置；备份留在 /etc/cpe-status/legacy/。已有新版自定义配置优先保留；原 APN、模块适配、eUICC 和短信数据不搬动。迁移完成后删除旧入口，前端 RPC、ACL、启动项、热插拔和内部子进程均使用新路径。只读内置库和许可仍放 /usr/share/cpe-status/，缓存和任务仍放 /tmp/cpe-status/。

自动 APN 的现有2秒连接检测循环同时检查新的 wwan IPv6 拨号失败日志（Unable to connect IPv6），不增加 AT 查询；以日志消息 ID、时间、当前 SIM/APN 和 IP 协议隔离操作，忽略历史消息、其他接口和已正常连接的网络。无自定义覆盖且数据开关开启时，按公共控制锁仅改 wwan.pdptype 为 ipv4 后重拨，不触发 DIAG。只有 netifd 上线并确认 IPv4 地址后才发布共享规则；90秒内未确认则恢复原协议并退避10分钟。验证中的 trial 也保存在同一持久文件，路由器重启后可继续确认；用户改配置或 SIM/APN 改变会取消旧 trial。规则随 /etc/cpe-status/ 保留，Modem 重新上线及路由器重启配置 APN 时均先应用规则；成功后停止日志轮询。自定义 APN 始终保留其全部字段，不自动降级。APN 页面显示协议回退状态及对应拨号日志。

## 可选的 ADB QoS 采集

RM500Q 适配文件的 diagQos 声明 adb-diag-socket 能力。插件的 procd 后台任务在模块 ADB 可用后，将采集器临时复制到模块 /tmp，监听 LTE NAS 默认承载中的 QCI、上下行 APN-AMBR，取得数据后停止，最多等待90秒。模块持久文件、启动项和射频状态均不修改；前端读取路由器 /tmp/cpe-status/qos.json 缓存，不按页面刷新频率操作诊断接口。USB 重连和 Profile 切换仍会准备采集；手动开启数据、修改网络模式及手动关闭飞行模式前，统一请求监听，最多等待6秒让本次 DIAG 订阅就绪后继续；已有监听直接复用。自动配置 APN、保存 APN、IPv4 协议回退及回滚引起的重拨不启动或重置 DIAG，也不等待其就绪。仅等待监听准备，不等待 QoS 结果；失败不阻止拨号。

须自行开启模块 ADB，固件内须有 Perl 和 diag_socket_log。插件依赖路由器 adb，并按 AT 串口的 USB 父设备序列号选择 ADB 设备。没有 ADB、已有其他日志采集器或未捕获新承载时不伪造结果，不自动开关飞行模式。可以等待自然重连，最后才手动切换飞行模式。当前仅解码 LTE/EPS QCI（包括 NSA），不将它作为 SA 5QI。设 /etc/cpe-status/config.json 的 moduleQos=false 可停用。APN-AMBR 是网络下发的聚合速率配置，不是实测网速。

USB hotplug 异步唤醒 QoS 调度器；若 USB 事件先于 AT 串口节点出现，最多等待5秒匹配配置对应的设备。独立工作进程使用指定序列号的 adb wait-for-device 等待上线，随后立即订阅 DIAG，不等待 SIM/APN 查询或 AT 队列；2秒轮询仅作为漏事件和启动时已连接设备的兜底。ADB 等待和90秒采集均不占住连接检测循环，同一 USB 会话只保留一个任务。设备总线号/设备号隔离不同连接，断开立即使旧缓存和旧任务失效，迟到的旧任务不能回写新连接。模块未重启但 USB 重新枚举时，仅停止插件自己前一次的采集器并恢复掩码，再建立新订阅。健康连接的启动标识检查仍为8秒限频，新连接和拨号准备不受此限频影响。模块在 ADB 就绪前已发出的 NAS 消息无法补抓。升级时可只读恢复旧版因 APN 不匹配而丢弃的已完成采集，须确认同一 USB、启动周期、采集任务及目标 ICCID，不重新订阅 DIAG。

QoS 缓存没有定时过期，同一次 USB 连接内且模块、ICCID 和启动周期一致时持续复用；ADB 短暂不可达不会清空已有结果。新结果成功后替换旧值；新采集任务编号改变、重拨失败或未抓到新承载时仍展示原缓存，不伪造新的采样时间。旧采集工作进程仍须匹配当前任务编号才能发布，避免覆盖新连接。APN 改变不使 QCI 缓存失效；USB 断开、换 SIM 或确认模块重新启动后不复用旧结果，路由器重启也会清空 /tmp 缓存。

模块侧临时文件为 /tmp/cpe-status-qos-collector.pl、/tmp/cpe-status-qos-collector.log 和 /tmp/cpe-status-qos/ 下的结果、状态、日志、原掩码及锁文件。采集结束后停止自己的日志进程并恢复诊断掩码，文件不立即删除，每次采集覆盖，模块断电后由 tmpfs 清空；不写入模块持久分区。原始 DIAG 日志上限为 2 MiB。

## 验证与来源

历史浏览器测试已移除。npm test 运行主机网络、适配规则缓存和LuCI错误分类的快速检查；其他单元测试及 tools/check-router-*.ts 保留为手动检查，不进入默认测试流程。tools/check-read-queue.ts 在路由器独立 /tmp 目录使用模拟工作进程验证并发去重、手动读取优先、失败释放锁和进程中断恢复，不接触Modem。tools/check-data-control.ts 使用模拟 AT/netifd 确认 wwan 上线即可完成开关，不影响真实连接。类型检查及构建按需执行，真实公网 IPv6 仍需支持 IPv6 的 SIM 实网核对。

配置参考移远官方 RG50xQ/RM5xxQ AT Manual V1.2：https://www.quectel.com/content/uploads/2024/02/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf 。R11为起点，已结合 RM500QGLABR13A03M4G 实际格式修订。NR QNWLOCK 为 PCI,ARFCN,SCS,Band，写后回读判断；不改变用户的 save_ctrl=0,0。

源码继承 project-cpe 的 GPL-3.0-only 许可，保留作者 1orz / xXiaoXiang 的声明；APN XML 保留 AOSP 原许可。参考实现包括 4IceG/luci-app-3ginfo-lite、4IceG/luci-app-modemband 和 obsy/modemband，相关来源与查阅版本保留在 docs/status-guide.ts。厂商 PDF 和设备日志不随仓库分发。
`
