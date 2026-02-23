# Memos Daily Review Plugin - AI Development Reference

## Project Structure

```
memos-daily-review-plugin/
├── memos-daily-review-plugin.js    # Main plugin (~4200 lines, single-file)
├── README.md                       # User documentation (English)
├── CONTRIBUTING.md                 # Development guide (English)
├── CLAUDE.md                       # This file
├── .gitignore                      # Git ignore rules
├── assets/
│   └── demo.gif                    # Demo animation
└── docs/
    └── zh-CN/                      # Chinese documentation
        ├── README.zh-CN.md         # User documentation (Chinese)
        └── CONTRIBUTING.zh-CN.md   # Development guide (Chinese)
```

---

## Code Architecture

**File**: `memos-daily-review-plugin.js`

The plugin is an IIFE (Immediately Invoked Function Expression) with the following structure:

```javascript
(function DailyReviewPlugin() {
  'use strict';

  // Configuration
  const CONFIG = { /* storage keys, defaults, options */ };

  // Precompiled Regex Patterns
  const REGEX_PATTERNS = { /* heading, list, inline formatting */ };

  // Internationalization
  const i18n = {
    detectLanguage,         // Auto-detect browser language
    t,                      // Translate key to current language
    formatDate,             // Format date with locale
  };

  // Utility Functions
  const utils = {
    getDailySeed,           // Date-based seed generation
    mulberry32,             // PRNG implementation
    seededShuffle,          // Fisher-Yates with seed
    markdownToHtml,         // Markdown renderer with nested lists
    formatInlineMarkdown,   // Bold, italic, links, images
    normalizeMemo,          // Normalize API memo shape
    extractTags,            // Tag extraction from content
    // ... more utilities
  };

  // Storage Utilities
  const storageUtils = {
    setItem,                // Safe localStorage write with quota cleanup
    getItem,                // Safe localStorage read
    removeItem,             // Safe localStorage remove
  };

  // Settings Service
  const settingsService = {
    load,                   // Load user preferences
    save,                   // Save user preferences
  };

  // Batch/History Services
  const batchService = { load, save };
  const historyService = {
    load,                   // Load review history
    save,                   // Save review history
    markViewed,             // Record memo view
    getDaysSinceShown,      // Calculate days since last view
    prune,                  // LRU pruning (max 3000 items, soft limit 2500, target 2000)
  };

  // Pool/Deck Cache Services
  const poolService = {
    load,                   // Get cached pool
    save,                   // Set pool with TTL (6 hours)
  };
  const deckService = {
    getDeck,                // Get cached deck by key
    saveDeck,               // Set deck (keeps last 10)
    clear,                  // Clear all decks
    makeKey,                // Generate cache key: day-timeRange-count-batch
  };
  const capabilityService = {
    getState, saveState,    // Runtime capability cache
    // endpoint/param fallback preference helpers
  };

  // API Service
  const apiService = {
    fetchMemos,             // GET /api/v1/memos with adaptive fallback
    updateMemoContent,      // PATCH /api/v1/memos/{name}
    deleteMemo,             // DELETE /api/v1/memos/{name}
  };

  // Auth Service
  const authService = {
    getAccessToken,         // Get token from session/localStorage
    ensureAccessToken,      // Refresh token if endpoint is supported
    getAuthHeaders,         // Build Authorization header
    getCurrentUser,         // Resolve active session/user
  };

  // UI Components
  const ui = {
    injectStyles,           // Inject CSS (uses Memos CSS variables + animations)
    createFloatingButton,   // Create bottom-right button
    createDialog,           // Create modal dialog with tooltips
    renderDeck,             // Render memo card by deck index with animations
    createImagePreview,     // Create image preview overlay with transitions
    createEditDialog,       // Create edit modal with visual feedback
    bindImagePreview,       // Event delegation for images
    setReviewState,         // Set loading/empty/error state with animations
    // ... more UI methods
  };

  // Controller
  const controller = {
    init,                   // Entry point
    openDialog,             // Open review dialog
    loadDeck,               // Main deck loading logic
    estimateDesiredPoolSize,// Adaptive pool target sizing
    getPoolMemos,           // Paged fetch with time budget/early stop
    buildBuckets,           // Split pool into newest/middle/oldest time windows
    pickFromBucket,         // Pick memos from bucket with priority
    scoreByReviewPriority,  // Sort by review priority
    getDiversityPenalty,    // Diversity penalty for dense clusters
    findSparkPair,          // Find spark pair (O(n) algorithm)
    buildDeckFromPool,      // Generate final deck
    prev, next, newBatch,   // Navigation and reshuffle with slide animations
    editCurrent, saveEditor,// Edit current memo with visual feedback
    deleteCurrent,          // Delete current memo with fade-out animation
  };

  // Entry Point + optional test hooks
})();
```

