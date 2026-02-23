# Memos 每日回顾插件

<div align="center">

[English](../../README.md) | 中文

为 [usememos/memos](https://github.com/usememos/memos) 提供「每日回顾」功能的前端插件

每天自动推荐几条过去的 Memo，帮你回顾和产生新想法

</div>

---

## 预览

<div align="center">
  <img src="../../assets/demo.gif" alt="插件演示" width="800"/>
</div>

---

## 核心功能

- **一键回顾** - 可以回顾最近 1 个月到全部时间范围内的 Memo
- **每天不重样** - 今天看到的，明天就换了
- **智能推荐** - 越久没看的越容易出现
- **版本兼容** - 自动适配不同 Memos 版本的 API 差异
- **键盘快捷键** - 方向键切换卡片，Esc 关闭，Ctrl+Enter 保存

---

## 快速开始

1. 打开 Memos：`设置 → 系统 → 自定义脚本`
2. 复制 [`memos-daily-review-plugin.js`](../../memos-daily-review-plugin.js) 的全部内容并粘贴
3. 保存后刷新页面，右下角会出现「每日回顾」按钮

---

## 兼容性说明

- **已验证基线**：Memos `v0.25.3`
- **前向兼容目标**：Memos `v0.26.x+`
- **自适应 API 策略**：
  - 自动探测可用的 auth/session 端点
  - 自动回退 `updateMask` / `update_mask` 两种参数风格
  - 当 `filter` 或 `orderBy` 不被支持时自动降级
  - 同时兼容 `nextPageToken` 与 `next_page_token` 返回字段
- **能力缓存键**：`localStorage` 中的 `memos-daily-review-capabilities`（带 TTL 自动刷新）

---

## 性能指标

针对 1000+ 条 Memo 的数据集测试：
- **卡组生成**：< 100ms
- **Markdown 渲染**（长文档）：< 50ms
- **内存占用**：切换 100+ 张卡片后保持稳定
- **池获取**：4 秒时间预算早停，自适应大小

---

## 常见问题

<details>
<summary><b>打开后是空的？</b></summary>

检查登录状态，或调整时间范围为「全部」
</details>

---

## 文档

- [开发指南（中文）](./CONTRIBUTING.zh-CN.md)
- [Development Guide (English)](../../CONTRIBUTING.md)
- [AI 开发参考](../../CLAUDE.md)

---

## 许可证

MIT License

---

<div align="center">

Made with ❤️ and 🤖

</div>
