/* Phone-to-board GATT protocol v1. Loaded directly as a classic script. */
(() => {
  'use strict';
  const SERVICE = '905d0001-664a-4b83-9f54-e53e5ecff006';
  const RX = SERVICE.replace('0001-', '0002-'), TX = SERVICE.replace('0001-', '0003-');
  const NOTIFY = SERVICE.replace('0001-', '0004-');
  const encode = new TextEncoder(), decode = new TextDecoder('utf-8', {fatal: true});
  const MAX = 8192, PAGE = 11, noop = () => {};
  const abort = () => new Error('蓝牙连接已结束');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const permanent = message => Object.assign(new Error(message), {permanent:true});

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
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    // Some native bridges serialize binary as a byte array or Node-style Buffer.
    const sequence = value && value.type === 'Buffer' ? value.data : value;
    if (sequence && typeof sequence === 'object' && Number.isInteger(sequence.length) &&
        sequence.length >= 0 && sequence.length <= 512) {
      const bytes = Array.from(sequence);
      if (bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(bytes);
    }
    throw permanent('蓝牙读取返回了不支持的数据格式 ' + Object.prototype.toString.call(value));
  }

  function deadline(promise, ms, message) {
    let clock;
    return Promise.race([promise, new Promise((_, reject) => {
      clock = setTimeout(() => reject(Object.assign(new Error(message), {timedOut:true})), ms);
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
      this.onPhase = options.onPhase || noop;
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
      this.readOnlyDevices = new Set();
      this.native = new Map();
      this.published = false;
      this.phaseName = 'stopped';
      this.lastPhaseText = '';
      this.lost = null;
      this.authorizedDevice = null;
      this.findAuthorizedDevice();
      if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.disconnect());
    }
    get connected() { return Boolean(this.session && this.session.ready); }

    // Populate the cache before a tap. The picker must be called directly from the
    // user's gesture even when enumeration is slow, unavailable or returns nothing.
    async findAuthorizedDevice() {
      if (!this.bluetooth || typeof this.bluetooth.getDevices !== 'function') return;
      try {
        let saved;
        try { saved = localStorage.getItem('waveshare-ble-device'); } catch (_) {}
        const devices = await this.bluetooth.getDevices();
        if (this.device || this.wanted) return;
        const matches = devices.filter(d => d.name === 'Waveshare Companion');
        this.authorizedDevice = devices.find(d => saved && d.id === saved) ||
                                (matches.length === 1 ? matches[0] : null);
      } catch (_) { /* Enumeration is optional; the foreground picker remains available. */ }
    }

    phase(name, text) {
      this.phaseName = name;
      this.lastPhaseText = text;
      this.onPhase(name, text);
      this.onStatus(text);
    }

    check(ticket) { if (ticket !== this.epoch || !this.wanted) throw abort(); }

    async nativeOp(device, ticket, stage, ms, operation) {
      this.check(ticket);
      // A timeout rejects our wait, not the platform operation. Retain its real
      // promise across attempts so a late callback cannot overlap another ATT call.
      const deviceKey = device.id || device;
      const earlier = this.native.get(deviceKey);
      if (earlier) {
        try { await deadline(earlier, 10000, stage + '：上次蓝牙操作仍未结束，请重新打开网页'); }
        catch (error) { if (error.timedOut) error.permanent = true; throw error; }
      }
      this.check(ticket);
      const raw = Promise.resolve().then(() => { this.check(ticket); return operation(); });
      const settled = raw.then(noop, noop);
      this.native.set(deviceKey, settled);
      settled.then(() => { if (this.native.get(deviceKey) === settled) this.native.delete(deviceKey); });
      try {
        const value = await deadline(raw, ms, '等待 ' + ms / 1000 + ' 秒后仍无回执');
        this.check(ticket);
        return value;
      } catch (cause) {
        this.check(ticket);
        const reason = ((cause && cause.name && cause.name !== 'Error') ? cause.name + ' ' : '') +
                       ((cause && cause.message) || String(cause));
        const error = new Error(stage + '：' + reason);
        error.nativeName = cause && cause.name;
        error.timedOut = Boolean(cause && cause.timedOut);
        error.permanent = Boolean(cause && (cause.permanent || ['SecurityError','NotAllowedError',
          'NotFoundError','NotSupportedError'].includes(cause.name)));
        throw error;
      }
    }

    async connect({choose = false} = {}) {
      if (this.connected) return;
      if (this.connecting) return this.connecting;
      if (!this.bluetooth) {
        const error = permanent('请在 iPhone 的 Bluefy 中通过 HTTPS 打开此页');
        this.phase('failed',error.message);
        throw error;
      }
      this.wanted = true;
      this.retryCount = 0;
      clearTimeout(this.retryTimer);
      this.phase('connecting','正在准备蓝牙连接…');
      const ticket = ++this.epoch;
      const work = (async () => {
        let target = !choose && (this.device || this.authorizedDevice);
        if (!target) {
          this.phase('connecting','选择 Waveshare Companion，并允许蓝牙连接');
          try {
            const filter = choose ? {acceptAllDevices:true} : {filters:[{services:[SERVICE]}]};
            target = await this.bluetooth.requestDevice({...filter,optionalServices:[SERVICE]});
          } catch (error) {
            if (error.name === 'NotFoundError') throw new Error('未选到蓝牙屏。请在小屏打开 Bluefy 配对，再点「显示所有附近设备」。');
            if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
              throw new Error('Bluefy 未获准搜索。请在 iPhone「设置 → 隐私与安全性 → 蓝牙」允许 Bluefy，再点连接。');
            }
            throw error;
          }
        }
        if (!this.wanted || ticket !== this.epoch) throw abort();
        this.device = target;
        await this.open(target, ticket);
        try { localStorage.setItem('waveshare-ble-device', target.id); } catch (_) {}
      })();
      this.connecting = work;
      try { await work; }
      catch (error) {
        if (this.epoch === ticket) {
          this.closed(error, false);
        }
        throw error;
      } finally { if (this.connecting === work) this.connecting = null; }
    }

    async open(device, ticket) {
      this.phase('connecting','正在连接蓝牙设备…');
      const op = (label,ms,fn) => this.nativeOp(device,ticket,label,ms,fn);
      const server = await op('连接设备',20000,async () => {
        const result = await device.gatt.connect();
        if (ticket !== this.epoch && !this.wanted && device.gatt.connected) device.gatt.disconnect();
        return result;
      });
      const service = await op('查找伴侣服务',8000,() => server.getPrimaryService(SERVICE));
      const rx = await op('查找写入特征',8000,() => service.getCharacteristic(RX));
      const tx = await op('查找读取特征',8000,() => service.getCharacteristic(TX));
      const s = {device, ticket, rx, tx, ready: false, tail: Promise.resolve(), lastAck: 0, marketKey: '', marketAt: 0,
                 aiKey: '', aiNext: 0};
      this.session = s;
      this.lost = () => {
        if (this.session === s && s.ready && ticket === this.epoch && !device.gatt.connected)
          this.closed(new Error('iPhone 报告蓝牙设备已断开'));
      };
      device.addEventListener('gattserverdisconnected', this.lost);
      this.phase('verifying','已找到设备，正在验证双向蓝牙通信…');
      await this.serial(s, () => this.retryRead(s, '握手', () => this.write(s, Uint8Array.of(72))));
      await this.serial(s, () => this.tryNotifications(s, service));
      const first = await this.serial(s, () => this.snapshot(s));
      this.check(ticket);
      s.ready = true;
      s.verifiedAt = Date.now(); s.stableReads = 1;
      this.phase('connected','蓝牙伴侣已连接，双向通信正常');
      if (!this.published) { this.published = true; this.onConnection(true); }
      if (this.session !== s) return;
      this.considerMarket(s, first.market);
      this.considerAI(s, first.ai, first.boot);
      s.clock = setTimeout(() => this.poll(s), 1600);
    }

    disconnect() {
      this.wanted = false;
      clearTimeout(this.retryTimer);
      for (const job of this.aiJobs.values()) job.controller.abort();
      this.connecting = null;
      this.closed(null, false);
    }

    closed(error, retry = true) {
      const s = this.session;
      this.session = null;
      ++this.epoch;
      clearTimeout(this.retryTimer);
      if (s) {
        clearTimeout(s.clock);
        this.detachNotifications(s);
        if (s.marketCtrl) s.marketCtrl.abort();
      }
      if (this.device && this.lost) this.device.removeEventListener('gattserverdisconnected',this.lost);
      this.lost = null;
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      if (this.published) { this.published = false; this.onConnection(false); }
      const detail = error && (error.message || String(error));
      if (!retry || !this.wanted || !this.device || (error && error.permanent) || this.retryCount >= 3) {
        this.wanted = false;
        this.phase(error ? 'failed' : 'stopped', detail ? '同步已停止。' + detail : '已停止蓝牙同步');
        return;
      }
      const backoff = 1500 * Math.pow(2, this.retryCount++);
      this.phase('recovering', (detail || '蓝牙已断开') + '。正在重连（' + this.retryCount + '/3）');
      const waiting = this.epoch;
      this.retryTimer = setTimeout(async () => {
        if (waiting !== this.epoch || !this.wanted || this.session || this.connecting) return;
        const ticket = ++this.epoch;
        const work = this.open(this.device, ticket);
        this.connecting = work;
        try { await work; }
        catch (error) { if (ticket === this.epoch && this.wanted) this.closed(error); }
        finally { if (this.connecting === work) this.connecting = null; }
      }, backoff);
    }

    serial(s, task) {
      const result = s.tail.then(async () => {
        if (this.session !== s || !this.wanted) throw abort();
        try { return await task(); }
        catch (error) {
          if (s.ready && this.session === s && !error.peerRejected) this.closed(error);
          throw error;
        }
      });
      s.tail = result.catch(noop);
      return result;
    }

    async write(s, data) {
      if (this.session !== s || !this.wanted) throw abort();
      if (data.length > 20) throw new Error('蓝牙分片超长');
      const fn = s.legacyWrite ? s.rx.writeValue : s.rx.writeValueWithResponse || s.rx.writeValue;
      if (!fn || (s.rx.properties && s.rx.properties.write === false)) throw permanent('设备不支持带回执的写入');
      const stage = '蓝牙写入 ' + String.fromCharCode(data[0]);
      try {
        await this.nativeOp(s.device,s.ticket,stage,9000,() => fn.call(s.rx, data));
      } catch (error) {
        const props = s.rx.properties || {};
        // Probe only with a read selector or greeting. Never repeat a D write
        // (watch lists, paid questions, answers) after an ambiguous result.
        if (data[0] === 68 || s.triedLegacy || error.timedOut || fn !== s.rx.writeValueWithResponse ||
            typeof s.rx.writeValue !== 'function' || props.write !== true || props.writeWithoutResponse !== false ||
            !(error.nativeName === 'NotSupportedError' || /not implemented/i.test(error.message))) throw error;
        s.triedLegacy = true;
        await this.nativeOp(s.device,s.ticket,stage + '（兼容模式）',9000,() => s.rx.writeValue(data));
        s.legacyWrite = true;
      }
      s.lastAck = Date.now();
    }

    async retryRead(s, stage, operation) {
      for (let attempt = 0; ; attempt++) {
        this.check(s.ticket);
        try { return await operation(); }
        catch (error) {
          this.check(s.ticket);
          if (error.permanent || error.timedOut || !s.device.gatt.connected || attempt >= 2) throw error;
          this.phase('recovering',stage + '暂未成功，正在原连接重试。' + (error.message || error));
          await wait(attempt === 0 ? 220 : 650);
        }
      }
    }

    detachNotifications(s) {
      if (s.notice && s.noticeHandler)
        s.notice.removeEventListener('characteristicvaluechanged', s.noticeHandler);
      if (s.waitingNotice) s.waitingNotice.finish(null);
      s.notice = s.noticeHandler = s.waitingNotice = null;
    }

    async tryNotifications(s, service) {
      if (this.readOnlyDevices.has(s.device.id)) return;
      try {
        const ch = await this.nativeOp(s.device,s.ticket,'查找可选通知通道',4000,
          () => service.getCharacteristic(NOTIFY));
        if (!ch || typeof ch.startNotifications !== 'function' || typeof ch.addEventListener !== 'function') return;
        s.notice = ch;
        s.noticeHandler = event => {
          const waiting = s.waitingNotice;
          if (!waiting || this.session !== s || s.ticket !== this.epoch || !s.notice) return;
          try {
            const bytes = toBytes(event.target.value);
            if (bytes.length < 10 || bytes.length > 20 || bytes[0] !== 74) return;
            const header = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
            const id = header.getUint32(1,true), total = header.getUint16(5,true), at = header.getUint16(7,true);
            if (!id || !total || total > MAX || at !== waiting.offset || at + bytes.length - 9 > total) return;
            if (waiting.id) {
              if (id !== waiting.id || total !== waiting.total) return;
            } else if (s.lastFrameId) {
              // A previous first-page notification can arrive during the next poll.
              const distance = (id - s.lastFrameId) >>> 0;
              if (!distance || distance >= 0x80000000) return;
            }
            waiting.finish(bytes.slice()); // The native characteristic buffer can be reused.
          } catch (_) { /* Ignore malformed or unrelated events; the read channel is the fallback. */ }
        };
        ch.addEventListener('characteristicvaluechanged', s.noticeHandler);
        await this.nativeOp(s.device,s.ticket,'订阅可选通知通道',5500,() => ch.startNotifications());
      } catch (error) {
        this.detachNotifications(s);
        this.check(s.ticket);
        if (!s.device.gatt.connected) throw error;
        if (error.timedOut) this.readOnlyDevices.add(s.device.id);
        // Earlier firmware only advertises the encrypted RX and TX characteristics.
      }
    }

    async noticePage(s, packet, expectedId, total, offset) {
      // Install the waiter first: the board can notify before the acknowledged write returns.
      let finish;
      const page = new Promise(resolve => { finish = resolve; });
      const waiting = {id:expectedId, total, offset, finish};
      s.waitingNotice = waiting;
      try {
        const request = packet.slice();
        request[0] = packet[0] === 119 ? 109 : 110; // m for watch, n for state
        await this.write(s,request);
        const bytes = await deadline(page,2200,'等待通知页超时');
        if (!bytes) throw abort();
        return bytes;
      } finally { if (s.waitingNotice === waiting) s.waitingNotice = null; }
    }

    async snapshot(s, opcode = 112) {
      // On iOS the page may have been suspended while the system HID/AMS
      // connection remained alive. Renew the app lease before starting a snapshot.
      if (s.lastAck && Date.now() - s.lastAck > 9500) await this.write(s, Uint8Array.of(72));
      const body = [];
      let id = 0, total = 0;
      do {
        const packet = new Uint8Array(7), view = new DataView(packet.buffer);
        packet[0] = opcode; // p or w: short response even at ATT MTU 23
        view.setUint32(1, id, true); view.setUint16(5, body.length, true);
        const pageName = (opcode === 119 ? '自选' : '状态') + '页，偏移 ' + body.length;
        const data = await this.retryRead(s, pageName, async () => {
          let bytes;
          if (s.notice) {
            try { bytes = await this.noticePage(s,packet,id,total,body.length); }
            catch (error) {
              this.check(s.ticket);
              if (!s.device.gatt.connected) throw error;
              this.detachNotifications(s);
              this.readOnlyDevices.add(s.device.id);
              this.phase('recovering','通知通道未完成，改用同一连接读取。' + error.message);
              if (body.length) return null; // Restart at page zero rather than mix two snapshots.
            }
          }
          if (!bytes) {
            await this.write(s, packet);
            const value = await this.nativeOp(s.device,s.ticket,'蓝牙读取' + pageName,9000,() => s.tx.readValue());
            bytes = toBytes(value == null ? s.tx.value : value);
          }
          if (bytes.length < 10 || bytes.length > 20 || bytes[0] !== 74)
            throw new Error(pageName + '：协议头无效，收到 ' + bytes.length + ' 字节');
          const head = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          const fid = head.getUint32(1,true), size = head.getUint16(5,true), offset = head.getUint16(7,true);
          if (!fid || !size || size > MAX || offset !== body.length || offset + bytes.length - 9 > size ||
              (body.length && (id !== fid || total !== size))) {
            throw new Error(pageName + '：返回偏移 ' + offset + '，快照长度 ' + size + '，数据顺序异常');
          }
          id = fid; total = size; s.lastFrameId = fid;
          return bytes;
        });
        if (!data) { id = total = 0; body.length = 0; }
        else for (const byte of data.subarray(9)) body.push(byte);
      } while (!total || body.length < total);
      let state;
      try { state = JSON.parse(decode.decode(Uint8Array.from(body))); }
      catch (error) { throw permanent('设备状态无法解码：' + error.message); }
      if (!state || state.v !== 1) throw permanent('伴侣固件协议版本不符');
      if (opcode === 112 && (!Object.prototype.hasOwnProperty.call(state,'ai') || !Object.prototype.hasOwnProperty.call(state,'market')))
        throw permanent('蓝牙状态缺少 AI 或行情字段，请核对固件版本');
      if (opcode === 119 && (!state.watch || !Array.isArray(state.watch.stocks) || !Array.isArray(state.watch.pairs)))
        throw permanent('设备返回的自选清单格式不正确，请核对固件版本');
      if (s.ready && this.phaseName === 'recovering') this.phase('connected','已在原蓝牙连接恢复同步');
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
            if (error.timedOut || error.permanent || offset + part.length !== raw.length || !session.device.gatt.connected) throw error;
            // The final ACK also reports application-level rejection. A swipe,
            // closed page, or busy question must not tear down an intact link.
            // The next independent poll verifies the radio rather than replaying D.
            const details = {
              market:'小屏未采用这条行情，将按当前标的更新',
              answer:'这条回复未被小屏接收，可在手机查看',
              ask:'小屏未接收新问题，如已有问题，请等待回复后再试',
              watch:'自选未保存，请核对代码并重试'
            };
            const rejected = new Error((details[object.op] || '设备未接受这条消息') + '。' + (error.message || error));
            rejected.peerRejected = true;
            throw rejected;
          }
        }
      });
    }

    async poll(s) {
      try {
        const state = await this.serial(s, () => this.snapshot(s));
        if (this.session !== s) return;
        if (++s.stableReads >= 3 && Date.now() - s.verifiedAt >= 10000) this.retryCount = 0;
        this.considerMarket(s, state.market);
        this.considerAI(s, state.ai, state.boot);
      } catch (error) {
        if (this.session === s) this.closed(error);
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
      const result = await this.serial(s, () => this.snapshot(s, 119)); // w
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
