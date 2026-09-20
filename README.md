# Prompt Safety Net

一个 Tampermonkey 用户脚本，用于在 ChatGPT 网页中保护文字 Prompt：自动保存未发送草稿、归档已提交的 Prompt，并在网络离线或回复长期没有进展时提醒。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`chatgpt_prompt_safety_net.user.js`](./chatgpt_prompt_safety_net.user.js)。
3. 点击 GitHub 页面里的 **Raw**；Tampermonkey 会识别 `.user.js` 并打开安装界面。
4. 安装后打开 `https://chatgpt.com/`，右下角会出现“Prompt 安全网”。

## 自动更新

脚本已经配置 `@updateURL` 和 `@downloadURL`，指向本仓库 `main` 分支的 Raw 文件。后续发布新版本时，只要提高 userscript 头部的 `@version`，Tampermonkey 就可以检测并更新本地脚本。

> 自动更新依赖 Raw 文件可匿名访问，因此仓库需要保持为 Public。

## 功能

- 输入时自动保存当前会话的未发送草稿；刷新页面后可自动恢复。
- 在发送、点击发送按钮或表单提交时备份 Prompt，并保存最近 30 条历史记录。
- 历史 Prompt 会自动去重：同样的 Prompt 再次使用时不会新增重复记录，而是更新最近使用时间并累计“已使用 N 次”。
- 历史记录支持恢复、复制、单条删除和收藏；收藏项会优先显示，并在再次使用同一 Prompt 时保留收藏状态。
- 普通历史最多保留最近 200 条去重后的 Prompt；收藏项不参与这个上限，不会因为历史滚动而被自动淘汰。
- 历史记录每页显示 8 条，并提供“上一页 / 下一页”和当前页码。
- 对窄屏（≤ 640px）做专门布局适配：面板接近全宽、按钮压缩排布、Prompt 预览收紧、分页保持可见。
- 浏览器离线时提示；发送后约两分钟没有可见回复进展时提示可能卡住。

## 数据与限制

- 数据仅保存在 Tampermonkey 的本地脚本存储中，不会上传到外部服务。
- 只备份文字 Prompt；附件和图片不会被保存。
- ChatGPT 页面结构可能变化；如输入框或发送按钮选择器失效，需要更新脚本适配。

## 文档

使用说明、设计记录和变更日志维护在独立文档仓库：[prompt-safety-net-docs](https://github.com/Matrixqlc/prompt-safety-net-docs)。
