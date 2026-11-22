(() => {
  const el = id => document.getElementById(id);
  let connected=false, connecting=false, phase='stopped', saving=false, loading=false, asking=false, listsReady=false, session=0, answerTimer;
  const phases={connecting:'连接中',verifying:'正在验证',recovering:'恢复同步中',connected:'已连接',stopped:'未连接',failed:'连接失败'};
  const traceKey='waveshare-connection-trace-v4';
  let traceRows=[], lastIssue='';
  try {
    const saved=JSON.parse(localStorage.getItem(traceKey) || '{}');
    if(Array.isArray(saved.rows)) traceRows=saved.rows.filter(s=>typeof s==='string').slice(-12);
    if(typeof saved.last==='string') lastIssue=saved.last;
  } catch (_) {}
  function renderTrace() {
    el('traceRows').textContent=traceRows.join('\n');
    el('traceLatest').textContent=traceRows.length ? traceRows[traceRows.length-1].slice(9) : '尚无记录';
    el('traceLast').hidden=!lastIssue;
    el('traceLast').textContent=lastIssue ? '最近一次异常　'+lastIssue : '';
    el('traceCopy').disabled=!traceRows.length&&!lastIssue;
  }
  function recordTrace(event) {
    // Store only app-defined stages, standardized platform error names and numeric
    // status. Native error text can include device identifiers and never goes here.
    let detail=event.stage;
    if(event.kind==='error') {
      const known=/^(?:[A-Za-z]{1,28}Error|Error|gattserverdisconnected)$/;
      const name=known.test(event.name||'') ? event.name : '';
      detail+='未完成';
      if(name==='gattserverdisconnected') detail+=' · 系统报告蓝牙断开';
      else if(name && name!=='Error') detail+=' · '+name;
      if(event.timeout) detail+=' · 等待超时';
      if(event.code) detail+=' · 错误 '+event.code;
      if(event.directCode && event.directCode!==event.code) detail+=' · 首次错误 '+event.directCode;
    }
    if(event.inventory) detail+=' · '+event.inventory;
    const time=new Date();
    const stamp=[time.getHours(),time.getMinutes(),time.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
    const row=stamp+' '+detail;
    traceRows=[...traceRows.slice(-11),row];
    if(event.kind==='error') lastIssue=row;
    renderTrace();
    try { localStorage.setItem(traceKey,JSON.stringify({rows:traceRows,last:lastIssue})); } catch(_) {}
  }
  renderTrace();
  const link = new PhoneLink({
    onTrace: recordTrace,
    market: async (request,options) => {
      const quote=await PhoneProviders.market(request,options);
      if (!options.signal.aborted) showQuote(request,quote);
      return quote;
    },
    ai: (question,options) => PhoneProviders.ai(question,el('key').value,options),
    onConnection: value => {
      clearTimeout(answerTimer);
      connected=value; session++; listsReady=false; loading=false; saving=false; asking=false;
      el('quote').hidden=true;
      el('watchStatus').textContent=value?'正在读取小屏自选…':'连接后可编辑小屏自选。';
      if (value) loadLists();
      controls();
    },
    onPhase: (next,detail) => {
      phase=next;
      el('badge').textContent=phases[next]||'未连接';
      el('badge').classList.toggle('live',next==='connected');
      if(detail) el('status').textContent=detail;
      controls();
    },
    onStatus: message => { el('status').textContent=message; },
    onAnswer: (question,text,ok) => {
      clearTimeout(answerTimer); asking=false; el('asked').textContent=question; el('answer').textContent=text;
      el('reply').hidden=false; el('aiStatus').textContent=ok?'已收到 DeepSeek 回复。':'这次提问未完成。'; controls();
    }
  });

  function parse(text,crypto) {
    const found=[];
    const input=text.normalize('NFKC').toUpperCase();
    const pattern=crypto ? /(?:^|[^A-Z0-9./-])([A-Z0-9]{1,16})[-/]([A-Z0-9]{1,12})(-SWAP)?(?=$|[^A-Z0-9/-])/g :
      /(?:^|[^A-Z0-9])(?:(SH|SZ|BJ)[.:-]?)?(\d{6})(?:[.:-]?(SH|SZ|BJ))?(?=$|[^A-Z0-9])/g;
    for (const m of input.matchAll(pattern)) {
      if (crypto) found.push(m[1]+'-'+m[2]+(m[3]||''));
      else {
        if (m[1] && m[3] && m[1]!==m[3]) throw Error('同一代码的交易所前缀与后缀不一致');
        const exchange=m[1]||m[3]||(/^(4|8|92)/.test(m[2])?'BJ':/^[569]/.test(m[2])?'SH':'SZ');
        found.push(m[2]+'.'+exchange);
      }
    }
    const list=[...new Set(found)];
    if (input.trim() && !list.length) throw Error('没有识别到代码，请检查格式');
    if (list.length>24 || list.some(s=>s.length>31)) throw Error('请检查代码长度，每类最多 24 项');
    return list;
  }
  function preview(id) {
    const list=parse(el(id).value,id==='pairs');
    el(id+'Preview').textContent=listsReady ? (list.length?list.join(' · '):'空清单') : '';
    return list;
  }
  function controls() {
    const pending=phase==='recovering'||phase==='verifying'||phase==='connecting';
    const usable=connected&&phase==='connected';
    el('connect').textContent=pending?'取消连接':connected?'断开蓝牙屏':connecting?'连接中…':
                             link.needsReselect?'重置并重新选择':'连接蓝牙屏';
    el('connect').disabled=connecting&&!pending;
    el('reset').hidden=Boolean(pending||connecting||link.needsReselect||!navigator.bluetooth);
    el('resetHint').hidden=!connected;
    el('read').disabled=!usable||loading||saving;
    let valid=true;
    for (const id of ['stocks','pairs']) {
      el(id).disabled=!listsReady||saving||loading;
      try {preview(id);} catch(e) {el(id+'Preview').textContent=e.message; valid=false;}
    }
    el('save').disabled=!usable||!listsReady||loading||saving||!valid;
    el('ask').disabled=!usable||asking||!el('key').value.trim()||!el('question').value.trim();
  }
  async function loadLists() {
    const ticket=session; loading=true; controls();
    try {
      const lists=await link.readWatch();
      if (ticket!==session) return;
      el('stocks').value=lists.stocks.join('\n'); el('pairs').value=lists.pairs.join('\n');
      listsReady=true; el('watchStatus').textContent='已读取小屏自选。';
    } catch(e) {if(ticket===session) el('watchStatus').textContent=e.message;}
    finally {if(ticket===session) {loading=false; controls();}}
  }
  function showQuote(req,quote) {
    el('quote').hidden=false; el('quoteName').textContent=quote.name===req.symbol?req.symbol:quote.name+' · '+req.symbol;
    el('price').textContent=Number(quote.price.toPrecision(9)).toLocaleString('zh-CN',{maximumFractionDigits:10});
    const pct=quote.change_pct;
    el('change').textContent=Number.isFinite(pct)?(pct>=0?'+':'')+pct.toFixed(2)+'%':'';
    el('quoteMeta').textContent=[quote.source,quote.interval,quote.change_basis,quote.date].join(' · ');
    const chart=el('chart'), g=chart.getContext('2d');
    if(!g) return;
    const a=quote.points,w=chart.width,h=chart.height,min=Math.min(...a),max=Math.max(...a);
    g.clearRect(0,0,w,h); g.beginPath(); g.lineWidth=3; g.strokeStyle='#8ce4c5';
    a.forEach((p,i)=>{
      const x=4+(w-8)*i/Math.max(1,a.length-1), y=max===min?h/2:h-10-(h-20)*(p-min)/(max-min);
      if(i) g.lineTo(x,y); else g.moveTo(x,y);
      if(a.length===1) g.lineTo(x+1,y);
    });g.stroke();
    chart.setAttribute('aria-label',quote.interval+'走势，最新价 '+quote.price+'，最低 '+min+'，最高 '+max);
  }
  async function connect(reset=false) {
    if(!reset&&(connected||phase==='recovering'||phase==='verifying'||phase==='connecting')) {link.disconnect();return;}
    connecting=true; controls();
    try {await (reset ? link.resetAndChoose() : link.connect());}
    catch(e) {if(phase!=='stopped'&&phase!=='failed') el('status').textContent=e.name==='NotFoundError'?'未选到设备。请在小屏的设备设置中开启伴侣搜索，再点连接。':(e.message||'蓝牙连接失败');}
    finally {connecting=false; controls();}
  }
  el('connect').onclick=()=>connect(link.needsReselect&&!connected&&!connecting&&phase!=='recovering');
  el('reset').onclick=()=>connect(true);
  el('copy').onclick=async()=>{
    try {await navigator.clipboard.writeText(location.href);el('status').textContent='已复制，请粘贴到 Bluefy 的地址栏。';}
    catch(_) {el('status').textContent='请在地址栏长按并复制这个网页地址。';}
  };
  el('traceCopy').onclick=async()=>{
    const report=['小屏连接记录 v6',...traceRows].concat(lastIssue ? ['最近一次异常 '+lastIssue] : []).join('\n');
    try {
      await navigator.clipboard.writeText(report);
      el('traceCopyStatus').textContent='连接记录已复制。';
    } catch(_) {
      const field=el('traceText');
      field.hidden=false; field.value=report; field.focus(); field.select();
      el('traceCopyStatus').textContent='请长按已选中的文字并复制。';
    }
  };
  el('save').onclick=async()=>{
    const ticket=session; saving=true; controls();
    try {
      const stocks=preview('stocks'), pairs=preview('pairs');
      await link.pushWatch(stocks,pairs);
      const check=await link.readWatch();
      if(JSON.stringify(stocks)!==JSON.stringify(check.stocks)||JSON.stringify(pairs)!==JSON.stringify(check.pairs)) throw Error('读回的清单有变化，请重新读取');
      if(ticket===session) el('watchStatus').textContent='已保存，并读回核对了两份清单。';
    } catch(e) {if(ticket===session) el('watchStatus').textContent=e.message;}
    finally {if(ticket===session){saving=false; controls();}}
  };
  el('read').onclick=loadLists;
  el('ask').onclick=async()=>{
    asking=true; controls(); el('aiStatus').textContent='正在把问题送到小屏…';
    try {
      await link.ask(el('question').value);
      if(asking) {
        el('aiStatus').textContent='等待 DeepSeek 回复…';
        answerTimer=setTimeout(()=>{
          asking=false; el('aiStatus').textContent='尚未收到回复，可在小屏查看这次提问的状态。'; controls();
        },125000);
      }
    }
    catch(e){asking=false;el('aiStatus').textContent=e.message;controls();}
  };
  document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{
    document.querySelectorAll('[data-tab]').forEach(b=>{
      const active=b===button;el(b.dataset.tab).hidden=!active;b.setAttribute('aria-pressed',String(active));
    });
  });
  for(const id of ['stocks','pairs','key','question']) el(id).oninput=controls;
  if (!navigator.bluetooth) el('status').textContent='请复制本页链接，在 iPhone 的 Bluefy 中打开后连接。';
  controls();
})();
