// 手动验证：真的弹一条 Windows 系统通知。
//
// 不属于默认测试集（`node test/*.test.mjs` 不含它），因为跑一次就会在屏幕上
// 冒一条通知。改完通知相关代码后手动跑一次，眼见为实：
//
//   node test/toast-live.mjs
//
// 在纯 Node 下 Electron 不可用，所以这里走的是 PowerShell 兜底那条路；
// Electron 原生通知只能在 DSH 桌面版里验证（点一下铃铛会发测试通知）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'bell-toast-'));
delete process.env.DSH_BELL_DISABLE_TOAST;

const { apply, ROUTE_TEST } = await import('../index.js');

const routes = new Map();
const ctx = {
  on: () => () => {},
  get: () => null,
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
  logger: () => ({ info: (m) => console.log('  [log]', m) }),
};

apply(ctx);

const handler = routes.get(ROUTE_TEST);
if (!handler) {
  console.error('FAIL: 测试路由没注册上');
  process.exit(1);
}

const req = Object.assign(Readable.from([Buffer.from('{}')]), {
  headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1', origin: 'http://127.0.0.1' },
  method: 'POST',
  url: '/',
});

const res = {
  statusCode: 0,
  headers: null,
  body: '',
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
  end(body) { if (body) this.body += body; },
};

await handler(req, res);
console.log('响应:', res.body);

let json = null;
try { json = JSON.parse(res.body); } catch { /* ignore */ }

if (json && json.ok && json.delivered) {
  console.log(`\n通过 —— 通知已通过「${json.delivered}」通道发出，看屏幕右下角/通知中心。`);
} else {
  console.error('\n失败 —— 没有可用的通知通道。');
  process.exitCode = 1;
}