---

## Key Algorithms

### 1. Deterministic Deck Generation

**Location**: `controller.loadDeck()` + `controller.buildDeckFromPool()`

**Process**:
1. Compute target pool size from `dailyCount`
2. Fetch pool from cache/API with early-stop budget controls
3. Build 3 buckets by time windows (newest/middle/oldest)
4. Allocate target count across buckets (e.g., 8 cards → 3/3/2)
5. Pick from each bucket using review priority + diversity penalty
6. Interleave buckets for variety
7. Insert spark pair if available
8. Top up from global priority list if still below count

**Key**: Uses `seedPrefix = day + timeRange + count + batch` for deterministic randomness.

```javascript
// Simplified logic
const desiredPoolSize = estimateDesiredPoolSize(settings.timeRange, settings.count);
const pool = await getPoolMemos(settings.timeRange, desiredPoolSize);
const buckets = buildBuckets(pool);  // [oldest, middle, newest]
const targets = [Math.ceil(count/3), Math.ceil(count/3), count - 2*Math.ceil(count/3)];
const selected = buckets.map((bucket, i) => pickFromBucket(bucket, targets[i], history, today, seedPrefix));
const interleaved = interleave(selected);
const sparkPair = findSparkPair(pool, history, today, seedPrefix);
if (sparkPair) insertSparkPair(interleaved, sparkPair);
return topUpIfNeeded(interleaved, pool, count);
```

### 2. Review Priority Algorithm

**Location**: `controller.scoreByReviewPriority()` + `controller.pickFromBucket()`

**Scoring Criteria** (in order):
1. Never shown (highest priority)
2. Days since last shown (longer = higher)
3. Shown count (lower = higher)
4. Tie-breaker (deterministic hash of memo ID)
5. Diversity penalty in candidate window (same tag/time cluster gets extra cost)

**Relaxation Strategy**:
- Try `minDaysSince = 3` first
- If insufficient, relax to 2, then 1, then 0
- Ensures enough memos even with small pools

```javascript
// Simplified logic
const scored = scoreByReviewPriority(bucket, history, today, seedPrefix);
const picked = [];
for (const minDays of [3, 2, 1, 0]) {
  while (picked.length < target) {
    const candidates = scored.filter(item => item.daysSince >= minDays && !pickedIds.has(item.memo.id));
    if (candidates.length === 0) break;
    const selected = chooseWithDiversityPenalty(candidates, picked); // candidate-window search
    picked.push(selected.memo);
  }
}
return picked.slice(0, target);
```

### 3. Spark Pair Algorithm

**Location**: `controller.findSparkPair()`

**Purpose**: Find memo pairs with same tag but maximum time gap.

**Optimization**: O(n) linear scan instead of O(n log n) sorting.

```javascript
// Simplified logic
const tagMap = {};
for (const memo of pool) {
  for (const tag of memo.tags) {
    if (!tagMap[tag]) tagMap[tag] = [];
    tagMap[tag].push(memo);
  }
}

const candidates = [];
for (const [tag, memos] of Object.entries(tagMap)) {
  if (memos.length < 2) continue;

  // O(n) scan for min/max instead of O(n log n) sort
  let oldest = memos[0];
  let newest = memos[0];
  for (const memo of memos) {
    const t = new Date(memo.createTime).getTime();
    const oldestTime = new Date(oldest.createTime).getTime();
    const newestTime = new Date(newest.createTime).getTime();
    if (t < oldestTime) oldest = memo;
    if (t > newestTime) newest = memo;
  }

  const tie = stringToSeed(`spark-${tag}-${seedPrefix}`);
  candidates.push({ oldest, newest, tie });
}

candidates.sort((a, b) => a.tie - b.tie);
return candidates[0] || null;
```

### 4. Markdown Rendering with Nested Lists

**Location**: `utils.markdownToHtml()`

**Key Features**:
- Detects indentation level (Tab = 2 spaces)
- Infers list depth from indent width
- Uses stack to maintain list elements at each level
- Nests inner `<ul>`/`<ol>` under parent `<li>`
- Uses DocumentFragment for batch DOM insertion

