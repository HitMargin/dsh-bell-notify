// 宿主端到端：apply() → 观察 api-session/status → 发通知 → SSE / 补偿拉取 / 开关。
//
// 这条链路正是"模型跑完 → Windows 弹通知"真正走的那条路。用假 ctx 跑一遍，能在
// 重启 DSH 之前证明：转场判定对、路由注册得上、开关生效、事件推得出去。
//
// 注意：本机是 Windows，所以走到 PowerShell 兜底时会**真的弹一条通知** —— 那正好
// 顺带验证了系统通知确实能出来。测试不把它当失败。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bell-test-'));
// 测试不该每跑一次就放六七条真 toast 出来，也不该被 PowerShell 的启动耗时拖慢。
process.env.DSH_BELL_DISABLE_TOAST = '1';

const mod = await import('../index.js');
const { apply, ROUTE_STATE, ROUTE_PENDING, ROUTE_STREAM, ROUTE_TEST } = mod;

const ok = (msg) => console.log('ok   ' + msg);

/** 造一个最小 cordis 上下文，把事件监听与路由都收起来。 */
function makeCtx() {
  const listeners = new Map();
  const routes = new Map();

  const ctx = {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name)?.delete(handler);
    },
    get() { return null; },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    inject(services, callback) {
      const child = {
        webServer: {
          register(def) {
            routes.set(def.path, def.handler);
            return () => routes.delete(def.path);
          },
        },
      };
      const dispose = callback(child);
      return { dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
    logger: () => ({ info() {} }),
  };

  const emit = (name, ...args) => {
    for (const fn of listeners.get(name) || []) fn(...args);
  };

  return { ctx, routes, emit };
}

/** 造一个假的 POST 请求。 */
function post(body, extra = {}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
    method: 'POST',
    url: '/',
    ...extra,
  });
}

/** 造一个假的 GET 请求。 */
function get(query = '') {
  return Object.assign(Readable.from([]), {
    headers: {},
    method: 'GET',
    url: `/${query}`,
  });
}

/** 假的响应对象。 */
function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    write() {},
    end(body) { if (body) this.body += body; },
    on() {},
  };
}

async function call(handler, req) {
  const res = fakeRes();
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* SSE / 非 JSON */ }
  return { status: res.statusCode, json, res };
}

/* ── 1. 路由都注册上了 ───────────────────────────────────────────────── */
{
  const { ctx, routes } = makeCtx();
  apply(ctx);
  for (const r of [ROUTE_STATE, ROUTE_PENDING, ROUTE_STREAM, ROUTE_TEST]) {
    assert.ok(routes.has(r), `路由缺失: ${r}`);
  }
  ok(`四条路由已注册（state / pending / stream / test）`);
}

/* ── 2. 开关默认关，可切换 ───────────────────────────────────────────── */
{
  const { ctx, routes } = makeCtx();
  apply(ctx);

  let r = await call(routes.get(ROUTE_STATE), get());
  assert.equal(r.json.enabled, false, '默认应为关');
  ok('默认关闭（通知不该默认打扰）');

  r = await call(routes.get(ROUTE_STATE), post({ enabled: true }));
  assert.equal(r.json.enabled, true, '打开失败');
  ok('PUT 打开成功');

  r = await call(routes.get(ROUTE_STATE), get());
  assert.equal(r.json.enabled, true, '读回应为开');
  ok('GET 读回一致');
}

