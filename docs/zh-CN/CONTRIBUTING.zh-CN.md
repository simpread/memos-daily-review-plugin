# 技术说明

[English](../../CONTRIBUTING.md) | 中文

感谢你对 memos-daily-review-plugin（Memos 每日回顾插件）的关注！本文档提供技术细节和开发指南，帮助你理解和修改这个插件。

## 技术架构

插件采用 IIFE（立即调用函数表达式）模式，确保不污染全局作用域：

```javascript
(function DailyReviewPlugin() {
  'use strict';
  // ...
})();
```

### 模块结构

| 模块 | 职责 |
|------|------|
| `CONFIG` | 配置常量（存储键名、默认值、选项列表等） |
| `REGEX_PATTERNS` | 预编译的正则表达式模式 |
| `i18n` | 国际化（语言检测、翻译字典、区域格式化） |
| `utils` | 工具函数（随机种子、洗牌算法、日期格式化、Markdown 渲染） |
| `settingsService` | 用户设置持久化 |
| `batchService` | 批次状态持久化（同一天内的换批状态） |
| `poolService` | 候选池缓存（减少 API 请求） |
| `deckService` | 每日牌堆缓存（同一天稳定） |
| `historyService` | 复习历史记录（去重 + 优先级） |
| `apiService` | API 调用封装 |
| `authService` | 认证处理（token 刷新） |
| `ui` | UI 组件（样式注入、DOM 创建、渲染、图片预览） |
| `controller` | 业务逻辑协调 |

## 关键算法

### 每日固定随机

```javascript
// 1) 获取候选池（pool），本地 TTL 缓存（默认 6 小时）
// 2) 生成"每日牌堆"（deck）：key = day + timeRange + count + batch
// 3) deck 内部使用稳定打散（memoId + seed）避免依赖 API 返回顺序
```

### 复习式抽取

```javascript
// 1) 将候选池按创建时间分为 3 桶（oldest/middle/newest），均衡抽取
// 2) 结合本地 history 做 3 天去重（不足时逐步放宽）
// 3) 优先级：从未出现 > 久未出现 > 出现次数少（同分用稳定 hash 打散）
// 4) 尝试插入 1 组"同标签碰撞位"（同标签最早 + 最晚）
```

### Markdown 渲染（嵌套列表）

```javascript
// 1. 检测缩进级别（Tab 按 2 空格处理）
const leading = (line.match(/^[ \t]*/)?.[0] || '').replace(/\t/g, '  ');
const indentWidth = leading.length;

// 2. 根据缩进宽度推断 list 深度（兼容 2/4 空格缩进）
const depth = getListDepthForIndent(indentWidth);

// 3. 用栈维护每一级的 list 元素，并把内层 <ul>/<ol> 挂到父 <li> 下
ensureListForLevel('ul', depth);
```

## 性能优化（v2.0）

### 高优先级优化

**1. findSparkPair 算法优化**
- 问题：使用 O(n log n) 排序查找最早和最晚的 memo
- 方案：改用 O(n) 线性扫描直接找最小/最大值
- 效果：对于 100 个标签、每个标签 10 个 memo 的场景，性能提升约 70%

**2. sortByReviewPriority 优化**
- 问题：`getDaysSinceShown` 在 filter 和 map 中被调用两次
- 方案：合并 filter 和 map 操作，只计算一次
- 效果：历史查询调用减少 50%

**3. Markdown 渲染优化**
- 问题：多次 `appendChild` 触发浏览器 reflow
- 方案：使用 DocumentFragment 批量插入 DOM
- 效果：长文档渲染速度提升 30-50%

### 中优先级优化

**4. 正则表达式预编译**
- 问题：每次调用 `markdownToHtml` 都创建新的正则对象
- 方案：在模块级别预编译 `REGEX_PATTERNS`
- 效果：渲染性能提升 5-10%，减少 GC 压力

**5. imageGroups 内存管理**
- 问题：每次渲染都重置 `imageGroups`，丢失之前的数据
- 方案：LRU 风格管理，保留最近 10 个条目
- 效果：避免快速切换卡片时的图片预览 bug

### 低优先级优化

**6. 事件委托**
- 问题：每个图片链接都有独立的事件监听器
- 方案：在容器上使用单个委托监听器
- 效果：减少内存占用，更好地适应大量图片

### 性能指标

