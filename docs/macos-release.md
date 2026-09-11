# macOS 发布

安装包由 `.github/workflows/build-macos.yml` 在 GitHub 的 macOS runner 上构建，产物为 Intel / Apple Silicon 通用 DMG。无需在 Windows 本地交叉打包。

## 发布新版本

1. 更新 `package.json` 和 `package-lock.json` 的版本，提交并推送代码。
2. 创建同版本的轻量标签，例如 `git tag v1.5.0-beta.3`，再推送该标签。
3. Workflow 自动安装依赖、测试、打包、检查打包后的运行时和视频解码，然后上传并发布 GitHub Release。

带 `-beta` 等后缀的版本发布为预发布。发布前可先创建该标签的草稿 Release 并填写更新说明；自动发布会保留这些说明。版本标签必须与 `package.json` 一致，不要移动已发布标签。

## 不重复构建

- 同一版本再次分发：直接使用 Release 中原有的 DMG 下载地址。
- 构建成功但发布失败：在 Actions 只重跑失败的发布任务，无需重跑构建。
- 需要从其他成功运行中恢复发布：手动运行 Build macOS，填写 `publish_run_id` 和 `publish_tag`。目标必须是同一提交的轻量标签和草稿 Release；流程会检查来源并直接转移已有 DMG。
- 新代码需要新安装包：推送新版本标签。npm、Electron 和打包工具的下载使用缓存，但仍重新运行测试并打包，避免复用过时源码。

Actions 构建产物受仓库保留期限约束；已发布的 Release 安装包可持续下载。当前安装包未使用 Apple Developer 身份签名和公证，首次安装仍可能遇到 macOS 的来源验证提示。
