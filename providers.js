/* Market providers are contacted directly by the phone. */
(() => {
  const stockBase = 'https://web.ifzq.gtimg.cn/appstock/app/';
  const okxBase = 'https://www.okx.com/api/v5/market/';
  const errors = {401:'密钥未通过验证',402:'账户余额不足',403:'服务拒绝了请求',429:'请求频繁，请稍后再试'};

  async function json(url, label, signal, options = {}, timeout = 14000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
    }
    const timer = setTimeout(abort, timeout);
    try {
      const r = await fetch(url, {...options, signal:controller.signal, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer'});
      if (!r.ok) throw new Error(label + '：' + (errors[r.status] || 'HTTP ' + r.status));
      return await r.json();
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (e.name === 'AbortError') throw new Error(label + '响应超时');
      if (e instanceof TypeError || e instanceof SyntaxError) throw new Error('手机未能读取' + label + '，请检查网络');
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  function price(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error('行情价格无效');
    return n;
  }
  function ascending(values) {
    if (!values.length || values.some((x,i) => i && x <= values[i-1])) throw new Error('行情时间顺序有误');
  }
  function day(s) {
    const v = String(s).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
    const t = Date.parse(v + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(t) || new Date(t).toISOString().slice(0,10) !== v) throw new Error('行情日期无效');
    return v;
  }
  function clock(s) {
    if (!/^([01]\d|2[0-3])[0-5]\d$/.test(s)) throw new Error('行情时刻无效');
    return s.slice(0,2) + ':' + s.slice(2);
  }
  function limitText(input, limit) {
    let size=0, text='';
    for (const c of String(input)) {
      const n = new TextEncoder().encode(c).length;
      if (size+n > limit) break;
      text += c; size += n;
    }
    return text;
  }
  async function stock(req, signal) {
    const {symbol,intraday} = req;
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) throw new Error('股票代码格式有误');
    const code = symbol.slice(-2).toLowerCase()+symbol.slice(0,6);
    const path = intraday ? 'minute/query?code='+code : 'fqkline/get?param='+code+',day,,,45,';
    const doc = await json(stockBase+path,'腾讯行情',signal);
    const obj = doc.data && doc.data[code];
    if (Number(doc.code) !== 0 || !obj) throw new Error('腾讯暂无该证券行情');
    const qt = (obj.qt || {})[code] || [];
    const known = qt[2] === symbol.slice(0,6);
    const stamp = known ? String(qt[30] || '') : '';
    let points, prior = null, date;
    if (intraday) {
      if (!Array.isArray(obj.data && obj.data.data) || !obj.data.data.length) throw new Error('暂无该证券分时数据');
      date = day(obj.data.date);
      const rows = obj.data.data.map(r=>r.trim().split(/\s+/));
      const times = rows.map(r=>clock(r[0]));
      ascending(times);
      points = rows.map(r=>price(r[1]));
      if (points.length > 64) points = Array.from({length:64},(_,i)=>points[Math.floor(i*(points.length-1)/63)]);
      if (stamp.slice(0,8) === date.replace(/-/g,'') && Number(qt[4])>0) prior = price(qt[4]);
      date += ' '+times[times.length-1];
    } else {
      const rows = (obj.day || []).slice(-45);
      if (!rows.length) throw new Error('暂无该证券日线数据');
      const dates = rows.map(r=>day(r[0]));
      ascending(dates);
      points = rows.map(r=>price(r[2]));
      date = dates[dates.length-1];
      prior = points.length>1 ? points[points.length-2] : null;
      if (/^\d{14}$/.test(stamp) && Number(qt[3])>0 && Number(qt[4])>0) {
        const quoteDay = day(stamp.slice(0,8));
        if (quoteDay >= date) {
          if (quoteDay > date) points.push(price(qt[3]));
          else points[points.length-1] = price(qt[3]);
          prior = price(qt[4]);
          date = quoteDay+' '+clock(stamp.slice(8,12));
        }
      }
    }
    const name = limitText(known && qt[1] || symbol,71);
    return {points,prior,date,name,source:'腾讯行情'};
  }
  async function cryptoQuote(req, signal) {
    const {symbol,intraday} = req;
    if (!/^[A-Z0-9]+(?:-[A-Z0-9]+){1,3}$/.test(symbol) || symbol.length>31) throw new Error('交易对格式有误');
    const bar = intraday?'15m':'1D';
    const doc = await json(okxBase+'candles?instId='+symbol+'&bar='+bar+'&limit=45','欧易',signal);
    if (String(doc.code)!=='0' || !Array.isArray(doc.data) || doc.data.length < 2) throw new Error('欧易暂无该交易对走势');
    const rows = doc.data.slice(0,45).reverse();
    const times = rows.map(r=>Number(r[0]));
    if (times.some(t=>!Number.isSafeInteger(t) || t<1e12 || t>=1e13)) throw new Error('欧易行情时间无效');
    ascending(times);
    const points = rows.map(r=>price(r[4]));
    let ts = times[times.length-1], showTime = intraday;
    try {
      const ticker = await json(okxBase+'ticker?instId='+symbol,'欧易',signal,{},5500);
      const q = (ticker.data||[])[0];
      if (q && q.instId===symbol && Number.isSafeInteger(Number(q.ts)) && +q.ts>=ts && +q.ts<ts+(intraday?900000:86400000)) {
        points[points.length-1] = price(q.last);
        ts = +q.ts;
        showTime = true;
      }
    } catch (e) { if (signal && signal.aborted) throw e; }
    const date = new Date(ts+8*3600000).toISOString().replace('T',' ').slice(0,showTime?16:10);
    return {points,prior:points[points.length-2],date,name:symbol,source:'欧易 OKX'};
  }
  async function market(req,{signal}={}) {
    const {points,prior,date,name,source} = await (req.crypto ? cryptoQuote(req,signal) : stock(req,signal));
    const last = points[points.length-1];
    return {points,price:last,change_pct:prior ? (last/prior-1)*100 : null,date,name,source,
      interval:req.intraday ? (req.crypto?'15分钟':'分时') : '日线',
      change_basis:req.crypto && req.intraday ? '较上根15分收盘' : '较前日收盘'};
  }
  async function ai(question,key,{history=[],signal}={}) {
    if (!key.trim()) throw new Error('请在手机伴侣的 DeepSeek 页填入密钥');
    const messages=[{role:'system',content:'请用简洁中文回答，方便在小屏上阅读。'}];
    for (const pair of history.slice(-2)) messages.push({role:'user',content:pair.question},{role:'assistant',content:pair.answer});
    messages.push({role:'user',content:question});
    const doc=await json('https://api.deepseek.com/chat/completions','DeepSeek',signal,{
      method:'POST',headers:{Authorization:'Bearer '+key.trim(),'Content-Type':'application/json'},
      body:JSON.stringify({model:'deepseek-flash',thinking:{type:'disabled'},messages,stream:false,max_tokens:384})},55000);
    const answer = doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('DeepSeek 返回了空回复');
    return limitText(answer.trim(),2048);
  }
  window.PhoneProviders = {market,ai};
})();
