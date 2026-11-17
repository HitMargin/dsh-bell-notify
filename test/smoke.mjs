// 客户端冒烟：把浏览器半边在 Node 里跑一遍。
//
// 抓的是 `node --check` 抓不到的三类错：
//   1. factory 体抛异常（顶层语法之外的运行时错误）；
//   2. apply() 的注册形状写错（ctx.slots / ctx.locale / ctx.effect 用错）；
//   3. 组件渲染崩（prop 名字、hook 顺序、变量未定义）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let loaded = null;
const windowStub = {
  __ModuleLoader__: { load: (def) => { loaded = def; } },
};

// ── 极简 React：够跑一次渲染 ──────────────────────────────────────────────
const stateQueue = [];
let renderCount = 0;
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => {
    renderCount += 1;
    const value = stateQueue.length > 0
      ? stateQueue.shift()
      : (typeof initial === 'function' ? initial() : initial);
    return [value, () => {}];
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
};

// ── 极简 DOM ──────────────────────────────────────────────────────────────
const listeners = new Map();
const makeEl = () => ({
  id: '', textContent: '', style: {},
  remove() {}, appendChild() {}, setAttribute() {},
});
const documentStub = {
  head: { appendChild() {} },
  body: makeEl(),
  visibilityState: 'visible',
  getElementById: () => null,
  createElement: () => makeEl(),
  addEventListener: (n, fn) => listeners.set(n, fn),
  removeEventListener: (n) => listeners.delete(n),
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  require: (name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  },
  console,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, events: [] }) }),
  URL,
  EventSource: class {
    constructor() { this.listeners = {}; }
    addEventListener(n, fn) { this.listeners[n] = fn; }
    close() {}
  },
};
sandbox.globalThis = sandbox;

vm.runInNewContext(code, sandbox, { filename: 'client.js' });

const fail = (msg) => { console.error('FAIL ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('ok   ' + msg);

if (!loaded) { fail('__ModuleLoader__.load 没被调用'); process.exit(1); }
if (loaded.id !== 'dsh-bell-notify') fail(`id 应为包名，实际 ${loaded.id}`);
else ok('模块 id 正确');

const plugin = loaded.factory((n) => {
  if (n === 'react') return ReactStub;
  throw new Error('unexpected require: ' + n);
});

if (!plugin || typeof plugin !== 'object') fail('factory 没返回对象');
if (plugin.name !== loaded.id) fail(`插件 name 必须与包名一致：${plugin.name}`);
if (!Array.isArray(plugin.inject)) fail('inject 必须是数组');
if (typeof plugin.apply !== 'function') fail('apply 必须是函数');
ok(`插件对象形状正确（inject=[${plugin.inject}]）`);

// ── apply ────────────────────────────────────────────────────────────────
const seats = [];
let stylesMounted = false;
let dict = null;
const ctx = {
  effect(fn, label) {
    const dispose = fn();
    if (label && label.includes('styles')) stylesMounted = true;
    return typeof dispose === 'function' ? dispose : () => {};
  },
  locale: {
    register: (ns, d) => { dict = d; return () => {}; },
    bind: () => (key) => (dict && dict.zh && dict.zh[key]) || key,
  },
  slots: {
    inject(name, cb) {
      const result = cb();
      seats.push({ name, result });
      return () => {};
    },
    register(def, component) { return { def, component }; },
  },
};

try {
  plugin.apply(ctx);
  ok('apply() 未抛异常');
} catch (error) {
  fail('apply() 抛异常: ' + error.message);
  process.exit(1);
}

const seat = seats.find((s) => s.name === 'sidebar.footer.action');
if (!seat) fail('没注册到 sidebar.footer.action');
else ok('已注册到 sidebar.footer.action（侧栏底部，设置/账户旁边）');

const other = seats.find((s) => s.name === 'conversation.input.left');
if (other) fail('误注册到了 conversation.input.left');

if (seat && (!seat.result || typeof seat.result.component !== 'function')) {
  fail('register 第二个参数不是组件函数');
}
if (!stylesMounted) fail('样式没挂载');
if (seat && seat.result.def.order !== 10) fail(`order 应为 10，实际 ${seat.result.def.order}`);

// ── 渲染：开/关两种状态 ──────────────────────────────────────────────────
if (seat) {
  const Component = seat.result.component;
  for (const [label, value, expected] of [
    ['关（默认）', false, 'false'],
    ['开', true, 'true'],
  ]) {
    stateQueue.length = 0;
    stateQueue.push(value);
    try {
      const el = Component({});
      const on = el.props['data-on'];
      if (on !== expected) throw new Error(`data-on 应为 ${expected}，实际 ${on}`);
      if (typeof el.props.onClick !== 'function') throw new Error('没有 onClick');
      if (el.props['aria-pressed'] !== (value ? true : false)) throw new Error('aria-pressed 不对');
      const icon = el.children.find((c) => c && c.props && c.props.className
        && String(c.props.className).startsWith('dsh-bell-notify-icon'));
      if (!icon) throw new Error('没有图标');
      const paths = icon.children.filter((c) => c && c.type === 'path');
      if (paths.length !== 3) throw new Error(`应有 3 条 path（铃身/铃舌/斜杠），实际 ${paths.length}`);
      ok(`渲染 ${label} 通过（data-on=${on}，图标 3 条 path）`);
    } catch (error) {
      fail(`渲染 ${label} 失败: ${error.message}`);
    }
  }
}

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
void renderCount;