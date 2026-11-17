// 通知内容的端到端测试：标题 = 会话标题，正文 = 模型最后输出。
//
// 观察点是 SSE 事件上的 `title` / `body` 字段 —— 它们就是传给系统通知的两行，
// 所以不用在代码里加任何测试钩子。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bell-content-'));
// 别在测试里弹真通知，也顺便让投递立刻返回，好让断言尽快稳定。
process.env.DSH_BELL_DISABLE_TOAST = '1';

const { apply, ROUTE_PENDING, ROUTE_STATE } = await import('../index.js');

const ok = (msg) => console.log('ok   ' + msg);

/**
 * 造一条 assistant 文本事件。
 *
 * 形状必须和真实事件一致：`{ type, seq, time, data }`，消息在 `data` 里
 * （见 dsh-session 的 `SessionEvent<T>`）。之前 fixture 把字段内联在顶层，
 * 结果实现里写错 `event.message` 也照样全绿 —— 测试证明了错误的行为。
 */
const assistant = (text, extra = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time: 0,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra },
});
const toolResult = () => ({
  type: 'tool/result',
  seq: 2,
  time: 0,
  data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } },
});

/**
 * 搭一个宿主。
 * @param {object} opts `{ title, surface }`；surface 可以是数组或函数（后者用于模拟超时）。
 */
async function makeHost({ title = '会话标题', surface = [] } = {}) {
  const routes = new Map();
  const listeners = new Map();
  let running = true;

  const query = {
    async readTitle() { return { title }; },
    async readSurface() {
      if (typeof surface === 'function') return surface();
      return { session: { id: 's-1' }, inheritedEventCount: 0, capturedThroughSeq: 1, events: surface };
    },
  };

  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return query;
      return null;
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name)?.delete(handler);
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject: (services, callback) => {
      const child = {
        webServer: {
          register(def) { routes.set(def.path, def.handler); return () => routes.delete(def.path); },
        },
      };
      const dispose = callback(child);
      return { dispose: typeof dispose === 'function' ? dispose : () => {} };
    },
    logger: () => ({ info() {} }),
  };

  apply(ctx);

  const emit = (...args) => { for (const fn of listeners.get('api-session/status') || []) fn(...args); };

  // 铃铛默认是关的，不打开就什么都不会记 —— 这正是"默认不打扰"的设计。
  const res = {
    statusCode: 0, headers: null, body: '',
    writeHead(c, hd) { this.statusCode = c; this.headers = hd; },
    end(b) { if (b) this.body += b; },
  };
  await routes.get(ROUTE_STATE)(
    Object.assign(Readable.from([Buffer.from('{"enabled":true}')]), {
      headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
      method: 'POST', url: '/',
    }),
    res,
  );
  assert.equal(JSON.parse(res.body).enabled, true, '开关应已打开');

  return { routes, emit };
}

function get() {
  return Object.assign(Readable.from([]), { headers: {}, method: 'GET', url: '/' });
}

async function pendingEvents(routes, since = 0) {
  const res = {
    statusCode: 0, headers: null, body: '',
    writeHead(c, hd) { this.statusCode = c; this.headers = hd; },
    end(b) { if (b) this.body += b; },
  };
  await routes.get(ROUTE_PENDING)(get(), res);
  const json = JSON.parse(res.body);
  return json.events.filter((e) => e.seq > since);
}

/** 等后台管线跑完：delivered 不再是 pending。 */
async function waitSettled(routes, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await pendingEvents(routes);
    const last = events[events.length - 1];
    if (last && last.delivered !== 'pending') return last;
    await new Promise((r) => setTimeout(r, 30));
  }
  return (await pendingEvents(routes)).pop();
}

/* ── 0. 守卫：fixture 必须是真实事件形状 ────────────────────────────── */
{
  // 真实 SessionEvent = { type, seq, time, data }，消息在 data 里。
  // 这条守卫是上次事故的产物：fixture 把字段内联在顶层，实现里写错
  // event.message 也照样全绿，线上却永远退回通用文案。
  const e = assistant('x');
  assert.equal(e.message, undefined, 'fixture 不该把 message 内联在顶层');
  assert.ok(e.data && e.data.message, 'message 应在 data 里');
  ok('fixture 形状与真实 SessionEvent 一致（消息在 data 里）');
}

