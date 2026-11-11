/**
 * cdp.mjs — Chrome DevTools Protocol 最小封装（零依赖）
 *
 * 只做四件事：连接、发送、取事件、关连接。
 * 任何业务判断都不许进来。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error).slice(0, 240))) : resolve(m.result);
        return;
      }
      if (m.method) {
        for (const fn of this.listeners.get(m.method) || []) {
          try { fn(m.params); } catch {}
        }
      }
    };
  }

  static async open(wsUrl, { retries = 2, timeout = 15000 } = {}) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const ws = new WebSocket(wsUrl);
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('ws 连接超时')), timeout);
          ws.onopen = () => { clearTimeout(t); res(); };
          ws.onerror = () => { clearTimeout(t); rej(new Error('ws 连接失败')); };
        });
        return new CDP(ws);
      } catch (e) {
        lastErr = e;
        if (i < retries) await sleep(400 * (i + 1));
      }
    }
    throw lastErr || new Error('ws 连接失败');
  }

  send(method, params = {}, timeout = 25000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); reject(e); return; }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout:${method}`));
        }
      }, timeout);
    });
  }

  async eval(expression, timeout = 25000) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 240));
    return r.result.value;
  }

  /** 订阅 CDP 事件，返回取消函数 */
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  close() {
    try { this.ws.close(); } catch {}
    this.pending.clear();
    this.listeners.clear();
  }
}

/**
 * 嗅探指定 URL 片段的 JSON 响应。
 *
 * 关键：body 必须等 loadingFinished 之后才取。
 * 在 responseReceived 阶段取，大响应（900KB br）会拿到 -32000，
 * 异常若被吞掉就会误报成「接口没发请求 / 被风控」——最难查的一类假故障。
 */
export function sniff(cdp, urlPart, onJson) {
  const pending = new Map();
  const done = new Set();

  const offResp = cdp.on('Network.responseReceived', (p) => {
    const u = p.response?.url || '';
    if (u.includes(urlPart)) pending.set(p.requestId, u);
  });

  const offDone = cdp.on('Network.loadingFinished', async (p) => {
    const u = pending.get(p.requestId);
    if (!u || done.has(p.requestId)) return;
    done.add(p.requestId);
    pending.delete(p.requestId);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, 15000);
        const text = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        if (!text || text.length < 10) return;
        onJson(JSON.parse(text), u);
        return;
      } catch {
        await sleep(300);
      }
    }
  });

  const offFail = cdp.on('Network.loadingFailed', (p) => { pending.delete(p.requestId); });

  return () => { offResp(); offDone(); offFail(); };
}
