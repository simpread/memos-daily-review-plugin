# Technical Documentation

English | [中文](./CONTRIBUTING.md)

Thank you for your interest in memos-daily-review-plugin (Memos Daily Review Plugin)! This document provides technical details and development guidelines to help you understand and modify this plugin.

## Technical Architecture

The plugin uses an IIFE (Immediately Invoked Function Expression) pattern to avoid polluting the global scope:

```javascript
(function DailyReviewPlugin() {
  'use strict';
  // ...
})();
```

### Module Structure

| Module | Responsibility |
|--------|----------------|
| `CONFIG` | Configuration constants (storage keys, defaults, option lists) |
| `utils` | Utility functions (random seed, shuffle, date formatting, Markdown rendering) |
| `settingsService` | User settings persistence |
| `poolService` | Memo pool caching (reduces API requests) |
| `deckService` | Daily deck caching (stable within same day) |
| `historyService` | Review history (deduplication + priority) |
| `apiService` | API call wrapper |
| `authService` | Authentication handling (token refresh) |
| `ui` | UI components (style injection, DOM creation, rendering, image preview) |
| `controller` | Business logic coordination |

## Key Algorithms

### Daily Fixed Randomization

```javascript
// 1) Fetch memo pool, cache locally with TTL (default 6 hours)
// 2) Generate "daily deck": key = day + timeRange + count + batch
// 3) Deck uses stable shuffling (memoId + seed) to avoid dependency on API order
```

### Review-Style Selection

```javascript
// 1) Split pool into 3 buckets by creation time (oldest/middle/newest), balanced extraction
// 2) Apply 3-day deduplication using local history (relaxes if insufficient)
// 3) Priority: never seen > long unseen > low view count (tie-break with stable hash)
// 4) Try inserting 1 "spark pair" (earliest + latest memo sharing same tag)
```

### Markdown Rendering (Nested Lists)

```javascript
// 1. Detect indentation level (Tab treated as 2 spaces)
const leading = (line.match(/^[ \t]*/)?.[0] || '').replace(/\t/g, '  ');
const indentWidth = leading.length;

// 2. Infer list depth from indent width (compatible with 2/4 space indentation)
const depth = getListDepthForIndent(indentWidth);

// 3. Use stack to maintain list elements at each level, nest inner <ul>/<ol> under parent <li>
ensureListForLevel('ul', depth);
```

## Data Storage

The plugin uses `localStorage` for the following data:

| Key | Purpose | Example |
|-----|---------|---------|
| `memos-daily-review-settings` | User settings | `{"timeRange":"6months","count":8}` |
| `memos-daily-review-pool` | Pool cache | Contains memos array and timestamp |
| `memos-daily-review-cache` | Deck cache | Multiple deck objects |
| `memos-daily-review-history` | Review history | `{items: {memoId: {lastShownDay, shownCount}}}` |

### Caching Strategy

- **Pool**: 6-hour TTL, reduces repeated requests
- **Deck**: Cached by key, retains up to 10 historical decks
- **History**: Max 5000 entries, evicts by "longest unseen" when exceeded

## API Dependencies

| Endpoint | Purpose | Permission |
|----------|---------|------------|
| `GET /api/v1/memos` | Fetch memo list | Public (filtered by visibility) |
| `PATCH /api/v1/memos/{name}` | Update memo content | Requires login + permission |
| `POST /memos.api.v1.AuthService/RefreshToken` | Refresh access token | Requires refresh cookie |

## CSS Variables

The plugin uses Memos CSS variables for theme compatibility:

- `--primary` / `--primary-foreground` - Primary color
- `--background` / `--foreground` - Background/foreground color
- `--border` - Border color
- `--card` - Card background
- `--muted-foreground` - Secondary text
- `--accent` - Accent color
- `--radius` - Border radius
- `--shadow-lg` - Shadow

## Development Guide

### Modification Guide

| Need | Where to Modify |
|------|-----------------|
| Add new time range | `CONFIG.TIME_RANGES` array |
| Adjust defaults | `CONFIG.DEFAULT_TIME_RANGE` / `CONFIG.DEFAULT_COUNT` |
| Modify styles | CSS in `ui.injectStyles()` |
| Add new features | Add methods in `controller` object |

### Syntax Check

```bash
node --check memos-daily-review-plugin.js
```

### Debugging

1. Check console for logs (plugin uses `console.error` for errors)
2. Inspect `localStorage` cache data
3. Use Network panel to view API requests

## Testing Checklist

- [ ] Floating button displays correctly
- [ ] Click button opens dialog
- [ ] Prev/next navigation works, counter is correct
- [ ] Time range switch takes effect
- [ ] Count switch takes effect
- [ ] Same deck shown on same day
- [ ] "Shuffle" gets new deck (no server request)
- [ ] Light/dark theme adaptation
- [ ] Empty state shown when no memos
- [ ] Markdown renders correctly (headings, lists, bold, italic, etc.)
- [ ] Nested lists display proper indentation
- [ ] Image click opens popup preview
- [ ] Multi-image navigation works
- [ ] Edit and save works correctly
- [ ] Correct behavior when not logged in

## Known Limitations

- Max 1000 memos per fetch (API limitation)
- Simplified Markdown, not supported: code blocks, quotes, tables, horizontal rules
- Nested list depth inferred from indent width, may not fully comply with CommonMark
- Image preview doesn't support keyboard shortcuts
- Cache is date-based, auto-invalidates across days

## Reference Files

If you have the Memos source code, these files may be helpful:

| File | Purpose |
|------|---------|
| `web/src/App.tsx:39-45` | Script injection point |
| `web/src/hooks/useMemoFilters.ts` | CEL filter expression format |
| `web/src/themes/default.css` | CSS variable definitions |
| `web/src/components/MemoContent/index.tsx` | Memo content rendering reference |