/* ── 1. 最后一轮有文本：标题 = 会话标题，正文 = 模型输出 ───────────── */
{
  const h = await makeHost({
    title: '重构登录模块',
    surface: [assistant('我先看一下现有实现。'), assistant('已完成：把 session 校验抽成独立函数，并补了单元测试。')],
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  assert.equal(ev.title, '重构登录模块', '标题应为会话标题');
  assert.equal(ev.body, '已完成：把 session 校验抽成独立函数，并补了单元测试。', '正文应为最后一条模型输出');
  ok(`标题=会话标题，正文=最后一条模型输出（${ev.body.slice(0, 12)}…）`);
}

/* ── 2. 模型以工具调用收尾 → 往前找最近的助手文本 ─────────────────── */
{
  const h = await makeHost({
    title: '查个文件',
    surface: [
      assistant('我先列一下目录。'),
      { type: 'tool/call', turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
      toolResult(),
    ],
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  assert.equal(ev.body, '我先列一下目录。', '最后一条是 tool/result 时，应取更早的助手文本');
  ok('以工具调用收尾 → 回退到最近一条助手文本');
}

/* ── 3. 多个 text 块应拼接 ────────────────────────────────────────── */
{
  const h = await makeHost({
    title: '多段输出',
    surface: [{
      type: 'assistant/message',
      seq: 1,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '第一段。' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
            { type: 'text', text: '第二段。' },
          ],
        },
      },
    }],
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  // summarize() 会把换行压成空格（系统通知正文是单行），所以这里是空格而不是 \n。
  assert.equal(ev.body, '第一段。 第二段。', '多个 text 块应拼接，非 text 块跳过');
  ok('多个 text 块拼接，tool_use 块被跳过');
}

/* ── 4. 超长截断 ─────────────────────────────────────────────────── */
{
  const long = '很长的一段回答'.repeat(40); // 280 字
  const h = await makeHost({ title: '长输出', surface: [assistant(long)] });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  assert.ok(ev.body.length <= 191, `应被截断（180 字 + 省略号 = 最多 191），实际 ${ev.body.length}`);
  assert.ok(ev.body.endsWith('…'), '截断应以省略号结尾');
  assert.ok(long.startsWith(ev.body.slice(0, 20)), '截断应保留开头');
  ok(`超长输出截断到 ${ev.body.length} 字`);
}

/* ── 5. 一条助手消息都没有 → 用通用文案，铃照响 ──────────────────── */
{
  const h = await makeHost({ title: '空会话', surface: [toolResult()] });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  assert.equal(ev.body, '', '没有助手文本时 body 留空，由投递层用通用文案');
  assert.notEqual(ev.delivered, 'failed', '取不到正文不该让通知失败');
  ok('没有助手消息 → body 留空，通知仍正常发出');
}

/* ── 6. readSurface 卡住 → 超时后退回通用文案，不拖住通知 ─────────── */
{
  const h = await makeHost({
    title: '慢查询',
    surface: () => new Promise(() => {}), // 永不 resolve
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes, 6000);
  assert.equal(ev.title, '慢查询', '标题不受正文读取影响');
  assert.notEqual(ev.delivered, 'failed');
  ok(`readSurface 卡住 → 超时后通知照发（delivered=${ev.delivered}）`);
}

/* ── 8. 读早了：先只拿到上一轮文本，收尾后才出现结论 ─────────────── */
{
  // 前两次读到的是"上一轮的中间文本"，第三次才是这一轮的结论。
  // 这正是"弹窗内容不是模型输出结论"的成因：状态刚变 idle 时最后一条消息还没落进表层。
  let calls = 0;
  const h = await makeHost({
    title: '读早了',
    surface: () => {
      calls += 1;
      if (calls < 3) {
        return {
          session: { id: 's-1' }, inheritedEventCount: 0, capturedThroughSeq: 1,
          events: [assistant('我来看一下现有实现。')],
        };
      }
      return {
        session: { id: 's-1' }, inheritedEventCount: 0, capturedThroughSeq: 3,
        events: [assistant('我来看一下现有实现。'), assistant('结论：抽成独立函数并补了测试。')],
      };
    },
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes, 6000);
  assert.equal(ev.body, '结论：抽成独立函数并补了测试。', '应等到这一轮收尾后的结论，而不是上一轮的中间文本');
  ok('读早了 → 重试到收尾，拿到的是这一轮的结论');
}

/* ── 9. 被打断的残片不能当结论 ────────────────────────────────────── */
{
  const h = await makeHost({
    title: '被中断',
    surface: [
    assistant('我先看一下'),
    // interrupted 在 data 里（与真实 SessionEvent 一致），不是事件顶层。
    {
      type: 'assistant/message',
      seq: 2,
      time: 0,
      data: {
        turn: 1,
        step: 2,
        interrupted: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '那么我改' }] },
      },
    },
  ],
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes, 6000);
  assert.equal(ev.body, '我先看一下', '被中断那条是残片，应回退到上一条完整文本');
  ok('被打断的残片被跳过，不回退成半句话');
}

/* ── 10. readSurface 抛错 → 同样不影响通知 ────────────────────────── */
{
  const h = await makeHost({
    title: '报错会话',
    surface: () => { throw new Error('日志损坏'); },
  });
  h.emit('s-1', true);
  h.emit('s-1', false);

  const ev = await waitSettled(h.routes);
  assert.notEqual(ev.delivered, 'failed');
  ok('readSurface 抛错 → 通知照发，不冒泡');
}

console.log('\n全部通过');