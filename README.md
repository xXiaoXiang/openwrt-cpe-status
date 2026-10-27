# OpenWrt CPE Status

面向 OpenWrt / ImmortalWrt 的蜂窝网络管理 LuCI 插件，将 Modem 状态、频段与小区设置、运营商与 APN、AT 控制台和短信整合到一个界面。

前端采用 React + TypeScript，路由器端使用 ucode、rpcd 和 netifd，**无需安装 Node.js**。AT 命令和数据提取规则按模块配置，便于扩展其他型号。

[下载发布包](https://github.com/xXiaoXiang/openwrt-cpe-status/releases/latest) · [开发与配置说明](DEV.md) · [反馈问题](https://github.com/xXiaoXiang/openwrt-cpe-status/issues)

## 功能

LuCI 入口：**Modem → CPE Status**。

| 页面 | 功能 |
| --- | --- |
| 仪表盘 | 运营商、注册与漫游状态、LTE / 5G NSA / SA、信号、小区与载波聚合、SIM 和设备信息、网速、模块温度；数据连接、漫游、飞行模式及网络模式控制 |
| 频段与小区设置 | LTE、5G SA、5G NSA 频段偏好；当前及邻区信息、手动全网扫描；按频点与 PCI 锁定、回读状态及解除锁定 |
| 运营商与 APN 设置 | 当前运营商与选网模式、可用运营商扫描、手动或自动注册；APN 编辑、按 SIM 保存、重新拨号及拨号日志 |
| AT 控制台 | 手动执行 AT 命令、常用快捷命令及模块支持的 IMEI 查询与修改 |
| 短信 | 短信读取、发送、会话浏览和本地历史归档，支持自定义持久存储目录 |

界面适应桌面与手机，默认跟随 LuCI 深浅色模式，也可手动选择。顶部提供服务状态与启停、自启和重启控制。

### 减少重复查询

多个页面接口共享采集快照；SIM、设备身份和设置使用长期缓存，信号和小区按需更新。后台刷新期间继续显示上次成功结果，避免页面反复进入加载状态。适配规则由前端单独获取并缓存，仅在配置指纹变化后重新加载。

网速采用独立采样，展示接口可自定义。当前及邻区信息复用 5 秒缓存；全网小区和运营商扫描均需手动触发。

### 自动 APN

内置 APN 数据库，根据 SIM 归属及 MVNO 信息匹配配置，支持用户扩展和按 SIM 覆盖。检测到模块及 SIM 后配置 APN，再启用对应数据接口。

**自动管理仅作用于已存在的 `wwan` QMI / MBIM 接口**，不接管 `br-lan`、`wan` 或其他接口。可在配置中关闭自动 APN 管理。

### 可选的 QCI 与上下行速率配置

对支持的 RM500Q 固件，可通过模块 ADB 获取 LTE / NSA 数据承载的 QCI 和网络下发的上下行 APN-AMBR，并缓存到后续重新采集。该速率配置不是实测网速，也不等同于 5G SA 的 5QI。

需要自行启用模块 ADB，固件内须具备所需诊断工具。采集器只使用模块临时目录，不修改模块的持久文件或启动项，也不会自动切换飞行模式；不具备该能力时，其他功能仍可使用。详见 [开发说明](DEV.md#可选的-adb-qos-采集)。

## 支持情况

当前版本：**1.1（v1.1.0）**，对应软件包 **1.1.0-r6**。

| 项目 | 已验证环境 |
| --- | --- |
| 系统 | ImmortalWrt 25.12.2 |
| 构建 | 对应 SDK，APK 软件包，aarch64_cortex-a53 |
| Modem | Quectel RM500Q-GL，固件 RM500QGLABR13A03M4G |
| 接入 | USB AT 串口，QMI / MBIM 数据接口 |

默认适配以 RM500Q 系列官方 AT 文档为基础，并根据实机返回格式修订。其他 OpenWrt 版本、架构、模块及固件需使用匹配的 SDK 与适配配置验证；锁频、锁小区、温度、短信和诊断能力以模块实际支持为准。当前未启用 eUICC 管理。

## 安装与开始使用

1. 从 [Releases](https://github.com/xXiaoXiang/openwrt-cpe-status/releases) 下载适合系统与架构的软件包。
2. 将 APK 上传到路由器，在支持 APK 的系统上安装：

   ```sh
   apk add --allow-untrusted /tmp/luci-app-cpe-status-1.1.0-r6.apk
   ```

3. 检查 `/etc/cpe-status.json`：将 `device` 设置为模块的专用 AT 串口，默认 `/dev/ttyUSB2`；数据接口名称默认 `wwan`，自动 APN 只管理这一接口。
4. 在 LuCI 打开 **Modem → CPE Status**。修改配置后可在页面顶部重启插件服务。

安装依赖 LuCI、rpcd-mod-file、ucode、sms-tool、comgt 和 adb 等组件，由软件包管理器处理。APK 不能直接安装到使用 opkg / IPK 的旧系统；请使用对应 SDK 自行构建。

## 配置与数据

| 路径 | 用途 |
| --- | --- |
| `/etc/cpe-status.json` | AT 端口、数据接口、自动 APN、短信目录等主配置 |
| `/etc/cpe-status/modem.d/*.conf` | 按 USB VID / PID 匹配的模块 AT 命令与解析规则 |
| `/etc/cpe-status/apns.local.json` | 可编辑的用户 APN 扩展，优先于内置数据库 |
| `/etc/cpe-status/apn-overrides.json` | 页面保存的各 SIM APN 设置 |
| `/etc/cpe-status/sms` | 默认短信历史目录，可在短信页改为挂载磁盘路径 |
| `/tmp/cpe-status` | 运行缓存与任务结果，路由器重启后清空 |

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

本项目由 UDX710 管理项目的界面与功能移植、演进而来，保留 1orz / xXiaoXiang 的作者声明。参考了 [luci-app-3ginfo-lite](https://github.com/4IceG/luci-app-3ginfo-lite)、[luci-app-modemband](https://github.com/4IceG/luci-app-modemband) 和 [modemband](https://github.com/obsy/modemband)，模块适配依据移远官方 AT 文档及实机验证。

代码使用 [GPL-3.0-only](LICENSE) 许可；APN 数据保留其 AOSP 来源与原许可。
