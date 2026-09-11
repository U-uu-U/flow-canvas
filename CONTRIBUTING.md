# 协作与版本管理

## 分支约定

- `master` 是稳定代码入口。日常开发不直接推送到这里，通过 Pull Request 合并已检查的改动。
- `dev` 是下一版的开发分支，由团队从整理后的最新 `master` 创建。开发完成不等于已经发布。
- 多人同时做独立功能时，从最新 `dev` 创建短期功能分支，完成后提 PR 到 `dev`；不要长期维护互不合并的开发分支。
- 已完整合并、没有其他用途的短期分支可以删除；删除分支不会删除已经合入的提交。未合并的工作、其他人的工作分支和本地未提交修改不要清理。

本次整理是一次性将现有最新代码汇总进 `master`，之后遵循上述流程。

## 日常操作

开始工作前，先查看工作区；有未提交修改时先处理它们，不要强制切换或覆盖。

```sh
git status
git switch dev
git pull --ff-only origin dev
```

完成一个明确的小改动后，检查差异、运行相应测试，只提交本次涉及的文件。

```sh
git diff
git add <本次修改的文件>
git diff --cached
git commit -m "fix: describe the change"
git push origin dev
```

如果推送提示远端有新提交，不要使用 `--force`。先获取远端改动并合并，处理冲突后重新测试再推送。不要直接把整个文件选成“我的”或“对方的”，以免丢掉另一方的修复。

## 合并与发布

1. 开发完成后创建 `dev` 到 `master` 的 PR，说明本次改动和验证结果。
2. 运行 `npm run check`，确认 GitHub 的 Lint、Unit tests、Build renderer 检查通过，并完成必要的人工功能检查。
3. 使用 merge commit 合并长期分支，保留共同历史；合并后把 `master` 同步回 `dev`。
4. 只有明确要求发布安装包时，才更新发布版本并推送对应 tag。Windows 和 macOS 安装包必须来自同一个提交。

`commit` 是保存本地代码记录，`push` 是上传到 GitHub，PR 是申请把一个分支合入另一个分支，Release 才是对外发布版本。

仅提交或合并代码，不代表已发布安装包。“先不要打包”时，不推送版本 tag，也不手动触发打包工作流。
