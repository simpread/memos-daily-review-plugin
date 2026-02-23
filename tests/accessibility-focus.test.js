const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

function createMockElement(tagName = 'DIV', ownerDocument = null) {
  const attrs = new Map();
  const classes = new Set();
  return {
    nodeType: 1,
    tagName,
    ownerDocument,
    dataset: {},
    style: {},
    disabled: false,
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        if (typeof force === 'boolean') {
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        }
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      }
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
      if (name === 'id') {
        this.id = String(value);
      }
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    contains(node) {
      return node === this;
    },
    focus() {
      if (this.ownerDocument) {
        this.ownerDocument.activeElement = this;
      }
      this.focusCount = (this.focusCount || 0) + 1;
    }
  };
}

function loadHooksWithMockDom() {
  const scriptPath = path.join(__dirname, '..', 'memos-daily-review-plugin.js');
  const code = fs.readFileSync(scriptPath, 'utf8');

  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const domNodes = new Map();
  const documentListeners = new Map();

  const document = {
    readyState: 'complete',
    activeElement: null,
    addEventListener(type, handler) {
      documentListeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      const saved = documentListeners.get(type);
      if (saved === handler) {
        documentListeners.delete(type);
      }
    },
    getElementById(id) {
      return domNodes.get(id) || null;
    },
    createElement(tagName) {
      return createMockElement(String(tagName || 'DIV').toUpperCase(), document);
    },
    createDocumentFragment() {
      return { appendChild() {} };
    },
    querySelectorAll() {
      return [];
    },
    head: { appendChild() {} },
    body: { appendChild() {} }
  };

  const context = {
    console,
    Math,
    Date,
    JSON,
    Promise,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('fetch should not run in focus tests');
    },
    alert() {},
    confirm() {
      return true;
    },
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    window: {
      location: { origin: 'https://example.com', href: 'https://example.com/', pathname: '/' },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      matchMedia() {
        return { matches: false, addEventListener() {}, removeEventListener() {} };
      },
      __dailyReviewInitialized: false,
      __dailyReviewRoutePatched: false
    },
    document,
    history: {
      pushState() {},
      replaceState() {}
    },
    navigator: {
      onLine: true,
      language: 'en-US'
    },
    localStorage,
    sessionStorage,
    __DAILY_REVIEW_TEST_MODE: true
  };

  context.globalThis = context;
  context.window.history = context.history;
  context.window.localStorage = localStorage;
  context.window.sessionStorage = sessionStorage;
  context.window.navigator = context.navigator;
  context.window.document = document;

  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'memos-daily-review-plugin.js' });

  if (!context.__DAILY_REVIEW_TEST_HOOKS) {
    throw new Error('Failed to load test hooks');
  }

  return {
    hooks: context.__DAILY_REVIEW_TEST_HOOKS,
    document,
    domNodes,
    documentListeners
  };
}

function createTabEvent({ target, shiftKey = false }) {
  return {
    key: 'Tab',
    shiftKey,
    ctrlKey: false,
    metaKey: false,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
}

test('Tab should trap focus inside dialog when active element is outside', () => {
  const { hooks, document, domNodes, documentListeners } = loadHooksWithMockDom();

  const outside = createMockElement('BUTTON', document);
  const first = createMockElement('BUTTON', document);
  const last = createMockElement('BUTTON', document);
  const activeTab = createMockElement('BUTTON', document);
  activeTab.dataset.tab = 'review';

  const dialog = createMockElement('DIV', document);
  dialog.querySelector = (selector) => (selector === '.daily-review-tab.active' ? activeTab : null);
  dialog.querySelectorAll = () => [first, last];
  dialog.contains = (node) => node === dialog || node === first || node === last;

  domNodes.set('daily-review-dialog', dialog);

  hooks.controller.isOpen = true;
  hooks.controller.bindKeyboardShortcuts();

  document.activeElement = outside;
  const keydown = documentListeners.get('keydown');
  assert.ok(keydown, 'keydown handler should be registered');

  const event = createTabEvent({ target: outside, shiftKey: false });
  keydown(event);

  assert.equal(document.activeElement, first);
  assert.equal(event.defaultPrevented, true);
});

test('Shift+Tab on first focusable should wrap to last focusable', () => {
  const { hooks, document, domNodes, documentListeners } = loadHooksWithMockDom();

  const first = createMockElement('BUTTON', document);
  const last = createMockElement('BUTTON', document);
  const activeTab = createMockElement('BUTTON', document);
  activeTab.dataset.tab = 'review';

  const dialog = createMockElement('DIV', document);
  dialog.querySelector = (selector) => (selector === '.daily-review-tab.active' ? activeTab : null);
  dialog.querySelectorAll = () => [first, last];
  dialog.contains = (node) => node === dialog || node === first || node === last;

  domNodes.set('daily-review-dialog', dialog);

  hooks.controller.isOpen = true;
  hooks.controller.bindKeyboardShortcuts();

  document.activeElement = first;
  const keydown = documentListeners.get('keydown');
  assert.ok(keydown, 'keydown handler should be registered');

  const event = createTabEvent({ target: first, shiftKey: true });
  keydown(event);

  assert.equal(document.activeElement, last);
  assert.equal(event.defaultPrevented, true);
});

test('closeDialog should restore focus to previously focused element', () => {
  const { hooks, document, domNodes } = loadHooksWithMockDom();

  const overlay = createMockElement('DIV', document);
  const dialog = createMockElement('DIV', document);
  domNodes.set('daily-review-overlay', overlay);
  domNodes.set('daily-review-dialog', dialog);

  const triggerButton = createMockElement('BUTTON', document);
  hooks.controller.lastFocusedElement = triggerButton;
  hooks.controller.isOpen = true;

  hooks.controller.closeDialog();

  assert.equal(triggerButton.focusCount, 1);
});
