# Technical Documentation

English | [中文](./docs/zh-CN/CONTRIBUTING.zh-CN.md)

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
| `REGEX_PATTERNS` | Precompiled regex patterns |
| `i18n` | Internationalization (language detection, translations, locale formatting) |
| `utils` | Utility functions (random seed, shuffle, date formatting, Markdown rendering) |
| `settingsService` | User settings persistence |
| `batchService` | Batch state persistence (shuffle state within same day) |
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
// 1) Fetch memo pool with adaptive target size (based on daily count)
// 2) Stop early when fetch time budget is exceeded and pool quality is acceptable
// 3) Generate "daily deck": key = day + timeRange + count + batch
// 4) Deck uses stable shuffling (memoId + seed) to avoid dependency on API order
```

### Review-Style Selection

```javascript
// 1) Split pool into 3 buckets by time boundaries (newest/middle/oldest windows)
// 2) Apply 3-day deduplication using local history (relaxes if insufficient)
// 3) Priority: never seen > long unseen > low view count (tie-break with stable hash)
// 4) Apply diversity penalty to avoid dense same-tag/time-cluster picks
// 5) Try inserting 1 "spark pair" (earliest + latest memo sharing same tag)
// 6) Top up from global priority list if bucket picks are insufficient
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

## Performance Optimizations (v2.0)

### High Priority Optimizations

**1. findSparkPair Algorithm Optimization**
- Problem: Used O(n log n) sorting to find earliest and latest memos
- Solution: Changed to O(n) linear scan for min/max values
- Impact: ~70% performance improvement for scenarios with 100 tags × 10 memos each

**2. sortByReviewPriority Optimization**
- Problem: `getDaysSinceShown` called twice (once in filter, once in map)
- Solution: Merged filter and map operations to calculate once
- Impact: 50% reduction in history query calls

**3. Markdown Rendering Optimization**
- Problem: Multiple `appendChild` calls trigger browser reflows
- Solution: Use DocumentFragment for batch DOM insertion
- Impact: 30-50% faster rendering for long documents

### Medium Priority Optimizations

**4. Regex Precompilation**
- Problem: New regex objects created on every `markdownToHtml` call
- Solution: Precompile patterns at module level as `REGEX_PATTERNS`
- Impact: 5-10% rendering performance improvement, reduced GC pressure

**5. imageGroups Memory Management**
- Problem: `imageGroups` reset on every render, losing previous data
- Solution: LRU-style management, keeping last 10 entries
- Impact: Prevents image preview bugs during rapid card switching

### Low Priority Optimizations

**6. Event Delegation**
- Problem: Individual event listeners for each image link
- Solution: Single delegated listener on container
- Impact: Reduced memory usage, better scaling with many images

**7. Storage Quota Monitoring (v2.4)**
- Problem: No visibility into localStorage usage
- Solution: Added `calculateStorageStats()` and `getStorageReport()`
- Impact: Proactive monitoring prevents quota errors, automatic reporting every 10 minutes

**8. Markdown Rendering Refactoring (v2.4)**
- Problem: `markdownToHtml` was 156 lines with complexity ~25
- Solution: Extracted `IndentDepthCalculator` and `ListLevelManager` modules
- Impact: Reduced complexity from 25 to ~12, improved testability and maintainability

### Performance Metrics

For datasets with 1000+ memos:
- Deck generation: 50-70% faster
- Markdown rendering: 30-50% faster
- Memory usage: 20-30% reduction

## Data Storage

The plugin uses `localStorage` for the following data:

| Key | Purpose | Example |
|-----|---------|---------|
| `memos-daily-review-settings` | User settings | `{"timeRange":"6months","count":8}` |
| `memos-daily-review-pool` | Pool cache | Contains memos array and timestamp |
| `memos-daily-review-cache` | Deck cache | Multiple deck objects |
| `memos-daily-review-history` | Review history | `{items: {memoId: {lastShownDay, shownCount}}}` |