/* ── 3. 核心：running true → false 才记一笔 ─────────────────────────── */
{
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  await call(routes.get(ROUTE_STATE), post({ enabled: true }));

  // 启动时的空闲态：不该误报
  emit('api-session/status', 's-1', false);
  let r = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(r.json.events.length, 0, '本来就是空闲的会话不该算跑完');
  ok('启动即空闲 → 不误报');

  // 正在跑
  emit('api-session/status', 's-1', true);
  // 又报一次 false：这才是"跑完了"
  emit('api-session/status', 's-1', false);

  // 事件必须**同步**就位 —— 通知在后台发，不该挡住事件本身。
  r = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(r.json.events.length, 1, '应记 1 条');
  assert.equal(r.json.events[0].sessionId, 's-1');
  assert.equal(r.json.events[0].seq, 1);
  assert.ok('delivered' in r.json.events[0], '事件必须带 delivered 字段');
  assert.equal(r.json.events[0].delivered, 'pending', '推送时通知还在发，应为 pending');
  ok('running true→false 立即记 1 条（seq=1, delivered=pending）');

  // 等后台投递落地，同一条事件应被就地更新
  await new Promise((r2) => setTimeout(r2, 50));
  const after = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(after.json.events[0].seq, 1, '更新不应产生新 seq');
  assert.equal(after.json.events[0].delivered, 'skipped', '投递结果应回填');
  ok(`投递结果回填到同一条事件（delivered=${after.json.events[0].delivered}）`);

  // 关机状态下不再记录
  await call(routes.get(ROUTE_STATE), post({ enabled: false }));
  emit('api-session/status', 's-1', true);
  emit('api-session/status', 's-1', false);
  r = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(r.json.events.length, 1, '关掉后不应再记录');
  ok('关掉后不再记录');
}

/* ── 4. 开关从关→开时清掉旧账 ───────────────────────────────────────── */
{
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  await call(routes.get(ROUTE_STATE), post({ enabled: true }));
  emit('api-session/status', 's-9', true);
  emit('api-session/status', 's-9', false);
  let r = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(r.json.events.length, 1);

  await call(routes.get(ROUTE_STATE), post({ enabled: false }));
  await call(routes.get(ROUTE_STATE), post({ enabled: true }));

  r = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(r.json.events.length, 0, '重开铃铛不该把昨天的旧账一起弹出来');
  ok('重开时清掉旧账');
}

/* ── 5. since 游标 ──────────────────────────────────────────────────── */
{
  const { ctx, routes, emit } = makeCtx();
  apply(ctx);
  await call(routes.get(ROUTE_STATE), post({ enabled: true }));
  for (const id of ['a', 'b', 'c']) {
    emit('api-session/status', id, true);
    emit('api-session/status', id, false);
  }
  const all = await call(routes.get(ROUTE_PENDING), get('?since=0'));
  assert.equal(all.json.events.length, 3);
  assert.equal(all.json.seq, 3);

  const tail = await call(routes.get(ROUTE_PENDING), get('?since=2'));
  assert.equal(tail.json.events.length, 1);
  assert.equal(tail.json.events[0].sessionId, 'c');
  ok('since 游标正确（since=2 只给第 3 条）');
}

/* ── 6. 测试通知路由 ────────────────────────────────────────────────── */
{
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const r = await call(routes.get(ROUTE_TEST), post({}));
  assert.equal(r.json.ok, true);
  assert.equal(r.json.delivered, 'skipped', '测试里应通过 DSH_BELL_DISABLE_TOAST 跳过');
  ok('测试通知路由可用（本次按 DSH_BELL_DISABLE_TOAST 跳过真弹）');
}

/* ── 7. 跨站写请求必须拒绝 ──────────────────────────────────────────── */
{
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const req = Object.assign(Readable.from([Buffer.from('{"enabled":true}')]), {
    headers: { 'sec-fetch-site': 'cross-site' },
    method: 'PUT',
    url: '/',
  });
  const r = await call(routes.get(ROUTE_STATE), req);
  assert.equal(r.status, 403);
  ok('跨站写请求 → 403');
}

/* ── 8. SSE 响应头 ──────────────────────────────────────────────────── */
{
  const { ctx, routes } = makeCtx();
  apply(ctx);
  const { status, res } = await call(routes.get(ROUTE_STREAM), get());
  assert.equal(status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  ok('SSE 响应头正确（text/event-stream，关闭反代缓冲）');
}

console.log('\n全部通过');