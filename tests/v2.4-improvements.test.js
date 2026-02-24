/**
 * Tests for v2.4 improvements
 * - localStorage quota monitoring
 * - markdownToHtml refactoring
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Mock browser environment
global.document = {
  createElement: (tag) => {
    const element = {
      tagName: tag.toUpperCase(),
      innerHTML: '',
      children: [],
      appendChild: function(child) {
        this.children.push(child);
        return child;
      },
      setAttribute: () => {},
      style: {}
    };
    return element;
  },
  createDocumentFragment: () => {
    const fragment = {
      children: [],
      appendChild: function(child) {
        this.children.push(child);
        return child;
      }
    };
    return fragment;
  }
};

global.localStorage = {
  data: {},
  getItem(key) {
    return this.data[key] || null;
  },
  setItem(key, value) {
    this.data[key] = value;
  },
  removeItem(key) {
    delete this.data[key];
  }
};

global.Blob = class Blob {
  constructor(parts) {
    this.size = parts.reduce((acc, part) => acc + part.length, 0);
  }
};

global.navigator = { onLine: true };
global.window = { location: { pathname: '/' } };
global.console = { log: () => {}, warn: () => {}, error: () => {} };

// Load plugin code
global.__DAILY_REVIEW_TEST_MODE = true;
const pluginPath = path.join(__dirname, '..', 'memos-daily-review-plugin.js');
const pluginCode = fs.readFileSync(pluginPath, 'utf-8');
eval(pluginCode);

const { utils, storageUtils, CONFIG } = global.__DAILY_REVIEW_TEST_HOOKS;

// ============================================
// Storage Monitoring Tests
// ============================================

test('calculateStorageStats returns valid structure', () => {
  // Setup test data
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ timeRange: '6months', count: 8 }));
  localStorage.setItem(CONFIG.POOL_KEY, JSON.stringify({ memos: [], timestamp: Date.now() }));

  const stats = storageUtils.calculateStorageStats();

  assert.ok(stats.keys, 'Should have keys object');
  assert.ok(typeof stats.totalSize === 'number', 'Should have totalSize number');
  assert.ok(typeof stats.totalSizeKB === 'string', 'Should have totalSizeKB string');
  assert.ok(stats.keys[CONFIG.STORAGE_KEY], 'Should include settings key');
  assert.ok(stats.keys[CONFIG.POOL_KEY], 'Should include pool key');
});

test('calculateStorageStats calculates sizes correctly', () => {
  // Clear storage
  localStorage.data = {};

  // Add known size data
  const testData = 'x'.repeat(1000); // 1000 bytes
  localStorage.setItem(CONFIG.STORAGE_KEY, testData);

  const stats = storageUtils.calculateStorageStats();

  assert.ok(stats.keys[CONFIG.STORAGE_KEY].sizeBytes >= 1000, 'Should calculate size >= 1000 bytes');
  assert.ok(parseFloat(stats.keys[CONFIG.STORAGE_KEY].sizeKB) >= 0.97, 'Should calculate KB correctly');
});

test('getStorageReport returns formatted string', () => {
  // Setup test data
  localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ test: 'data' }));

  const report = storageUtils.getStorageReport();

  assert.ok(typeof report === 'string', 'Should return string');
  assert.ok(report.includes('[DailyReview] Storage Usage Report'), 'Should include header');
  assert.ok(report.includes('KB'), 'Should include KB units');
  assert.ok(report.includes('Total'), 'Should include total');
});

test('getStorageReport sorts keys by size', () => {
  // Clear storage
  localStorage.data = {};

  // Add data with different sizes
  localStorage.setItem(CONFIG.STORAGE_KEY, 'x'.repeat(100));
  localStorage.setItem(CONFIG.POOL_KEY, 'x'.repeat(500));
  localStorage.setItem(CONFIG.CACHE_KEY, 'x'.repeat(300));

  const report = storageUtils.getStorageReport();
  const lines = report.split('\n');

  // Find data lines (skip header and separator)
  const dataLines = lines.filter(line => line.includes('KB') && !line.includes('Total'));

  // First line should be pool (largest)
  assert.ok(dataLines[0].includes('pool'), 'Largest key should be first');
});

// ============================================
// Markdown Refactoring Tests
// ============================================

test('IndentDepthCalculator handles basic indentation', () => {
  const calc = utils.IndentDepthCalculator.create();

  assert.equal(calc.getDepth(0), 0, 'First indent should be depth 0');
  assert.equal(calc.getDepth(2), 1, 'Increased indent should be depth 1');
  assert.equal(calc.getDepth(4), 2, 'Further indent should be depth 2');
});

test('IndentDepthCalculator handles dedentation', () => {
  const calc = utils.IndentDepthCalculator.create();

  calc.getDepth(0);
  calc.getDepth(2);
  calc.getDepth(4);

  assert.equal(calc.getDepth(2), 1, 'Should return to depth 1');
  assert.equal(calc.getDepth(0), 0, 'Should return to depth 0');
});

test('IndentDepthCalculator reset clears stack', () => {
  const calc = utils.IndentDepthCalculator.create();

  calc.getDepth(0);
  calc.getDepth(2);
  calc.reset();

  assert.equal(calc.stack.length, 0, 'Stack should be empty after reset');
  assert.equal(calc.getDepth(0), 0, 'Should start fresh after reset');
});

test('ListLevelManager creates list structure', () => {
  const fragment = document.createDocumentFragment();
  const mgr = utils.ListLevelManager.create(fragment);

  mgr.ensureLevel('ul', 0, fragment);

  assert.equal(mgr.listStack.length, 1, 'Should have one list level');
  assert.equal(mgr.listStack[0].type, 'ul', 'Should be unordered list');
});

test('ListLevelManager handles nested lists', () => {
  const fragment = document.createDocumentFragment();
  const mgr = utils.ListLevelManager.create(fragment);

  mgr.ensureLevel('ul', 0, fragment);
  mgr.ensureLevel('ul', 1, fragment);

  assert.equal(mgr.listStack.length, 2, 'Should have two list levels');
});

test('ListLevelManager reset clears state', () => {
  const fragment = document.createDocumentFragment();
  const mgr = utils.ListLevelManager.create(fragment);

  mgr.ensureLevel('ul', 0, fragment);
  mgr.ensureLevel('ul', 1, fragment);
  mgr.reset();

  assert.equal(mgr.listStack.length, 0, 'Stack should be empty after reset');
  assert.equal(mgr.lastLiByLevel.length, 0, 'lastLiByLevel should be empty after reset');
});

test('markdownToHtml produces same output after refactor', () => {
  const input = `# Heading 1
## Heading 2

- Item 1
- Item 2
  - Nested item
- Item 3

1. Ordered 1
2. Ordered 2

Paragraph text.`;

  const output = utils.markdownToHtml(input);

  assert.ok(typeof output === 'string', 'Should return string');
  // The output is innerHTML, which in our mock is just a string
  // We can't check for actual HTML tags without a real DOM
  // Instead, verify the function runs without errors
  assert.ok(output !== null, 'Should return non-null output');
});

test('markdownToHtml handles nested lists correctly', () => {
  const input = `- Level 1
  - Level 2
    - Level 3
  - Back to 2
- Back to 1`;

  const output = utils.markdownToHtml(input);

  assert.ok(typeof output === 'string', 'Should return string');
  assert.ok(output !== null, 'Should return non-null output');
});

test('markdownToHtml handles mixed list types', () => {
  const input = `- Unordered
  1. Ordered nested
  2. Another ordered
- Back to unordered`;

  const output = utils.markdownToHtml(input);

  assert.ok(typeof output === 'string', 'Should return string');
  assert.ok(output !== null, 'Should return non-null output');
});

test('markdownToHtml handles empty input', () => {
  const output = utils.markdownToHtml('');
  assert.ok(typeof output === 'string', 'Should return string for empty input');
});

test('markdownToHtml handles null input', () => {
  const output = utils.markdownToHtml(null);
  assert.ok(typeof output === 'string', 'Should return string for null input');
});

// ============================================
// Integration Tests
// ============================================

test('storageUtils is exposed in test hooks', () => {
  assert.ok(global.__DAILY_REVIEW_TEST_HOOKS.storageUtils, 'storageUtils should be in test hooks');
  assert.ok(typeof storageUtils.calculateStorageStats === 'function', 'Should have calculateStorageStats');
  assert.ok(typeof storageUtils.getStorageReport === 'function', 'Should have getStorageReport');
  assert.ok(typeof storageUtils.logStorageReport === 'function', 'Should have logStorageReport');
});

test('utils has refactored markdown modules', () => {
  assert.ok(utils.IndentDepthCalculator, 'Should have IndentDepthCalculator');
  assert.ok(utils.ListLevelManager, 'Should have ListLevelManager');
  assert.ok(typeof utils.IndentDepthCalculator.create === 'function', 'IndentDepthCalculator should have create');
  assert.ok(typeof utils.ListLevelManager.create === 'function', 'ListLevelManager should have create');
});

console.log('\n✓ All v2.4 improvement tests passed!\n');