```javascript
// Simplified logic
const fragment = document.createDocumentFragment();
const listStack = [];  // [{type: 'ul', depth: 0, element: <ul>}, ...]

for (const line of lines) {
  const leading = line.match(/^[ \t]*/)[0].replace(/\t/g, '  ');
  const indentWidth = leading.length;
  const depth = getListDepthForIndent(indentWidth);
  const trimmed = line.trim();

  if (ulMatch = trimmed.match(/^[-*+]\s+(.*)$/)) {
    ensureListForLevel('ul', depth);
    const li = document.createElement('li');
    li.innerHTML = formatInlineMarkdown(ulMatch[1]);
    listStack[listStack.length - 1].element.appendChild(li);
  }
  // ... similar for ordered lists, headings, paragraphs
}

container.appendChild(fragment);
```

---

## Data Storage

**localStorage Keys**:

| Key | Purpose | Structure |
|-----|---------|-----------|
| `memos-daily-review-settings` | User settings | `{timeRange: string, count: number}` |
| `memos-daily-review-pool` | Pool cache | `{memos: Memo[], timestamp: number}` |
| `memos-daily-review-cache` | Deck cache | `{[key: string]: {deck: Memo[], timestamp: number}}` |
| `memos-daily-review-history` | Review history | `{items: {[memoId: string]: {lastShownDay: string, shownCount: number}}}` |
| `memos-daily-review-capabilities` | Runtime capability cache | `{preferred endpoints, fallback flags, timestamp}` |
| `memos-daily-review-batch` | Daily shuffle batch | `{day: string, batch: number}` |

**Caching Strategy**:
- **Pool**: TTL 6 hours, adaptive target size + early-stop policy
- **Deck**: Cached by key `day-timeRange-count-batch`, keeps last 10
- **History**: Max 3000 entries (hard limit), soft limit 2500 triggers cleanup to 2000 target, LRU eviction by "longest unseen", proactive monitoring every 60 seconds
- **Capabilities**: TTL + refresh cooldown to avoid repeated unsupported endpoint probing

---

