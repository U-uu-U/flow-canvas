# Flow Canvas 素材采集与任务同步

插件同时提供网页素材采集、Flow Canvas 素材库导入、视频任务同步和下载归档。

## 安装

1. 打开 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择当前 `flow-canvas-sync` 文件夹。
3. 复制扩展 ID。Windows 运行 `install.bat <扩展ID>`；macOS 运行 `bash install-macos.sh <扩展ID>`。
4. 在扩展管理页重新加载插件。
5. 保持 RavenHash 页面处于登录状态，打开插件弹窗确认“已连接 Flow Canvas 本地服务”。

修改插件源码或升级版本后，需要在 `chrome://extensions` 中点击一次“重新加载”。Native Host 的扩展 ID 没变时不需要重复安装。

## 网页素材采集

1. 打开 Flow Canvas。插件默认写入应用管理的素材库目录，也可以在素材库浮层中关联其他本地目录。
2. 点击插件图标，再点击“网页素材采集”打开 Chrome 侧边栏。
3. 在目标网页点击“扫描当前页面”，选择图片、视频或音频。
4. 选择素材分类和保存目录，点击“导入所选”。

扫描覆盖普通图片、`srcset`、CSS 背景图、开放 Shadow DOM、跨 iframe、SVG image、canvas、video/audio/source，以及网络请求中出现的直接媒体地址。HLS/DASH 流媒体清单会显示，但不会作为普通文件直接导入。

每个导入文件旁会生成同名 `.flow-asset.json`，记录来源页面、分类和标签。主分类固定为“角色、场景、道具、风格、音效、Others”。启用“导入后由 Flow Canvas 智能分类”时，桌面端会复用已配置的 GPT/Claude 视觉模型补全分类，不会在插件中保存第二套 API Key。

## 工作方式

- 页面适配器使用页面已有登录令牌读取 `/api/v1/task_logs`，令牌不会发送给扩展后台或 Flow Canvas。
- 新视频任务完成后自动调用 Chrome 下载。
- Native Host 读取 Flow Canvas 写入的远端任务路由，将文件复制到任务创建时的目标目录，校验大小后删除 Downloads 中的原文件。
- 同步事件写入 Flow Canvas 数据目录，由任务记录侧栏自动合并。
- 网页素材只允许写入当前 `board.json` 已登记的素材库目录，插件不能借此写入任意系统路径。

默认不会自动下载安装前已经存在的历史任务。可在插件弹窗中开启“下载已有历史任务”。
