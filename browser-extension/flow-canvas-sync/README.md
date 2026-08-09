# Flow Download Manager + Task Sync

这是原 Flow Download Manager 的升级版：保留普通下载的自定义目录归档，并同步 `ai.ravenhash.org` 和 `art.ravenhash.org` 上的 TokensByte 兼容视频任务，自动下载成品并移动到任务发起时的 Flow Canvas 目标目录。

## 安装

1. 打开 `chrome://extensions`，启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择当前 `flow-canvas-sync` 文件夹。
3. 复制扩展 ID，运行 `install.bat <扩展ID>`；双击脚本时也可以按提示输入。
4. 在扩展管理页重新加载插件。
5. 保持 RavenHash 页面处于登录状态，打开插件弹窗确认“已连接 Flow Canvas 本地服务”。

## 工作方式

- 页面适配器使用页面已有登录令牌读取 `/api/v1/task_logs`，令牌不会发送给扩展后台或 Flow Canvas。
- 新视频任务完成后自动调用 Chrome 下载。
- Native Host 读取 Flow Canvas 写入的远端任务路由，将文件复制到任务创建时的目标目录，校验大小后删除 Downloads 中的原文件。
- 同步事件写入 Flow Canvas 数据目录，由任务记录侧栏自动合并。

默认不会自动下载安装前已经存在的历史任务。可在插件弹窗中开启“下载已有历史任务”。
