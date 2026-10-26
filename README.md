# OpenWrt CPE Status

LuCI → Modem → CPE Status：**仪表盘、频段与小区设置、运营商与APN设置、AT控制台、短信**。浏览器运行 React；路由器使用 ucode / rpcd / netifd，无需 Node.js。ImmortalWrt 25.12.2 已完成 SDK APK 构建及 RM500Q-GL R13 实机读取验证。

公开仓库：https://github.com/xXiaoXiang/openwrt-cpe-status 。首次独立发布 v0.3.0 / 0.3.0-r0；配置驱动架构 v1.0.0 / 1.0.0-r0。软件包版本取自 project.ts。历史界面和行为基线可查看 v0.3.0 标签。

## 构建

开发环境 Node.js 24+：

```sh
node --experimental-transform-types tools/bootstrap.ts
npm install
npm run check
npm test
npm run build
```

将 build/openwrt-status-package 复制到 OpenWrt / ImmortalWrt SDK 的 package/luci-app-cpe-status，执行 make package/luci-app-cpe-status/compile V=s。包依赖 luci-base、rpcd-mod-file、ucode、ucode-mod-fs、ucode-mod-ubus、sms-tool、comgt，以及系统自带的 BusyBox sha256sum。build/openwrt-package 是保留的早期 Node 原型，不是当前推荐安装包。

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

```json
{"apns":[{"carrier":"示例运营商","mcc":"454","mnc":"00","apn":"internet","protocol":"IPV4V6"}]}
```

支持 user/password/authtype 及 mvno_type/mvno_match_data。匹配使用 IMSI、ICCID、EF_AD 的归属 MNC 长度及 SPN/GID，不以漫游地 PLMN 代替 SIM 归属。修改扩展库后后台在下一次 SIM 核对时重新匹配；无法唯一匹配时不擅自拨号。

自动 APN 服务 /etc/init.d/cpe-status 在开机网络服务前准备配置，**只管理已存在的 wwan QMI/MBIM 接口**，不操作 br-lan、wan 或其他接口。原配置备份到 /etc/cpe-status/wwan-original.json；将 wwan.auto 置0，模块消失时停止 wwan，SIM/APN 配置并回读成功后再 ifup wwan。可设 autoApn=false 停用，之后按需要自行恢复 wwan.auto。更改 APN 时只重拨 wwan，保留 modes/plmn 与小区锁定设置。

/etc/cpe-status.json、模块配置和本地 APN 扩展声明为升级配置；短信和各 SIM 覆盖记录不由包覆盖，系统升级也需保留 /etc/cpe-status/。挂载磁盘的短信历史应自行备份。

## 验证与来源

本地单元测试检查解析、单位、缓存、控制确认、短信编解码等。tests/browser.smoke.ts 运行生成的 LuCI 视图和浏览器模拟 RPC；tools/check-modem-profiles.ts 在真实路由器 /tmp 中对照 ucode/TypeScript 解析并验证只改配置即更换命令和规则。tools/check-router-*.ts 中隔离控制测试使用模拟 AT/UCI/netifd，不应将其通过解释为每个真实锁定或短信发送操作都做过实机验证。真实读取仍应在目标硬件核对，禁止发送测试短信或盲目改 IMEI。

配置参考移远官方 RG50xQ/RM5xxQ AT Manual V1.2：https://www.quectel.com/content/uploads/2024/02/Quectel_RG50xQRM5xxQ_Series_AT_Commands_Manual_V1.2.pdf 。R11为起点，已结合 RM500QGLABR13A03M4G 实际格式修订。NR QNWLOCK 为 PCI,ARFCN,SCS,Band，写后回读判断；不改变用户的 save_ctrl=0,0。

源码继承 project-cpe 的 GPL-3.0-only 许可，保留作者 1orz / xXiaoXiang 的声明；APN XML 保留 AOSP 原许可。参考实现包括 4IceG/luci-app-3ginfo-lite、4IceG/luci-app-modemband 和 obsy/modemband，相关来源与查阅版本保留在 docs/status-guide.ts。厂商 PDF 和设备日志不随仓库分发。