### Caching Strategy

- **Pool**: 6-hour TTL, adaptive target size + early stop controls
- **Deck**: Cached by key, retains up to 10 historical decks
- **History**: Max 5000 entries, evicts by "longest unseen" when exceeded

## API Dependencies

| Endpoint | Purpose | Permission |
|----------|---------|------------|
| `GET /api/v1/memos` | Fetch memo list | Public (filtered by visibility) |
| `PATCH /api/v1/memos/{name}` | Update memo content | Requires login + permission |
| `POST /api/v1/auth/refresh` | Refresh access token (newer API) | Requires refresh cookie |
| `POST /memos.api.v1.AuthService/RefreshToken` | Refresh access token (compatibility fallback) | Requires refresh cookie |
| `GET /api/v1/auth/sessions/current` | Auth/session check (v0.25.x baseline path) | Login required |
| `GET /api/v1/auth/me` | Auth/session check (newer path) | Login required |

## Compatibility Strategy

- Baseline compatibility target: **Memos v0.25.3**
- Forward-compatibility target: **Memos v0.26.x+**
- Runtime capability detection:
  - Auth/session endpoint probing with cached preference
  - Refresh endpoint probing with cooldown retry
  - `updateMask` vs `update_mask` update fallback
  - Query fallback when `filter` / `orderBy` is rejected
  - Pagination token compatibility: `nextPageToken` and `next_page_token`
- Local capability cache key: `memos-daily-review-capabilities`

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

### Algorithm Regression Tests

```bash
# NOTE: use --test-isolation=none in restricted environments
node --test --test-isolation=none tests/algorithm.test.js
```

### Debugging

1. Check console for logs (plugin uses `console.error` for errors)
2. Inspect `localStorage` cache data
3. Use Network panel to view API requests
4. Use Performance panel for profiling

## Testing Checklist

### Functional Tests
- [ ] Floating button displays correctly
- [ ] Click button opens dialog
- [ ] Prev/next navigation works, counter is correct
- [ ] Time range switch takes effect
- [ ] Count switch takes effect
- [ ] Same deck shown on same day
- [ ] "Shuffle" gets new deck (no server request)
- [ ] Light/dark theme adaptation
- [ ] Empty state shown when no memos (with icon and hint text)
- [ ] Markdown renders correctly (headings, lists, bold, italic, etc.)
- [ ] Nested lists display proper indentation
- [ ] Image click opens popup preview
- [ ] Multi-image navigation works
- [ ] Edit and save works correctly
- [ ] Correct behavior when not logged in
- [ ] v0.25.3 compatibility fallback works (`next_page_token`, session endpoint path)
- [ ] v0.26.x compatibility path works (`/api/v1/auth/me`, refresh endpoint)

### UI/UX Tests
- [ ] Icon buttons show tooltip hints
- [ ] Card switching has slide animations (left/right direction)
- [ ] New batch has fade-in animation
- [ ] Deletion has fade-out animation
- [ ] Loading shows spinning spinner
- [ ] Counter change has scale animation
- [ ] Edit dialog has visual feedback
- [ ] Image preview has smooth transitions
- [ ] Mobile layout works correctly (< 640px width)
- [ ] Mobile button sizes are adequate (44px touch targets)
- [ ] Mobile action bar stacks vertically

### Performance Tests
- [ ] Use Performance panel to test large datasets (1000+ memos)
- [ ] Test `generateDeck` execution time (should be < 100ms)
- [ ] Test Markdown rendering time (long docs should be < 50ms)
- [ ] Check memory usage (no significant growth after 100 card switches)
- [ ] Verify adaptive pool fetch stops within configured budget on large datasets
- [ ] Verify diversity penalty reduces dense same-tag streaks in generated deck

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

## Project Architecture

For detailed project architecture, see [CLAUDE.md](./CLAUDE.md).