## API Dependencies

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/v1/memos` | GET | Fetch memo list | Optional (filters by visibility) |
| `/api/v1/memos/{name}` | PATCH | Update memo content | Required |
| `/api/v1/memos/{name}` | DELETE | Delete memo | Required |
| `/api/v1/auth/refresh` | POST | Refresh access token (newer path) | Requires refresh cookie |
| `/memos.api.v1.AuthService/RefreshToken` | POST | Refresh access token (compat fallback) | Requires refresh cookie |
| `/api/v1/auth/sessions/current` | GET | Session check (v0.25.x baseline) | Required |
| `/api/v1/auth/me` | GET | Session check (newer path) | Required |

**Query Parameters** (GET /api/v1/memos):
- `pageSize`: Max 1000
- `pageToken`: Pagination token
- `state`: `NORMAL` / `ARCHIVED`
- `orderBy`: preferred sorting field (auto-downgraded if unsupported)
- `filter`: CEL expression (auto-downgraded if unsupported)

**Compatibility Notes**:
- Baseline compatibility target: `v0.25.3`
- Forward target: `v0.26.x+`
- Runtime capability detection caches endpoint preferences and fallback support flags in `memos-daily-review-capabilities`.

---

## CSS Variables

Uses Memos CSS variables for theme compatibility:

- `--primary` / `--primary-foreground` - Primary color
- `--background` / `--foreground` - Background/foreground
- `--border` - Border color
- `--card` - Card background
- `--muted-foreground` - Secondary text
- `--accent` - Accent color
- `--radius` - Border radius
- `--shadow-lg` - Shadow

**UI Enhancements (v2.0)**:
- **Animations**: Smooth transitions for card switching, loading, and deletion
  - Fade-in/fade-out for batch changes and deletions
  - Slide animations (left/right) for prev/next navigation
  - Spin animation for loading spinner
  - Scale animation for counter updates
- **Tooltips**: All icon buttons have `title` attributes for accessibility
- **Empty State**: Improved design with icon, title, and hint text
- **Loading State**: Animated spinner with visual feedback
- **Mobile Responsive**: Optimized layout for screens < 640px
  - Larger touch targets (44px buttons)
  - Vertical action bar layout
  - Adjusted spacing and font sizes

---

## Modification Guide

### Add New Time Range

**File**: `memos-daily-review-plugin.js`
**Location**: Lines 30-38 (`CONFIG.TIME_RANGES`)

```javascript
TIME_RANGES: [
  { value: 'all', days: null },
  { value: '1year', days: 365 },
  { value: '6months', days: 180 },
  { value: '3months', days: 90 },
  { value: '1month', days: 30 },
  // Add new range here
],
```

### Add New Count Option

**Location**: Lines 40-41 (`CONFIG.COUNT_OPTIONS`)

```javascript
COUNT_OPTIONS: [4, 8, 12, 16, 20, 24],  // Add new count here
```

### Modify Styles

**Location**: Lines 1600-2650 (`ui.injectStyles()`)

All styles are injected as a single `<style>` tag. Modify CSS rules directly.

**Key Animation Keyframes**:
- `@keyframes daily-review-fade-in` - Fade in effect
- `@keyframes daily-review-fade-out` - Fade out effect
- `@keyframes daily-review-spin` - Rotation for loading spinner
- `@keyframes daily-review-slide-in-left` - Slide in from left
- `@keyframes daily-review-slide-in-right` - Slide in from right
- `@keyframes daily-review-slide-out-left` - Slide out to left
- `@keyframes daily-review-slide-out-right` - Slide out to right

**Mobile Responsive Breakpoint**: `@media (max-width: 640px)`

### Adjust Caching

**Location**: Lines 25-48 (`CONFIG`)

```javascript
POOL_TTL_MS: 6 * 60 * 60 * 1000,  // Pool cache TTL (6 hours)
NO_REPEAT_DAYS: 3,                 // Deduplication days
HISTORY_MAX_ITEMS: 3000,           // Max history entries (hard limit)
HISTORY_SOFT_LIMIT: 2500,          // Soft limit triggers cleanup
HISTORY_CLEANUP_TARGET: 2000,      // Target size after cleanup
STORAGE_CHECK_INTERVAL_MS: 60000,  // Storage monitor interval (60 seconds)
POOL_MAX_PAGES_ALL: 6,             // All-time max pages
POOL_FETCH_TIME_BUDGET_MS: 4000,   // Early-stop time budget
DIVERSITY_PENALTY_ENABLED: true,   // Diversity penalty switch
```

---

## Debugging

### Console Logging

The plugin uses `console.error` for errors. Add `console.log` for debugging:

```javascript
console.log('[DailyReview] Generated deck:', deck);
console.log('[DailyReview] History:', history);
```

### Inspect localStorage

```javascript
// In browser console
localStorage.getItem('memos-daily-review-settings');
localStorage.getItem('memos-daily-review-pool');
localStorage.getItem('memos-daily-review-cache');
localStorage.getItem('memos-daily-review-history');
localStorage.getItem('memos-daily-review-capabilities');
localStorage.getItem('memos-daily-review-batch');
```

### Performance Profiling

```javascript
// Add performance marks
performance.mark('generateDeck-start');
// ... function logic
performance.mark('generateDeck-end');
performance.measure('generateDeck', 'generateDeck-start', 'generateDeck-end');
console.log(performance.getEntriesByName('generateDeck'));
```

### Network Inspection

Use browser DevTools Network panel to inspect API calls:
- Check request headers (Authorization)
- Check response status and body
- Check timing (should use cache when available)

---

## Common Tasks

### Clear All Caches

```javascript
// In browser console
localStorage.removeItem('memos-daily-review-pool');
localStorage.removeItem('memos-daily-review-cache');
localStorage.removeItem('memos-daily-review-history');
localStorage.removeItem('memos-daily-review-capabilities');
localStorage.removeItem('memos-daily-review-batch');
```

### Force Refresh Pool

```javascript
// In browser console
localStorage.removeItem('memos-daily-review-pool');
// Then click "每日回顾" button
```

### Test with Different Seed

Modify `getDailySeed()` to return a fixed value:

```javascript
getDailySeed() {
  return 'test-seed-123';  // Fixed seed for testing
},
```

### Syntax Check

```bash
node --check memos-daily-review-plugin.js
```

### Algorithm Regression Tests

```bash
# Use --test-isolation=none in restricted environments
node --test --test-isolation=none tests/algorithm.test.js
```

---

## Known Limitations

- Max 1000 memos per API page (`pageSize` cap)
- Simplified Markdown (no code blocks, quotes, tables, horizontal rules)
- Nested list depth inferred from indent width (may not fully comply with CommonMark)
- Cache is date-based, auto-invalidates across days
- Button auto-hides on `/auth` routes
- Animations may be reduced on low-end devices (respects `prefers-reduced-motion`)

---

## Performance Benchmarks

For datasets with 1000+ memos:
- Deck generation: < 100ms
- Markdown rendering (long docs): < 50ms
- Memory usage: Stable after 100 card switches
- Animation performance: 60fps on modern devices

**UI Performance Optimizations (v2.0)**:
- DocumentFragment for batch DOM insertion
- Event delegation for image preview
- CSS transitions instead of JavaScript animations
- Precompiled regex patterns
- LRU cache for image groups

Use browser Performance panel for profiling.
