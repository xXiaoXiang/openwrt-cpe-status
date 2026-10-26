import { statusGuide } from './status-guide.ts'

export const guide = `# OpenWrt CPE Status

LuCI Modem → CPE Status：仪表盘、频段与小区设置、运营商与APN设置、AT控制台、短信。浏览器运行 React；路由器使用 ucode / rpcd / netifd，无需 Node.js。源码继承 project-cpe 的 GPL-3.0-only 许可。

## 构建

开发环境 Node.js 24+：

\`\`\`sh
node --experimental-transform-types tools/bootstrap.ts
npm install
npm run check
npm test
npm run build
\`\`\`

轻量软件包源码生成于 build/openwrt-status-package，复制到 OpenWrt / ImmortalWrt SDK 的 package/luci-app-cpe-status，执行 make package/luci-app-cpe-status/compile V=s。已在 ImmortalWrt 25.12.2 SDK 构建 APK。build/openwrt-package 是早期 Node 原型，不是推荐安装包。

静态网页安装目录：/www/luci-static/resources/cpe-status/。

## 配置与数据

- /etc/cpe-status.json：专用 AT 串口、wwan 接口、自动 APN 与短信存储路径。
- /usr/share/cpe-status/apns.json：运行时 APN 数据库，来源 data/apns-conf_8.xml，构建时转换；只修改安装后的 XML 不会更新运行时数据库。
- /etc/cpe-status/apn-overrides.json：网页保存的各 SIM 自定义 APN。
- /etc/cpe-status/sms：默认短信归档目录，可在短信页改为挂载磁盘路径。
- /tmp/cpe-status：运行缓存，重启清空。

自动 APN 服务只管理已存在的 wwan 接口，不操作 br-lan、wan 或其他网络。首次接管备份配置到 /etc/cpe-status/wwan-original.json。停用自动管理后需按实际情况恢复 wwan.auto。专用 AT 串口不能同时被其他 AT 应用占用。

公开仓库：https://github.com/xXiaoXiang/openwrt-cpe-status 。首个公开基线 v0.3.0 / 0.3.0-r0；保留此前开发记录如下，其版本号属于拆分前内部迭代记录。

` + statusGuide