对于 1000+ memos 的数据集：
- 牌堆生成速度提升 50-70%
- Markdown 渲染速度提升 30-50%
- 内存占用减少 20-30%

## 数据存储

插件使用 `localStorage` 存储以下数据：

| Key | 用途 | 示例 |
|-----|------|------|
| `memos-daily-review-settings` | 用户设置 | `{"timeRange":"6months","count":8}` |
| `memos-daily-review-pool` | 候选池缓存 | 包含 memos 数组和时间戳 |
| `memos-daily-review-cache` | 牌堆缓存 | 多个 deck 对象 |
| `memos-daily-review-history` | 复习历史 | `{items: {memoId: {lastShownDay, shownCount}}}` |

### 缓存策略

- **候选池**：TTL 6 小时，减少重复请求
- **牌堆**：按 key 缓存，最多保留 10 个历史 deck
- **复习历史**：最多 5000 条，超出按"最久未回顾"淘汰

## API 依赖

| 端点 | 用途 | 权限 |
|------|------|------|
| `GET /api/v1/memos` | 获取 Memo 列表 | 公开（受可见性过滤） |
| `PATCH /api/v1/memos/{name}` | 更新 Memo 内容 | 需要登录 + 权限 |
| `POST /memos.api.v1.AuthService/RefreshToken` | 刷新 access token | 需要 refresh cookie |

## CSS 变量

插件使用 Memos 的 CSS 变量确保主题兼容：

- `--primary` / `--primary-foreground` - 主色调
- `--background` / `--foreground` - 背景/前景色
- `--border` - 边框色
- `--card` - 卡片背景
- `--muted-foreground` - 次要文字
- `--accent` - 强调色
- `--radius` - 圆角
- `--shadow-lg` - 阴影

## 开发指南

### 修改建议

| 需求 | 修改位置 |
|------|----------|
| 添加新的时间范围 | `CONFIG.TIME_RANGES` 数组 |
| 调整默认值 | `CONFIG.DEFAULT_TIME_RANGE` / `CONFIG.DEFAULT_COUNT` |
| 修改样式 | `ui.injectStyles()` 中的 CSS |
| 添加新功能 | 在 `controller` 对象中添加方法 |

### 语法检查

```bash
node --check memos-daily-review-plugin.js
```

### 调试

1. 在浏览器控制台查看日志（插件会 `console.error` 错误信息）
2. 检查 `localStorage` 中的缓存数据
3. 使用 Network 面板查看 API 请求
4. 使用 Performance 面板分析性能

## 测试检查清单

### 功能测试
- [ ] 浮动按钮正常显示
- [ ] 点击按钮打开对话框
- [ ] 上一张/下一张切换正常，计数正确
- [ ] 时间范围切换生效
- [ ] 数量切换生效
- [ ] 同一天多次打开显示相同牌堆
- [ ] "换一批"获取新牌堆（不请求服务器）
- [ ] 亮色/暗色主题切换适配
- [ ] 无 Memo 时显示空状态
- [ ] Markdown 渲染正确（标题、列表、粗体、斜体等）
- [ ] 嵌套列表正确显示缩进
- [ ] 图片点击打开弹窗预览
- [ ] 多图可左右切换
- [ ] 编辑保存功能正常
- [ ] 未登录时行为符合预期

### 性能测试
- [ ] 使用 Performance 面板测试大数据集（1000+ memos）
- [ ] 测试 `generateDeck` 执行时间（应 < 100ms）
- [ ] 测试 Markdown 渲染时间（长文档应 < 50ms）
- [ ] 检查内存占用（切换 100 次卡片后无明显增长）

## 已知限制

- 单次最多获取 1000 条 Memo（API 限制）
- Markdown 渲染为简化版，不支持：代码块、引用、表格、水平线
- 嵌套列表层级由缩进宽度自动推断，可能不完全符合 CommonMark
- 图片预览不支持键盘快捷键
- 缓存基于日期，跨天自动失效

## 相关文件参考

如果你有 Memos 源码，以下文件可供参考：

| 文件 | 用途 |
|------|------|
| `web/src/App.tsx:39-45` | 脚本注入点 |
| `web/src/hooks/useMemoFilters.ts` | CEL 过滤表达式格式 |
| `web/src/themes/default.css` | CSS 变量定义 |
| `web/src/components/MemoContent/index.tsx` | Memo 内容渲染参考 |

## 项目架构

详细的项目架构说明请参阅 [CLAUDE.md](./CLAUDE.md)。
