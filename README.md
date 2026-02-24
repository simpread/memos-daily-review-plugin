# Memos Daily Review Plugin

<div align="center">

English | [中文](./docs/zh-CN/README.zh-CN.md)

A "Daily Review" frontend plugin for [usememos/memos](https://github.com/usememos/memos)

Automatically recommends a few past memos each day to help you review and spark new ideas

</div>

---

## Preview

<div align="center">
  <img src="./assets/demo.gif" alt="Plugin Demo" width="800"/>
</div>

---

## Core Features

- **One-Click Review** - Review memos from the past month up to all-time
- **Daily Variety** - What you see today changes tomorrow
- **Smart Recommendations** - The longer you haven't seen it, the more likely it appears
- **Smooth Animations** - Polished UI with fade, slide, and loading transitions
- **Mobile Optimized** - Responsive design adapts to all screen sizes
- **Version Compatibility** - Auto-adapts to API differences across Memos versions
- **Keyboard Shortcuts** - Navigate with arrow keys, Esc to close, Ctrl+Enter to save

---

## Quick Start

1. Open Memos: `Settings → System → Additional Script`
2. Copy the entire content of [`memos-daily-review-plugin.js`](./memos-daily-review-plugin.js) and paste
3. Save and refresh, the "Daily Review" button will appear in the bottom-right corner

---

## Compatibility

- **Tested baseline**: Memos `v0.25.3`
- **Forward-compatible target**: Memos `v0.26.x+`
- **Adaptive API strategy**:
  - Auto-detects available auth/session endpoints
  - Falls back between `updateMask` and `update_mask` styles
  - Falls back when `filter` or `orderBy` query params are rejected
  - Supports both `nextPageToken` and `next_page_token` response fields
- **Cache key**: `memos-daily-review-capabilities` in `localStorage` (auto-refreshed with TTL)

---

## Performance

Benchmarks for datasets with 1000+ memos:
- **Deck generation**: < 100ms
- **Markdown rendering** (long documents): < 50ms
- **Memory usage**: Stable after 100+ card switches
- **Pool fetch**: Early-stop with 4s time budget, adaptive sizing

---

## FAQ

<details>
<summary><b>Empty when opened?</b></summary>

Check login status, or adjust time range to "All"
</details>

---

## Documentation

- [Changelog](./CHANGELOG.md)
- [Development Guide (English)](./CONTRIBUTING.md)
- [开发指南（中文）](./docs/zh-CN/CONTRIBUTING.zh-CN.md)
- [AI Development Reference](./CLAUDE.md)

---

## License

MIT License

---

<div align="center">

Made with ❤️ and 🤖

</div>
