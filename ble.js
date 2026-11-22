/* Phone-to-board GATT protocol v1. Loaded directly as a classic script. */
(() => {
  'use strict';
  const SERVICE = '905d0001-664a-4b83-9f54-e53e5ecff006';
  const RX = SERVICE.replace('0001-', '0002-'), TX = SERVICE.replace('0001-', '0003-');
  const encode = new TextEncoder(), decode = new TextDecoder('utf-8', {fatal: true});
  const MAX = 8192, PAGE = 11, noop = () => {};
  const abort = () => new Error('蓝牙连接已结束');

  function limited(text, bytes) {
    let used = 0, result = '';
    for (const char of String(text)) {
      used += encode.encode(char).length;
      if (used > bytes) break;
      result += char;
    }
    return result;
  }

  function toBytes(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  function deadline(promise, ms, message) {
    let clock;
    return Promise.race([promise, new Promise((_, reject) => {
      clock = setTimeout(() => reject(new Error(message)), ms);
    })]).finally(() => clearTimeout(clock));
  }

  // The claim is committed before invoking the paid provider. IndexedDB serializes
  // read/write transactions across tabs, including two pages seeing the same ID.
  class AnswerJournal {
    async db() {
      if (!this.opened) this.opened = new Promise((resolve, reject) => {
        const req = indexedDB.open('waveshare-ble-answers-v1', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('answers');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('浏览器无法保存请求记录，请允许网站存储'));
      }).catch(error => { this.opened = null; throw error; });
      return this.opened;
    }
    async claim(key) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        let record, fresh = false;
        const tx = db.transaction('answers', 'readwrite'), store = tx.objectStore('answers');
        const read = store.get(key);
        read.onsuccess = () => {
          record = read.result;
          if (!record) {
            fresh = true;
            record = {started: Date.now()};
            store.add(record, key);
          }
        };
        tx.oncomplete = () => resolve({fresh, record});
        tx.onabort = tx.onerror = () => reject(new Error('无法记录请求，请检查浏览器存储'));
      });
    }
    async finish(key, response) {
      const db = await this.db();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('answers', 'readwrite');
        tx.objectStore('answers').put({response}, key);
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(new Error('回复未能保存在手机上'));
      });
    }
  }

  class PhoneLink {
    constructor(options = {}) {
      this.market = options.market;
      this.ai = options.ai;
      this.onStatus = options.onStatus || noop;
      this.onConnection = options.onConnection || noop;
      this.onAnswer = options.onAnswer || noop;
      this.journal = options.journal || new AnswerJournal();
      this.bluetooth = options.bluetooth || (typeof navigator !== 'undefined' && navigator.bluetooth);
      this.device = this.session = this.connecting = null;
      this.epoch = 0;
      this.wanted = false;
      this.retryCount = 0;
      this.nextId = 0;
      this.aiJobs = new Map();
      this.histories = new Map();
      this.shownAnswers = new Set();
      this.lost = () => {
        if (this.device && !this.device.gatt.connected) this.closed();
      };
    }
    get connected() { return Boolean(this.session && this.session.ready); }

    async connect({choose = false} = {}) {
      if (this.connected) return;
      if (this.connecting) return this.connecting;
      if (!this.bluetooth) throw new Error('请在 iPhone 的 Bluefy 中通过 HTTPS 打开此页');
      this.wanted = true;
      clearTimeout(this.retryTimer);
      const ticket = ++this.epoch;
      const work = (async () => {
        let target = !choose && this.device;
        let saved;
        try { saved = localStorage.getItem('waveshare-ble-device'); } catch (_) {}
        if (!target && !choose && saved && this.bluetooth.getDevices) {
          try { target = (await this.bluetooth.getDevices()).find(d => d.id === saved); } catch (_) {}
        }
        if (!target) {
          this.onStatus('选择 Waveshare Companion，并允许蓝牙连接');
          target = await this.bluetooth.requestDevice({
            filters: [{namePrefix: 'Waveshare'}], optionalServices: [SERVICE]
          });
        }
        if (!this.wanted || ticket !== this.epoch) throw abort();
        if (this.device) this.device.removeEventListener('gattserverdisconnected', this.lost);
        this.device = target;
        target.addEventListener('gattserverdisconnected', this.lost);
        await this.open(target, ticket);
        try { localStorage.setItem('waveshare-ble-device', target.id); } catch (_) {}
      })();
      this.connecting = work;
      try { await work; }
      catch (error) {
        if (this.epoch === ticket) {
          this.wanted = false;
          this.closed();
        }
        throw error;
      } finally { if (this.connecting === work) this.connecting = null; }
    }

    async open(device, ticket) {
      this.onStatus('正在连接蓝牙设备…');
      const check = () => { if (!this.wanted || this.epoch !== ticket) throw abort(); };
      const server = await deadline(device.gatt.connect(), 20000, '蓝牙连接超时');
      check();
      const service = await deadline(server.getPrimaryService(SERVICE), 8000, '未发现伴侣服务，请检查固件版本');
      const rx = await deadline(service.getCharacteristic(RX), 8000, '找不到写入通道');
      const tx = await deadline(service.getCharacteristic(TX), 8000, '找不到读取通道');
      check();
      const s = {device, rx, tx, ready: false, tail: Promise.resolve(), lastAck: 0, marketKey: '', marketAt: 0,
                 aiKey: '', aiNext: 0};
      this.session = s;
      await this.serial(s, () => this.write(s, Uint8Array.of(72))); // H
      check();
      s.ready = true;
      this.retryCount = 0;
      this.onConnection(true);
      this.onStatus('蓝牙伴侣已连接');
      this.poll(s);
    }

    disconnect() {
      this.wanted = false;
      clearTimeout(this.retryTimer);
      for (const job of this.aiJobs.values()) job.controller.abort();
      this.closed();
      this.onStatus('已停止蓝牙同步');
    }

    closed() {
      const s = this.session;
      this.session = null;
      ++this.epoch;
      if (s) {
        clearTimeout(s.clock);
        if (s.marketCtrl) s.marketCtrl.abort();
      }
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      this.onConnection(false);
      if (!this.wanted || !this.device) return;
      this.onStatus('蓝牙已断开，正在等待重连…');
      clearTimeout(this.retryTimer);
      const backoff = Math.min(12000, 1000 * Math.pow(2, Math.min(this.retryCount++, 4)));
      this.retryTimer = setTimeout(async () => {
        if (!this.wanted || this.session) return;
        const ticket = ++this.epoch;
        try { await this.open(this.device, ticket); }
        catch (_) { if (ticket === this.epoch && this.wanted) this.closed(); }
      }, backoff);
    }

    serial(s, task) {
      const result = s.tail.then(async () => {
        if (this.session !== s || !this.wanted) throw abort();
        try { return await task(); }
        catch (error) {
          if (s.ready && this.session === s && !error.peerRejected) this.closed();
          throw error;
        }
      });
      s.tail = result.catch(noop);
      return result;
    }

    async write(s, data) {
      if (this.session !== s || !this.wanted) throw abort();
      if (data.length > 20) throw new Error('蓝牙分片超长');
      const fn = s.rx.writeValueWithResponse || s.rx.writeValue;
      if (!fn || (s.rx.properties && s.rx.properties.write === false)) throw new Error('设备不支持带回执的写入');
      await deadline(fn.call(s.rx, data), 9000, '蓝牙写入未获回执');
      s.lastAck = Date.now();
    }

    async readState(s, opcode = 112) {
      // On iOS the page may have been suspended while the system HID/AMS
      // connection remained alive. Renew the app lease before starting a snapshot.
      if (s.ready && Date.now() - s.lastAck > 9500) await this.write(s, Uint8Array.of(72));
      const body = [];
      let id = 0, total = 0;
      do {
        const packet = new Uint8Array(7), view = new DataView(packet.buffer);
        packet[0] = opcode; // p or w: short response even at ATT MTU 23
        view.setUint32(1, id, true); view.setUint16(5, body.length, true);
        await this.write(s, packet);
        const data = toBytes(await deadline(s.tx.readValue(), 9000, '蓝牙读取超时'));
        if (data.length < 10 || data.length > 20 || data[0] !== 74) throw new Error('设备返回了无效的协议页');
        const head = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const gotId = head.getUint32(1, true), gotTotal = head.getUint16(5, true);
        if (!gotId || gotTotal < 1 || gotTotal > MAX || head.getUint16(7,true) !== body.length ||
            body.length + data.length - 9 > gotTotal || (body.length && (gotId !== id || total !== gotTotal))) {
          throw new Error('蓝牙数据顺序异常');
        }
        id = gotId; total = gotTotal;
        for (const byte of data.subarray(9)) body.push(byte);
      } while (body.length < total);
      const state = JSON.parse(decode.decode(Uint8Array.from(body)));
      if (state.v !== 1) throw new Error('伴侣固件协议版本不符');
      return state;
    }

    send(object, session = this.session) {
      if (!session || !session.ready) return Promise.reject(abort());
      const raw = encode.encode(JSON.stringify(object));
      if (!raw.length || raw.length > MAX) return Promise.reject(new Error('消息超出板端大小限制'));
      const id = this.nextId = ((this.nextId + 1) >>> 0) || 1;
      return this.serial(session, async () => {
        if (Date.now() - session.lastAck > 9500) await this.write(session, Uint8Array.of(72));
        for (let offset = 0; offset < raw.length; offset += PAGE) {
          const part = raw.subarray(offset, offset + PAGE);
          const packet = new Uint8Array(9 + part.length), head = new DataView(packet.buffer);
          packet[0] = 68; head.setUint32(1, id, true); head.setUint16(5, raw.length, true);
          head.setUint16(7, offset, true); packet.set(part, 9);
          try {
            await this.write(session, packet);
          } catch (error) {
            if (offset + part.length !== raw.length || !session.device.gatt.connected) throw error;
            // The final ACK also reports application-level rejection. A swipe,
            // closed page, or busy question must not tear down an intact link.
            // The next independent poll verifies the radio rather than replaying D.
            const details = {
              market:'小屏未采用这条行情，将按当前标的更新',
              answer:'这条回复未被小屏接收，可在手机查看',
              ask:'小屏未接收新问题，如已有问题，请等待回复后再试',
              watch:'自选未保存，请核对代码并重试'
            };
            const rejected = new Error(details[object.op] || '设备未接受这条消息');
            rejected.peerRejected = true;
            throw rejected;
          }
        }
      });
    }

    async poll(s) {
      try {
        const state = await this.serial(s, () => this.readState(s));
        if (this.session !== s) return;
        this.considerMarket(s, state.market);
        this.considerAI(s, state.ai, state.boot);
      } catch (error) {
        if (this.session === s) { this.onStatus(error.message); this.closed(); }
        return;
      }
      if (this.session === s) s.clock = setTimeout(() => this.poll(s), 1600);
    }

    considerMarket(s, request) {
      const key = request && JSON.stringify([request.generation,request.symbol,request.crypto,request.intraday]);
      if (key !== s.marketKey) {
        if (s.marketCtrl) s.marketCtrl.abort();
        s.marketKey = key; s.marketCtrl = null; s.marketAt = 0;
      }
      if (!request || s.marketCtrl || Date.now() < s.marketAt) return;
      const controller = s.marketCtrl = new AbortController();
      (async () => {
        const {generation, symbol, crypto, intraday} = request;
        let result;
        try {
          if (!this.market) throw new Error('手机行情服务尚未配置');
          const data = await this.market(request, {signal: controller.signal});
          if (!data || !data.source || !data.interval || !data.date ||
              !Array.isArray(data.points) || !data.points.length || data.points.length > 64 ||
              !data.points.every(p => Number.isFinite(p) && p > 0) || !(Number.isFinite(data.price) && data.price > 0))
            throw new Error('来源未返回有效的价格走势');
          result = {ok:true, points:data.points, price:data.price,
                    change_pct:Number.isFinite(data.change_pct) ? data.change_pct : null,
                    name:limited(data.name || '',71), source:limited(data.source,39),
                    interval:limited(data.interval,23), date:limited(data.date,23),
                    change_basis:limited(data.change_basis || '',31), message:limited(data.message || '',95)};
        } catch (error) { result = {ok:false, message:limited(error.message || '手机获取行情失败', 90)}; }
        if (controller.signal.aborted || this.session !== s || s.marketKey !== key) return;
        await this.send({...result, op:'market', generation, symbol, crypto, intraday}, s);
        s.marketAt = Date.now() + (result.ok ? 30000 : 15000);
        if (result.ok) this.onStatus('已同步 ' + symbol + '  ' + (result.date || ''));
        else this.onStatus(result.message);
      })().catch(error => {
        if (this.session === s && s.marketKey === key) {
          s.marketAt = Date.now() + 15000;
          this.onStatus(error.message);
        }
      })
        .finally(() => { if (s.marketCtrl === controller) s.marketCtrl = null; });
    }

    considerAI(s, req, boot) {
      if (!req || !Number.isInteger(req.id) || req.id < 1 || req.id > 0xffffffff ||
          typeof req.question !== 'string' || !req.question.trim() || encode.encode(req.question).length > 384) {
        s.aiKey = ''; return;
      }
      const key = JSON.stringify([s.device.id, boot || 0, req.id, req.question]);
      if (s.aiKey !== key) { s.aiKey = key; s.aiNext = 0; }
      if (this.aiJobs.has(key) || Date.now() < s.aiNext) return;
      const controller = new AbortController(), job = {controller};
      this.aiJobs.set(key, job);
      (async () => {
        let response;
        try {
          const {fresh,record} = await this.journal.claim(key);
          if (!fresh && !record.response && Date.now() - record.started < 120000) {
            s.aiNext = Date.now() + 4000; return;
          }
          if (!fresh) {
            response = record.response || {op:'answer', id:req.id, ok:false, message:'上次请求结果未知，请手动重试'};
          } else {
            try {
              if (controller.signal.aborted || !this.wanted || this.session !== s || s.aiKey !== key) throw abort();
              if (!this.ai) throw new Error('尚未配置手机 DeepSeek 服务');
              const previous = this.histories.get(s.device.id) || [];
              const answer = await this.ai(req.question, {history:previous.slice(), signal:controller.signal});
              if (typeof answer !== 'string' || !answer.trim()) throw new Error('DeepSeek 返回空回复');
              response = {op:'answer', id:req.id, ok:true, answer:limited(answer.trim(),2048)};
              this.histories.set(s.device.id, previous.concat([{question:req.question, answer:response.answer}]).slice(-2));
            } catch (error) {
              response = {op:'answer', id:req.id, ok:false, message:limited(error.message || '手机提问失败', 90)};
            }
            await this.journal.finish(key, response);
          }
        } catch (error) {
          response = {op:'answer', id:req.id, ok:false, message:limited(error.message || '浏览器存储不可用',90)};
        }
        if (this.wanted && this.device === s.device && !this.shownAnswers.has(key)) {
          this.shownAnswers.add(key);
          this.onAnswer(req.question, response.answer || response.message, response.ok);
        }
        if (this.session === s && s.aiKey === key) {
          await this.send(response, s);
          s.aiNext = Date.now() + 6000;
        }
      })().catch(error => {
        if (this.session === s && s.aiKey === key) {
          s.aiNext = Date.now() + 6000;
          this.onStatus(error.message);
        }
      })
        .finally(() => this.aiJobs.delete(key));
    }

    pushWatch(stocks, pairs) {
      const lists = [stocks, pairs];
      const patterns = [/^[0-9]{6}\.(SH|SZ|BJ)$/, /^[A-Z0-9]{1,16}-[A-Z0-9]{1,12}(?:-SWAP)?$/];
      if (lists.some((list,i) => !Array.isArray(list) || list.length > 24 ||
          list.some(code => typeof code !== 'string' || code.length > 31 || !patterns[i].test(code)))) {
        return Promise.reject(new Error('请检查自选代码，每组最多 24 项'));
      }
      return this.send({op:'watch', stocks:[...new Set(stocks)], pairs:[...new Set(pairs)]});
    }

    async readWatch() {
      const s = this.session;
      if (!s || !s.ready) throw abort();
      const result = await this.serial(s, () => this.readState(s, 119)); // w
      if (!result.watch || !Array.isArray(result.watch.stocks) || !Array.isArray(result.watch.pairs))
        throw new Error('未能读取设备原有自选');
      return {stocks:result.watch.stocks.slice(), pairs:result.watch.pairs.slice()};
    }

    ask(text) {
      const question = String(text || '').trim();
      if (!question || encode.encode(question).length > 384)
        return Promise.reject(new Error('问题必须是 1–384 个 UTF-8 字节'));
      if (this.session && this.session.aiKey)
        return Promise.reject(new Error('小屏正在处理上一个问题，请等待回复后再试'));
      return this.send({op:'ask', question});
    }
  }
  if (typeof window !== 'undefined') window.PhoneLink = PhoneLink;
  if (typeof module !== 'undefined' && module.exports) module.exports = PhoneLink;
})();
