# Prompt Safety Net

一个 Tampermonkey 用户脚本，用于在 ChatGPT 网页中保护文字 Prompt：自动保存未发送草稿、归档已提交的 Prompt，并在网络离线或回复长期没有进展时提醒。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 在 Tampermonkey 中新建脚本。
3. 将 [`chatgpt_prompt_safety_net.js`](./chatgpt_prompt_safety_net.js) 的完整内容粘贴并保存。
4. 打开 `https://chatgpt.com/`，右下角会出现“Prompt 安全网”。

## 功能

- 输入时自动保存当前会话的未发送草稿；刷新页面后可自动恢复。
- 在发送、点击发送按钮或表单提交时备份 Prompt，并保存最近 30 条历史记录。
- 支持将最近一次或历史 Prompt 恢复到输入框、复制到剪贴板。
- 浏览器离线时提示；发送后约两分钟没有可见回复进展时提示可能卡住。

## 数据与限制

- 数据仅保存在 Tampermonkey 的本地脚本存储中，不会上传到外部服务。
- 只备份文字 Prompt；附件和图片不会被保存。
- ChatGPT 页面结构可能变化；如输入框或发送按钮选择器失效，需要更新脚本适配。

## 文档

使用说明、设计记录和变更日志维护在独立文档仓库：[prompt-safety-net-docs](https://github.com/Matrixqlc/prompt-safety-net-docs)。
