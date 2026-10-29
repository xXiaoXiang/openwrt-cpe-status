# OpenWrt CPE Status

面向 OpenWrt / ImmortalWrt 的蜂窝网络管理 LuCI 插件，将 Modem 状态、频段与小区设置、运营商与 APN、AT 控制台和短信整合到一个界面。

前端采用 React + TypeScript，路由器端使用 ucode、rpcd 和 netifd，**无需安装 Node.js**。AT 命令和数据提取规则按模块配置，便于扩展其他型号。

[下载发布包](https://github.com/xXiaoXiang/openwrt-cpe-status/releases/latest) · [开发与配置说明](DEV.md) · [反馈问题](https://github.com/xXiaoXiang/openwrt-cpe-status/issues)

## 功能

LuCI 入口：**Modem → CPE Status**。

| 页面 | 功能 |
| --- | --- |
| 状态 | 运营商、注册与漫游状态、LTE / 5G NSA / SA、信号、小区与载波聚合、SIM 和设备信息、网速、模块温度；数据连接、漫游、飞行模式及网络模式控制 |
| 频段/小区 | LTE、5G SA、5G NSA 频段偏好；当前及邻区信息、手动全网扫描；按频点与 PCI 锁定、回读状态及解除锁定 |
| 运营商/APN | 当前运营商与选网模式、可用运营商扫描、手动或自动注册；多 APN 选择、按 ICCID 保存、全球数据库更新、重新拨号及拨号日志 |
| AT | 手动执行 AT 命令、常用快捷命令及模块支持的 IMEI 查询与修改 |
| 短信 | 短信读取、发送、未读角标、去重归档及手动清理已归档的已读短信 |
| eUICC | 已安装 lpac 且检测到有效 EID 后显示；Profile 切换、下载、删除、昵称和通知；通信模式/端口设置及 stdio HTTP/APDU bridge |
| 插件设置 | 原生 LuCI 服务控制、开机自启、短信保存目录与存储检测 |

界面适应桌面与手机，默认跟随 LuCI 深浅色模式，也可手动选择。“插件设置”页提供服务状态与启停、自启和重启控制。

### 减少重复查询

多个页面接口共享采集快照；SIM、设备身份和设置使用长期缓存，信号和小区按需更新。后台刷新期间继续显示上次成功结果，避免页面反复进入加载状态。适配规则由前端单独获取并缓存，仅在配置指纹变化后重新加载。

网速采用独立采样，展示接口可自定义。当前及邻区信息复用 5 秒缓存；全网小区和运营商扫描均需手动触发。

eUICC Profile 下载由后端独立执行，离开页面后仍会继续；下载期间暂停本插件的其他 Modem 查询，保留页面已有数据，结束后自动恢复。

### 自动 APN

内置 GNOME MBPI + AOSP 全球 APN 数据库，数据随源码及安装包提供，离线可用；根据 SIM 归属及 MVNO 信息匹配配置，支持用户扩展和按 SIM 覆盖。检测到模块及 SIM 后配置 APN，再启用对应数据接口。

每个 ICCID 可保存多套 APN，相同连接参数自动去重，并优先使用用户所选配置。页面区分个人修改与数据库来源，个人记录可原位二次确认删除，删除不改变当前连接。点击“检测 APN 数据库更新”可从 [openwrt-apn-autoconfig](https://darthanwalt.github.io/openwrt-apn-autoconfig/providers/providers.tsv) 更新 GNOME MBPI + AOSP 全球数据；手动修改过的数据库会被保留，更新不触发重拨。

**自动管理仅作用于已存在的 `wwan` QMI / MBIM 接口**，不接管 `br-lan`、`wan` 或其他接口。可在配置中关闭自动 APN 管理。

### 可选的 QCI 与上下行速率配置

对支持的 RM500Q 固件，可通过模块 ADB 获取 LTE / NSA 数据承载的 QCI 和网络下发的上下行 APN-AMBR。结果按 ICCID 关联，修改 APN 或拨号失败不清除同一张卡的已有结果；USB 重连或切换 Profile 时重新准备采集。该速率配置不是实测网速，也不等同于 5G SA 的 5QI。

需要自行启用模块 ADB，固件内须具备所需诊断工具。采集器只使用模块临时目录，不修改模块的持久文件或启动项，也不会自动切换飞行模式；不具备该能力时，其他功能仍可使用。详见 [开发说明](DEV.md#可选的-adb-qos-采集)。

## 支持情况

当前版本：**1.3.0（v1.3.0）**，对应软件包 **1.3.0-r1**。

| 项目 | 已验证环境 |
| --- | --- |
| 系统 | ImmortalWrt 25.12.2 |
| 构建 | 对应 SDK，APK 软件包，aarch64_cortex-a53 / x86_64 |
| Modem | Quectel RM500Q-GL，固件 RM500QGLABR13A03M4G |
| 接入 | USB AT 串口，QMI / MBIM 数据接口 |

默认适配以 RM500Q 系列官方 AT 文档为基础，并根据实机返回格式修订。其他 OpenWrt 版本、架构、模块及固件需使用匹配的 SDK 与适配配置验证；锁频、锁小区、温度、短信和诊断能力以模块实际支持为准。可选安装支持模块的 `lpac`，成功识别 eUICC 后自动显示管理页面，无需设置 LPAC 环境变量。

发布包按架构命名：`*-aarch64_cortex-a53.apk` 用于对应 ARM 路由器，`*-x86_64.apk` 用于 x86/64。ARM 包已实机验证；x86_64 包完成 SDK 打包与包元数据检查，尚未进行 x86 路由器实机验证。

## 安装与开始使用

1. 从 [Releases](https://github.com/xXiaoXiang/openwrt-cpe-status/releases) 下载适合系统与架构的软件包。
2. 将 APK 上传到路由器，在支持 APK 的系统上安装：

   ```sh
   apk add --allow-untrusted /tmp/luci-app-cpe-status-1.3.0-r1-aarch64_cortex-a53.apk
   ```

3. 检查 `/etc/cpe-status/config.json`：将 `device` 设置为模块的专用 AT 串口，默认 `/dev/ttyUSB2`；数据接口名称默认 `wwan`，自动 APN 只管理这一接口。
4. 在 LuCI 打开 **Modem → CPE Status**。修改配置后可在页面顶部重启插件服务。

x86/64 设备请安装同版本的 `luci-app-cpe-status-1.3.0-r1-x86_64.apk`，不要混用架构。

同一发布页提供可选的 `lpac-2.3.0_p9-r2-<架构>.apk`，支持原生 curl / HTTPS 和 stdio，以及 AT、QMI、UQMI、MBIM 卡片通信后端。该构建基于 [fildunsky/lpac-build](https://github.com/fildunsky/lpac-build/tree/v2.3.0-r4)，附带对应源码及启用 curl 的构建配置；安装时由软件包管理器处理 libcurl、CA 等依赖。已有 lpac 配置升级后会保留，可在 eUICC 卡片通信设置中选择 HTTP 方法。

安装依赖 LuCI、rpcd-mod-file、ucode、sms-tool、comgt 和 adb 等组件，由软件包管理器处理。APK 不能直接安装到使用 opkg / IPK 的旧系统；请使用对应 SDK 自行构建。

## 配置与数据

| 路径 | 用途 |
| --- | --- |
| `/etc/cpe-status/config.json` | AT 端口、数据接口、自动 APN、短信目录等主配置 |
| `/etc/cpe-status/modem.d/*.conf` | 按 USB VID / PID 匹配的模块 AT 命令与解析规则 |
| `/etc/cpe-status/apns.local.json` | 可编辑的用户 APN 扩展，优先于内置数据库 |
| `/etc/cpe-status/apn-overrides.json` | 每个 ICCID 的当前选择与 `custom_apn` 历史记录 |
| `/etc/cpe-status/dualstack_toone.json` | 按归属运营商及 APN 共享的 IPv4 协议回退规则，优先保留用户自定义协议 |
| `/etc/cpe-status/apn-database.json` | 在线更新的全球 APN 数据库，升级保留 |
| `/etc/cpe-status/sms` | 默认短信历史目录，可在“插件设置”页改为挂载磁盘路径 |
| `/tmp/cpe-status` | 运行缓存与任务结果，路由器重启后清空 |

后端程序统一放在 `/usr/libexec/cpe-status/`。升级会把旧主配置迁移到 `/etc/cpe-status/config.json`，备份保存在 `/etc/cpe-status/legacy/`，并保留 APN、eUICC 和短信等已有自定义数据。

模块配置使用带说明字段的 JSON。例如 RM500Q-GL 的配置为 [modem.d/2c7c0800.conf](modem.d/2c7c0800.conf)，安装到同名路径。现有规则支持的功能可通过新增配置适配；新的私有协议或诊断能力仍需扩展通用驱动。配置字段、输出格式、缓存周期和 APN 匹配规则见 [DEV.md](DEV.md)。

## 从源码构建

开发机需要 Node.js 24+；路由器运行时不需要。

```sh
npm install
npm run check
npm test
npm run build
```

将生成的 `build/openwrt-status-package` 复制到对应 OpenWrt / ImmortalWrt SDK 的 `package/luci-app-cpe-status`，然后执行：

```sh
make package/luci-app-cpe-status/compile V=s
```

构建与适配细节、运行架构和手动检查工具见 [DEV.md](DEV.md)。历史独立版本保留在 [v0.3.0](https://github.com/xXiaoXiang/openwrt-cpe-status/tree/v0.3.0)。

## 致谢与许可

本项目由 UDX710 管理项目的界面与功能移植、演进而来，保留 1orz / xXiaoXiang 的作者声明。参考了 [luci-app-3ginfo-lite](https://github.com/4IceG/luci-app-3ginfo-lite)、[luci-app-modemband](https://github.com/4IceG/luci-app-modemband)、[modemband](https://github.com/obsy/modemband) 和 [luci-app-5gmodem](https://github.com/fildunsky/luci-app-5gmodem)，模块适配依据移远官方 AT 文档及实机验证。可选 lpac 构建来自 [fildunsky/lpac-build](https://github.com/fildunsky/lpac-build) 与其 [lpac 分支](https://github.com/fildunsky/lpac)，保留上游许可。

代码使用 [GPL-3.0-only](LICENSE) 许可；内置与在线 APN 数据保留 AOSP Apache-2.0 与 GNOME MBPI CC-PDDC 声明，原始 AOSP XML 保留其许可。
