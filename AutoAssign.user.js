// ==UserScript==
// @name         Distribution_table Auto assign
// @namespace    https://github.com/yuyna-amazon/Distribution_table
// @version      7.0
// @description  Rodeoデータ取得 + 配置表アプリへの生産性順自動配置
// @author       yuyna
// @icon         https://www.google.com/s2/favicons?sz=64&domain=amazon.com
// @match        http://localhost:8531/*
// @match        http://127.0.0.1:8531/*
// @match        https://rodeo-nrt.amazon.com/*
// @updateURL    https://raw.githubusercontent.com/yuyna-amazon/Distribution-table-Auto-assign/main/AutoAssign.user.js
// @downloadURL  https://raw.githubusercontent.com/yuyna-amazon/Distribution-table-Auto-assign/main/AutoAssign.user.js
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      rodeo-nrt.amazon.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  function onBodyReady(cb) {
    if (document.body) { cb(); return; }
    new MutationObserver(function (_m, obs) {
      if (document.body) { obs.disconnect(); cb(); }
    }).observe(document.documentElement, { childList: true });
  }

  function copyToClipboard(text) {
    if (typeof GM_setClipboard === 'function') { GM_setClipboard(text); return Promise.resolve(); }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  }

  function httpGet(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method: 'GET', url: url,
          onload: function (res) {
            if (res.status >= 200 && res.status < 300) resolve(res.responseText);
            else reject(new Error('HTTP ' + res.status));
          },
          onerror: function () { reject(new Error('network error')); },
        });
      });
    }
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // ※ エントリポイントはこのIIFEの末尾にある。
  //   document-idle では document.body が既に存在するため onBodyReady は
  //   コールバックを同期実行する。ここで呼ぶと後方で const 宣言している
  //   BK などが未初期化(TDZ)のまま参照され ReferenceError で全体が止まる。

  // ============================================================
  // PART A: Rodeoページ — CSV取得してクリップボードへ
  // ============================================================
  function initRodeo() {
    const LABEL = '📋 配置表用にコピー';
    const btn = document.createElement('button');
    btn.textContent = LABEL;
    btn.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:2147483647;background:#232f3e;color:#fff;' +
      'border:none;border-radius:6px;padding:10px 16px;font-size:13px;cursor:pointer;' +
      'box-shadow:0 3px 10px rgba(0,0,0,.3);';
    document.body.appendChild(btn);

    btn.addEventListener('click', function () {
      btn.textContent = '取得中...';
      httpGet(location.href).then(function (text) {
        const rows = parseCsv(text);
        if (!rows.length) throw new Error('CSVが空です');
        const header = rows[0].map(h => h.trim());
        const idxPP = header.findIndex(h => /process\s*path/i.test(h));
        const idxWP = header.findIndex(h => /work\s*pool/i.test(h));
        const idxSD = header.findIndex(h => /ex\s*sd/i.test(h));
        const idxQ  = header.findIndex(h => /quantity/i.test(h));
        if (idxPP < 0 || idxWP < 0 || idxSD < 0 || idxQ < 0) {
          throw new Error('CSVの列が想定と異なります。ヘッダー: ' + header.join(', '));
        }
        const out = ['Process Path\tWork Pool\tExSD\tQuantity'];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          if (!r || !r[idxPP]) continue;
          out.push([r[idxPP], r[idxWP], r[idxSD], r[idxQ]].join('\t'));
        }
        return copyToClipboard(out.join('\n')).then(function () {
          btn.textContent = '✔ コピー完了(' + (out.length - 1) + '件)';
          setTimeout(function () { btn.textContent = LABEL; }, 2500);
        });
      }).catch(function (e) {
        alert('取得/パースに失敗しました: ' + e.message);
        btn.textContent = LABEL;
      });
    });
  }

  function parseCsv(text) {
    return text.split(/\r?\n/).filter(l => l.trim() !== '').map(function (line) {
      const out = [];
      let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
          else cur += ch;
        } else {
          if (ch === '"') q = true;
          else if (ch === ',') { out.push(cur); cur = ''; }
          else cur += ch;
        }
      }
      out.push(cur);
      return out;
    });
  }

  // ============================================================
  // PART B: 配置表アプリ — 自動配置
  // ============================================================

  // index.htmlは LAYOUT / EMP / placements / BR を let・const で宣言しているため
  // window には載らない。ページコンテキストに script を注入し、
  // グローバルレキシカル環境の束縛をゲッター経由で読めるようにする。
  const BK = '__AA_BRIDGE__';

  function installBridge() {
    if (W[BK]) return;
    const code =
      '(function(){try{window.' + BK + '={' +
      'get LAYOUT(){return LAYOUT;},' +
      'get EMP(){return EMP;},' +
      'get placements(){return placements;},' +
      'get BR(){return (typeof BR!=="undefined")?BR:"__BR__";},' +
      'slotId:function(s,z,p,c){return slotId(s,z,p,c);},' +
      'render:function(){return render();},' +
      'toast:function(m,c){try{return toast(m,c);}catch(e){}},' +
      // アプリ本体の判定をそのまま使う。ロスターのカード表示条件と完全に一致する
      'passFilter:function(e){try{return !!passFilter(e);}catch(_){return true;}},' +
      'get filters(){try{return filters;}catch(_){return {};}},' +
      'get skillFilter(){try{return skillFilter;}catch(_){return null;}},' +
      'get shiftCodeFilter(){try{return shiftCodeFilter;}catch(_){return null;}}' +
      '};}catch(e){window.' + BK + '_ERR=String(e&&e.message||e);}})();';
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  function readState() {
    const b = W[BK];
    if (!b) {
      const err = W[BK + '_ERR'];
      return { ok: false, err: 'bridge未注入' + (err ? ': ' + err : '(CSPでinline script拒否の可能性)') };
    }
    try {
      const L = b.LAYOUT, E = b.EMP, P = b.placements;
      if (!L || !L.left) return { ok: false, err: 'LAYOUT未取得' };
      if (!Array.isArray(E)) return { ok: false, err: 'EMP未取得' };
      if (!P || typeof P !== 'object') return { ok: false, err: 'placements未取得' };
      const pass = (typeof b.passFilter === 'function')
        ? function (e) { try { return b.passFilter(e); } catch (_) { return true; } }
        : function () { return true; };
      return {
        ok: true, L: L, E: E, P: P, BR: b.BR, slotId: b.slotId,
        render: b.render, toast: b.toast,
        pass: pass, hasPass: typeof b.passFilter === 'function',
        useFilter: true,
      };
    } catch (e) {
      return { ok: false, err: String(e && e.message || e) };
    }
  }

  // 画面に出すためのフィルタ状況の説明
  function filterDesc() {
    const b = W[BK];
    if (!b) return { active: false, text: '(取得不可)' };
    const parts = [];
    try {
      const f = b.filters || {};
      if (f.shift) parts.push(String(f.shift));
      if (f.lv) parts.push('Lv:' + f.lv);
      if (f.amb != null) parts.push('AMB');
    } catch (_) {}
    try {
      const sc = b.shiftCodeFilter;
      if (sc && sc.size > 0) parts.push('シフトコード' + sc.size + '件');
    } catch (_) {}
    let skill = null;
    try { skill = b.skillFilter || null; } catch (_) {}
    return {
      active: parts.length > 0,
      text: parts.length ? parts.join(' / ') : 'なし',
      skill: skill,
    };
  }

  // フィルタを通る未配置の在籍者
  function candidates(st) {
    const placed = {};
    Object.keys(st.P).forEach(k => { if (st.P[k]) placed[st.P[k]] = 1; });
    const free = st.E.filter(e => e && e.id && !placed[e.id] && !e.absent);
    const kept = st.useFilter ? free.filter(e => st.pass(e)) : free;
    return { all: free, kept: kept };
  }

  function collectProcs(st) {
    const out = [];
    [['L', st.L.left], ['R', st.L.right]].forEach(function (pair) {
      const side = pair[0];
      (pair[1] || []).forEach(function (z, zi) {
        (z.procs || []).forEach((p, pi) => {
          const cells = (p.cells || []);
          const total = cells.filter(c => c !== st.BR).length;
          if (!total) return;
          let filled = 0;
          cells.forEach(function (c, ci) {
            if (c === st.BR) return;
            if (st.P[st.slotId(side, zi, pi, ci)]) filled++;
          });
          out.push({
            key: side + '-' + zi + '-' + pi,
            side: side, zi: zi, pi: pi,
            zone: z.name, proc: p.name,
            skill: p.skill || '', total: total,
            filled: filled, free: total - filled,
          });
        });
      });
    });
    return out;
  }

  // 工程の全セル(__BR__除く)を ci 昇順で返す
  function procSlots(st, ref) {
    const arr = ref.side === 'L' ? st.L.left : st.L.right;
    const z = arr[ref.zi];
    if (!z) return [];
    const p = (z.procs || [])[ref.pi];
    if (!p) return [];
    const out = [];
    (p.cells || []).forEach(function (c, ci) {
      if (c === st.BR) return;
      out.push({ ci: ci, sid: st.slotId(ref.side, ref.zi, ref.pi, ci) });
    });
    return out;
  }

  function empMap(st) {
    const m = {};
    st.E.forEach(function (e) { if (e && e.id) m[e.id] = e; });
    return m;
  }

  function skillVal(emp, skill) {
    if (!skill || !emp.skills) return NaN;
    if (emp.skills[skill] != null) return parseFloat(emp.skills[skill]);
    const keys = Object.keys(emp.skills);
    const lc = skill.toLowerCase();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === lc) return parseFloat(emp.skills[keys[i]]);
    }
    return NaN;
  }

  // 増員。空きセルへ生産性の高い順に入れる。実際に入れた人数を返す
  function addTo(st, ref, count) {
    const em = empMap(st);
    const slots = procSlots(st, ref).filter(s => !st.P[s.sid]);
    if (!slots.length) return { n: 0, pairs: [], reason: '空きセルなし' };

    const c = candidates(st);
    const cands = c.kept;
    if (!cands.length) {
      return {
        n: 0, pairs: [],
        reason: c.all.length ? 'フィルタ条件に合う未配置者なし' : '未配置の在籍者なし',
      };
    }

    let withSkill = 0;
    if (ref.skill) {
      cands.forEach(e => { if (!isNaN(skillVal(e, ref.skill))) withSkill++; });
      cands.sort(function (a, b) {
        let va = skillVal(a, ref.skill), vb = skillVal(b, ref.skill);
        if (isNaN(va)) va = -1;
        if (isNaN(vb)) vb = -1;
        return vb - va;
      });
    }

    const n = Math.min(count, slots.length, cands.length);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const e = cands[i];
      st.P[slots[i].sid] = e.id;
      pairs.push({ sid: slots[i].sid, name: e.name, val: ref.skill ? skillVal(e, ref.skill) : NaN });
    }

    let reason = '';
    if (n < count) {
      if (slots.length < count) reason = '空きセル不足';
      else if (st.useFilter && c.all.length > c.kept.length) reason = '人員不足(フィルタで' + (c.all.length - c.kept.length) + '名除外)';
      else reason = '人員不足';
    }
    if (ref.skill && withSkill === 0) reason = (reason ? reason + '/' : '') + '生産性データ無(順不同)';
    else if (!ref.skill) reason = (reason ? reason + '/' : '') + 'skill未設定(順不同)';
    return { n: n, pairs: pairs, reason: reason };
  }

  // 減員。生産性の低い人から外す。skill未設定なら後ろのセルから外す
  function removeFrom(st, ref, count) {
    const em = empMap(st);
    const all = procSlots(st, ref).filter(s => st.P[s.sid]);
    if (!all.length) return { n: 0, pairs: [], reason: '配置なし' };

    // フィルタ有効時は、フィルタを通る人だけを外す対象にする。
    // ロスターに無い人(孤立ID)は対象に含める。
    const occ = st.useFilter
      ? all.filter(function (s) { const e = em[st.P[s.sid]]; return !e || st.pass(e); })
      : all;
    if (!occ.length) return { n: 0, pairs: [], reason: 'フィルタ条件に合う配置者なし' };

    function v(s) {
      const e = em[st.P[s.sid]];
      if (!e) return -Infinity;                 // ロスターに無い人は最優先で外す
      const x = ref.skill ? skillVal(e, ref.skill) : NaN;
      return isNaN(x) ? -1 : x;
    }
    occ.sort(function (a, b) {
      if (ref.skill) {
        const va = v(a), vb = v(b);
        if (va !== vb) return va - vb;          // 低い順
      }
      return b.ci - a.ci;                       // 同値/skill無は後ろのセルから
    });

    const n = Math.min(count, occ.length);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const s = occ[i];
      const e = em[st.P[s.sid]];
      pairs.push({ sid: s.sid, name: e ? e.name : '(不明)', val: ref.skill && e ? skillVal(e, ref.skill) : NaN });
      delete st.P[s.sid];
    }
    let reason = '';
    if (n < count && st.useFilter && all.length > occ.length) {
      reason = 'フィルタ外の' + (all.length - occ.length) + '名は外しません';
    }
    return { n: n, pairs: pairs, reason: reason };
  }

  // ============================================================
  // Rodeoデータから NeedHC を算出する
  // 計画実績File_原本v6.xlsm の OUTBOUND シート(F2:K8)と同じロジック。
  //   Needed HC = ROUNDUP( Total Quantity / Time left / UPH , 1 )
  //   Time left = (Target CPT - now)*24 + 工程ごとの adjust
  // ============================================================

  // OUTBOUND!F4:K4 の adjust と、F3:K3 の集計条件
  const OB = [
    { key: 'PickSingles', label: 'Pick Singles', adj: -0.45, pp: 'PPSingle', wps: ['PredictedCharge', 'ReadyToPick', 'PickingNotYetPicked'] },
    { key: 'PickMultis',  label: 'Pick Multis',  adj: -0.45, pp: 'PP1PPB',   wps: ['PredictedCharge', 'ReadyToPick', 'PickingNotYetPicked'] },
    { key: 'Rebin',       label: 'Rebin',        adj: -0.40, pp: 'PP1PPB',   wps: ['PickingPicked'], plus: 'PickMultis' },
    { key: 'PackSingles', label: 'Pack Singles', adj: -0.20, pp: 'PPSingle', wps: ['PickingPicked'], plus: 'PickSingles' },
    { key: 'PackMultis',  label: 'Pack Multis',  adj: -0.25, pp: 'PP1PPB',   wps: ['Sorted'],        plus: 'Rebin' },
    { key: 'SLAM',        label: 'SLAM',         adj: -0.10, slam: true },
  ];

  // 配置表の工程への割り当て
  const BOARD_MAP = [
    { proc: 'Pick',  from: ['PickSingles', 'PickMultis'] },
    { proc: 'Rebin', from: ['Rebin'] },
    { proc: 'Pack',  from: ['PackSingles', 'PackMultis'] },
    { proc: 'ScanP', from: ['SLAM'] },
  ];

  const LS_UPH = 'aa_uph';
  const LS_AJAST = 'aa_ajast';
  const LS_SITE = 'aa_site';
  const SITE_DEFAULT = 'SFK1';

  function loadSite() {
    const v = String(lsGet(LS_SITE) || '').trim().toUpperCase();
    return v || SITE_DEFAULT;
  }

  // Rodeo の ExSD CSV。{SITE} をサイトコードに差し替える
  const RODEO_PARAMS = [
    'isEulerUpgraded=ALL', 'processPath=PP1PPB', 'processPath=PPSingle', 'processPath=',
    'fnSku=', 'fulfillmentServiceClass=ALL', 'exSDRange.quickRange=PLUS_MINUS_7_DAYS',
    'isEulerPromiseMiss=ALL', 'zAxis=PROCESS_PATH', 'sortCode=', 'isEulerExSDMiss=ALL',
    'exSDRange.dailyEnd=00%3A00', 'exSDRange.dailyStart=00%3A00', 'yAxis=WORK_POOL',
    'isReactiveTransfer=ALL', 'minPickPriority=MIN_PRIORITY', 'fracs=ALL', 'shipMethod=',
    'shipmentTypes=CUSTOMER_SHIPMENTS',
    '_workPool=on', '_workPool=on', '_workPool=on', '_workPool=on',
    'workPool=PredictedCharge', 'workPool=PlannedShipment', 'workPool=ReadyToPick',
    'workPool=ReadyToPickHardCapped', 'workPool=ReadyToPickUnconstrained',
    'workPool=PickingNotYetPicked', 'workPool=PickingNotYetPickedPrioritized',
    'workPool=PickingNotYetPickedNotPrioritized', 'workPool=PickingNotYetPickedHardCapped',
    'workPool=CrossdockNotYetPicked', 'workPool=PickingPicked', 'workPool=PickingPickedInProgress',
    'workPool=PickingPickedInTransit', 'workPool=PickingPickedRouting',
    'workPool=PickingPickedAtDestination', 'workPool=Inducted', 'workPool=RebinBuffered',
    'workPool=Sorted', 'workPool=GiftWrap', 'workPool=Packing', 'workPool=Scanned',
    'workPool=ProblemSolving', 'workPool=ProcessPartial', 'workPool=SoftwareException',
    'workPool=Crossdock', 'workPool=PreSort', 'workPool=TransshipSorted', 'workPool=Palletized',
    'workPool=PalletizedStaged', 'workPool=ManifestPending', 'workPool=ManifestPendingVerification',
    'workPool=Manifested', 'workPool=Slammed', 'workPool=ReceivedBySorter',
    'workPool=InterceptProblemSolve', 'workPool=STaRSSlammed', 'workPool=STaRSReceivedBySorter',
    'workPool=STaRSDiverted', 'workPool=STaRSStacked', 'workPool=STaRSStaged',
    'workPool=STaRSLoaded', 'workPool=Diverted', 'workPool=Stacked', 'workPool=Staged',
    'workPool=Loaded', 'workPool=TransshipManifested', 'giftOption=ALL', 'shipOption=',
  ].join('&');

  function rodeoUrl(site) {
    return 'https://rodeo-nrt.amazon.com/' + encodeURIComponent(site) + '/CSV/ExSD?' + RODEO_PARAMS;
  }
  const UPH_DEFAULT = {
    PickSingles: 93.4, PickMultis: 113.0, Rebin: 346.3,
    PackSingles: 100.0, PackMultis: 143.3, SLAM: 500,
  };
  // OUTBOUND!M6 の UPS。SLAM の物量換算にのみ使う固定値
  const UPS = 2.2;

  function loadUph() {
    try {
      const o = JSON.parse(lsGet(LS_UPH) || '{}');
      const out = {};
      OB.forEach(p => { out[p.key] = (o[p.key] > 0) ? o[p.key] : UPH_DEFAULT[p.key]; });
      return out;
    } catch (_) { return Object.assign({}, UPH_DEFAULT); }
  }
  // OUTBOUND!C10 相当。残り時間に加算する時間(h)。マイナスも可
  function loadAjast() {
    const v = parseFloat(lsGet(LS_AJAST));
    return isNaN(v) ? 0 : v;
  }

  // 区切り文字を自動判定して表を読む(クリップボード=TSV / CSVの両方)
  function splitTable(text) {
    const lines = String(text).split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) return [];
    const delim = (lines[0].indexOf('\t') >= 0) ? '\t' : ',';
    return lines.map(function (line) {
      const out = [];
      let cur = '', q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
          if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
          else cur += ch;
        } else {
          if (ch === '"') q = true;
          else if (ch === delim) { out.push(cur); cur = ''; }
          else cur += ch;
        }
      }
      out.push(cur);
      return out.map(s => s.trim());
    });
  }

  // ExSD を Date にする。Excelシリアル値・各種日時表記に対応
  function parseExsd(s) {
    s = String(s || '').trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s);
      if (n < 1000) return null;
      const d = new Date(1899, 11, 30);
      d.setDate(d.getDate() + Math.floor(n));
      d.setHours(0, 0, 0, 0);
      d.setSeconds(Math.round((n - Math.floor(n)) * 86400));
      return d;
    }
    let d = new Date(s.replace(/\//g, '-').replace(/(\d)[T](\d)/, '$1 $2'));
    if (!isNaN(d.getTime())) return d;
    d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function parseRodeo(text) {
    const rows = splitTable(text);
    if (rows.length < 2) return { err: '行が足りません(ヘッダー+データが必要)' };
    const h = rows[0].map(x => x.toLowerCase());
    const iPP = h.findIndex(x => /process\s*path/.test(x));
    const iWP = h.findIndex(x => /work\s*pool/.test(x));
    const iSD = h.findIndex(x => /ex\s*sd/.test(x));
    const iQ  = h.findIndex(x => /quantity/.test(x));
    if (iPP < 0 || iWP < 0 || iSD < 0 || iQ < 0) {
      return { err: '列が見つかりません。ヘッダー: ' + rows[0].join(' | ') };
    }
    const out = [];
    let bad = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const d = parseExsd(r[iSD]);
      const q = parseFloat(String(r[iQ]).replace(/,/g, ''));
      if (!r[iPP] || !d || isNaN(q)) { bad++; continue; }
      out.push({ pp: r[iPP], wp: r[iWP], t: d.getTime(), qty: q });
    }
    if (!out.length) return { err: '有効なデータ行がありません(' + bad + '行を読み飛ばし)' };
    return { rows: out, skipped: bad };
  }

  // データに存在する ExSD を CPT 候補として取り出す
  function cptList(rows) {
    const m = {};
    rows.forEach(r => { m[r.t] = (m[r.t] || 0) + r.qty; });
    return Object.keys(m).map(Number).sort((a, b) => a - b).map(function (t) {
      const d = new Date(t);
      const p2 = n => String(n).padStart(2, '0');
      return {
        t: t, qty: m[t],
        label: (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()),
      };
    });
  }

  // 未来で最も近い CPT を既定にする。全部過去なら最後のもの
  function defaultCpt(list) {
    const now = Date.now();
    for (let i = 0; i < list.length; i++) if (list[i].t >= now) return list[i].t;
    return list.length ? list[list.length - 1].t : null;
  }

  function roundUp1(x) { return Math.ceil(x * 10 - 1e-9) / 10; }

  // OUTBOUND!C9 相当。ajast は C10(手動調整)
  function hoursLeft(cptTime, ajast) {
    let h = (cptTime - Date.now()) / 3600000;
    // 翌日CPT(OUTBOUNDシートの Over Night)は休憩1時間を控除する
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const c0 = new Date(cptTime); c0.setHours(0, 0, 0, 0);
    if (c0.getTime() > t0.getTime()) h -= 1;
    return h + (isNaN(ajast) ? 0 : (ajast || 0));
  }

  function computeNeed(rows, cptTime, uph, ajast) {
    function sumQty(pp, wps) {
      let t = 0;
      rows.forEach(function (r) {
        if (r.t !== cptTime || r.pp !== pp) return;
        if (wps.indexOf(r.wp) < 0) return;
        t += r.qty;
      });
      return t;
    }
    const qty = {};
    OB.forEach(function (p) {
      if (p.slam) { qty.SLAM = qty.PackSingles + qty.PackMultis / UPS; return; }
      qty[p.key] = sumQty(p.pp, p.wps) + (p.plus ? qty[p.plus] : 0);
    });

    const hl = hoursLeft(cptTime, ajast);
    const res = {};
    OB.forEach(function (p) {
      const tl = hl + p.adj;
      const u = uph[p.key];
      let hc = NaN;
      if (tl > 0 && u > 0) hc = roundUp1(qty[p.key] / tl / u);
      res[p.key] = { qty: qty[p.key], tl: tl, uph: u, hc: hc };
    });
    return { hoursLeft: hl, detail: res };
  }

  // ------------------------------------------------------------
  // UI。パネルは破棄せず display で隠す。閉じても復帰タブから戻せる。
  // ------------------------------------------------------------
  const LS_HIDDEN = 'aa_panel_hidden';
  const LS_POS = 'aa_panel_pos';

  let panelEl = null;    // パネル本体
  let tabEl = null;      // 復帰タブ
  let calcEl = null;     // NeedHC算出パネル(本体の左に出す)
  const needCache = {};  // key -> NeedHC文字列。パネル再生成時に復元する

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function isHidden() { return lsGet(LS_HIDDEN) === '1'; }

  function initBoard() {
    installBridge();
    ensureUI();
    // 何らかの理由でパネルがDOMから外れても自動で復帰させる
    setInterval(ensureUI, 2000);
    // Alt+A で表示/非表示
    window.addEventListener('keydown', function (ev) {
      if (ev.altKey && (ev.key === 'a' || ev.key === 'A')) {
        ev.preventDefault();
        setVisible(isHidden());
      }
    });
  }

  function ensureUI() {
    installBridge();
    if (!tabEl || !tabEl.isConnected) buildTab();
    if (!panelEl || !panelEl.isConnected) {
      // 本体を作り直すときは算出パネルも捨てて配線の整合を保つ
      if (calcEl && calcEl.isConnected) calcEl.remove();
      calcEl = null;
      buildPanel();
      refreshRows();
    }
    if (calcEl && !calcEl.isConnected) calcEl = null;
    applyVisibility();
    if (!isHidden()) syncWithApp();
  }

  // アプリ側の日付。placements は日付ごとに別オブジェクトなので監視対象に含める
  function curDate() {
    const el = document.getElementById('date');
    return el ? String(el.value || '') : '';
  }

  // 工程の構成(並び・名前・セル数)の指紋。変わったら行を作り直す必要がある
  function structSig(procs) {
    return curDate() + '|' + procs.map(p => p.key + ':' + p.zone + '/' + p.proc + ':' + p.skill + ':' + p.total).join(',');
  }

  // 配置人数だけの指紋。変わったら数字の表示だけ更新すれば足りる
  function countSig(procs) {
    return procs.map(p => p.filled).join(',');
  }

  let lastStruct = null, lastCount = null;

  // レイアウト差し替え(他ユーザーの編集がsyncで届く/編集モード/日付変更)に追従する
  function syncWithApp() {
    const st = readState();
    if (!st.ok) return;
    const procs = collectProcs(st);
    const ss = structSig(procs), cs = countSig(procs);

    if (ss !== lastStruct) {
      // 入力中に作り直すと値と focus が飛ぶので、入力が終わるまで待つ
      const a = document.activeElement;
      if (a && panelEl.contains(a) && a.tagName === 'INPUT') return;
      refreshRows();
      dbg('アプリのレイアウト/日付が変わったため工程を再読込しました');
      return;
    }
    if (cs !== lastCount) {
      // 数字だけ差し替える。入力中でも安全
      procs.forEach(function (p) {
        const inp = panelEl.querySelector('input[data-key="' + p.key + '"]');
        if (!inp) return;
        inp.placeholder = String(p.filled);
        // 行の構成は [工程名][現在/総数][入力] なので人数表示は入力の直前
        const cnt = inp.previousElementSibling;
        if (cnt) cnt.textContent = p.filled + '/' + p.total;
      });
      lastCount = cs;
      updateFilterStat(st);
      updateTotal(st);
    }
  }

  function applyVisibility() {
    const hidden = isHidden();
    if (panelEl) panelEl.style.display = hidden ? 'none' : 'flex';
    if (tabEl) tabEl.style.display = hidden ? 'block' : 'none';
    // 本体を隠したら算出パネルも隠す
    if (hidden && calcEl && calcEl.isConnected) { calcEl.style.display = 'none'; calcToggleLabel(); }
  }

  function setVisible(v) {
    lsSet(LS_HIDDEN, v ? '0' : '1');
    applyVisibility();
    if (v) refreshRows();
  }

  function buildTab() {
    tabEl = document.createElement('div');
    tabEl.id = 'aa-tab';
    tabEl.textContent = '⚙ 自動配置';
    tabEl.title = '自動配置パネルを開く (Alt+A)';
    tabEl.style.cssText =
      'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#8b5cf6;color:#fff;' +
      'border-radius:6px;padding:7px 12px;font:700 12px sans-serif;cursor:pointer;' +
      'box-shadow:0 3px 12px rgba(0,0,0,.3);user-select:none;';
    tabEl.addEventListener('click', function () { setVisible(true); });
    document.body.appendChild(tabEl);
  }

  // 算出パネルの中身。本体とは別のパネルに入る
  function calcInner() {
    const uph = loadUph();
    // スピンボタンが右側を占めるので、数値が欠けないよう余裕を持たせる
    const inp = 'width:80px;flex:none;padding:3px 4px;border:1px solid #ccc;border-radius:3px;text-align:center;font-size:11px;';
    let uphRows = '';
    OB.forEach(function (p) {
      uphRows += '<div style="display:flex;gap:4px;align-items:center;margin-bottom:2px;">' +
        '<span style="flex:1;font-size:10px;white-space:nowrap;">' + esc(p.label) + '</span>' +
        '<input type="number" step="0.1" min="0" data-uph="' + p.key + '" value="' + uph[p.key] + '" style="' + inp + '">' +
        '</div>';
    });
    return '' +
      '<div style="display:flex;gap:4px;align-items:center;margin-bottom:4px;">' +
      '<span style="font-size:10px;flex:none;">サイト</span>' +
      '<input id="aa-site" value="' + esc(loadSite()) + '" spellcheck="false" ' +
      'style="width:56px;flex:none;padding:2px 3px;border:1px solid #ccc;border-radius:3px;text-align:center;font-size:11px;">' +
      '<button id="aa-fetch" style="flex:1;background:#232f3e;color:#fff;border:none;border-radius:4px;' +
      'padding:4px;cursor:pointer;font-size:10px;font-weight:700;">Rodeoから取得</button>' +
      '</div>' +

      '<div style="display:flex;gap:4px;align-items:center;">' +
      '<span style="font-size:10px;flex:none;">CPT</span>' +
      '<select id="aa-cpt" style="flex:1;font-size:11px;padding:2px;border:1px solid #ccc;border-radius:3px;"></select>' +
      '</div>' +
      '<div id="aa-cptinfo" style="font-size:10px;color:#666;margin-top:2px;"></div>' +

      '<div style="font-size:10px;font-weight:700;margin:6px 0 2px;">設定</div>' +
      '<div style="display:flex;gap:4px;align-items:center;margin-bottom:2px;">' +
      '<span style="flex:1;font-size:10px;white-space:nowrap;">Ajast Time</span>' +
      '<input type="number" step="0.1" id="aa-ajast" value="' + loadAjast() + '" ' +
      'title="残り時間に加算する時間(h)。マイナスも可" style="' + inp + '">' +
      '</div>' +

      '<div style="font-size:10px;font-weight:700;margin:6px 0 2px;">UPH</div>' +
      uphRows +

      '<button id="aa-calc-run" style="width:100%;margin-top:6px;background:#0891b2;color:#fff;border:none;' +
      'border-radius:5px;padding:6px;cursor:pointer;font-weight:700;font-size:11px;">算出して目標人数に入れる</button>' +
      '<div id="aa-calcout" style="font-size:10px;color:#333;line-height:1.5;white-space:pre-wrap;margin-top:5px;"></div>';
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'aa-panel';
    panelEl.style.cssText =
      'position:fixed;z-index:2147483647;background:#fff;color:#111;' +
      'border:1px solid #bbb;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);' +
      'width:330px;max-height:78vh;display:flex;flex-direction:column;' +
      'font-family:sans-serif;font-size:12px;';

    // 位置を復元(ドラッグ済みなら left/top、未ドラッグなら右下)
    const pos = lsGet(LS_POS);
    if (pos && /^\d+,\d+$/.test(pos)) {
      const xy = pos.split(',');
      panelEl.style.left = xy[0] + 'px';
      panelEl.style.top = xy[1] + 'px';
    } else {
      panelEl.style.right = '14px';
      panelEl.style.bottom = '14px';
    }

    panelEl.innerHTML =
      '<div id="aa-head" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px 6px;font-weight:700;cursor:move;">' +
      '<span>自動配置</span>' +
      '<span id="aa-close" title="閉じる (Alt+Aで再表示)" style="cursor:pointer;color:#888;">✕</span></div>' +
      '<div id="aa-fstat" style="padding:0 12px 6px;font-size:10px;color:#666;"></div>' +
      '<div style="padding:0 12px 8px;display:flex;gap:6px;">' +
      '<button id="aa-run" style="flex:1;background:#8b5cf6;color:#fff;border:none;border-radius:5px;padding:7px;cursor:pointer;font-weight:700;">実行</button>' +
      '<button id="aa-reset" title="入力した数値をすべて0にする(盤面は変更しない)" style="flex:none;background:#dc2626;color:#fff;' +
      'border:none;border-radius:5px;padding:7px 12px;cursor:pointer;font-weight:700;">Reset</button>' +
      '</div>' +
      '<div id="aa-total" style="padding:0 12px 6px;font-size:11px;font-weight:700;color:#333;"></div>' +
      '<div style="padding:0 12px 6px;">' +
      '<span id="aa-calc-toggle" style="font-size:11px;font-weight:700;color:#8b5cf6;cursor:pointer;user-select:none;">' +
      '▸ Rodeo から NeedHC を算出</span></div>' +
      '<div id="aa-rows" style="overflow:auto;padding:0 12px 10px;flex:1;"></div>';

    document.body.appendChild(panelEl);

    // 破棄せず隠すだけ。復帰タブとAlt+Aで戻せる
    panelEl.querySelector('#aa-close').addEventListener('click', function () { setVisible(false); });
    panelEl.querySelector('#aa-reset').addEventListener('click', reset);
    panelEl.querySelector('#aa-run').addEventListener('click', run);
    panelEl.querySelector('#aa-calc-toggle').addEventListener('click', toggleCalc);
    calcToggleLabel();

    // 本体を動かしたら算出パネルも付いてくる
    makeDraggable(panelEl, panelEl.querySelector('#aa-head'), placeCalc);
  }

  function makeDraggable(el, handle, onMove) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', function (ev) {
      if (ev.target.id === 'aa-close') return;
      const r = el.getBoundingClientRect();
      // right/bottom 指定から left/top 指定へ切り替える
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      dx = ev.clientX - r.left;
      dy = ev.clientY - r.top;
      dragging = true;
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      if (typeof onMove === 'function') onMove();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      // 位置を覚えるのは本体パネルだけ。算出パネルは本体に追従させる
      if (el === panelEl) {
        const r = el.getBoundingClientRect();
        lsSet(LS_POS, Math.round(r.left) + ',' + Math.round(r.top));
      }
    });
  }

  // パネル内のログ欄は廃止した。要点はアプリのトースト、明細はコンソールへ出す
  function log(s) {
    try { console.log('[Auto assign]\n' + s); } catch (_) {}
    const b = W[BK];
    if (b && typeof b.toast === 'function') {
      try { b.toast(String(s).split('\n')[0]); } catch (_) {}
    }
  }

  // コンソールだけに出す。トーストを出すと頻度が高くて邪魔になるもの
  function dbg(s) {
    try { console.log('[Auto assign] ' + s); } catch (_) {}
  }

  function setRunEnabled(on) {
    const b = panelEl && panelEl.querySelector('#aa-run');
    if (!b) return;
    b.disabled = !on;
    b.style.opacity = on ? '1' : '.5';
  }

  // フィルタの状態と、いま候補になる人数を出す。フィルタは常に尊重する
  function updateFilterStat(st) {
    if (!panelEl || !panelEl.isConnected) return;
    const fstat = panelEl.querySelector('#aa-fstat');
    if (!fstat) return;
    if (!st.hasPass) {
      fstat.innerHTML = '<span style="color:#b00;">passFilter未取得のためフィルタは適用されません</span>';
      return;
    }
    const c = candidates(st);
    const fd = filterDesc();
    const ex = c.all.length - c.kept.length;
    fstat.textContent = '日付 ' + (curDate() || '不明') + ' / フィルタ: ' + fd.text +
      ' / 候補 ' + c.kept.length + '名' + (ex > 0 ? '(除外' + ex + '名)' : '') +
      (fd.skill ? ' / skill強調:' + fd.skill : '');
  }

  // 目標人数の合計と、現在の配置合計を出す
  function updateTotal(st) {
    if (!panelEl || !panelEl.isConnected) return;
    const el = panelEl.querySelector('#aa-total');
    if (!el) return;

    let target = 0, filled = 0;
    let nTarget = 0;
    panelEl.querySelectorAll('input[data-key]').forEach(function (i) {
      const raw = String(i.value).trim();
      if (raw === '') return;
      const n = parseInt(raw, 10);
      if (isNaN(n) || n < 0) return;
      target += n;
      nTarget++;
    });

    const s = (st && st.ok) ? st : readState();
    let cells = 0;
    if (s.ok) {
      collectProcs(s).forEach(function (p) { filled += p.filled; cells += p.total; });
    }

    const diff = target - filled;
    el.innerHTML =
      '必要 <span style="color:#8b5cf6;">' + (nTarget ? target : 0) + '</span>名' +
      '<span style="font-weight:400;color:#888;font-size:10px;">(' + nTarget + '工程)</span>' +
      ' / 配置表 ' + filled + '名' +
      '<span style="font-weight:400;color:#888;font-size:10px;"> 全' + cells + '枠</span>' +
      (nTarget && diff !== 0
        ? ' <span style="color:' + (diff > 0 ? '#0891b2' : '#dc2626') + ';">' +
          (diff > 0 ? '+' + diff : String(diff)) + '</span>'
        : '');
  }

  function refreshRows() {
    if (!panelEl || !panelEl.isConnected) return;
    const rowsEl = panelEl.querySelector('#aa-rows');
    const st = readState();
    if (!st.ok) {
      rowsEl.innerHTML = '<div style="color:#b00;font-size:11px;padding:6px 0;">アプリを検出できません: ' + esc(st.err) + '</div>';
      setRunEnabled(false);
      return;
    }
    updateFilterStat(st);

    const procs = collectProcs(st);
    if (!procs.length) {
      rowsEl.innerHTML = '<div style="color:#b00;font-size:11px;">セルを持つ工程が見つかりません</div>';
      setRunEnabled(false);
      return;
    }
    setRunEnabled(true);

    // 表示中の入力値をキャッシュへ退避してから作り直す
    rowsEl.querySelectorAll('input[data-key]').forEach(function (i) { needCache[i.dataset.key] = i.value; });

    let html = '', lastZone = null;
    procs.forEach(function (p) {
      if (p.zone !== lastZone) {
        html += '<div style="margin:6px 0 3px;font-size:10px;font-weight:700;color:#555;border-bottom:1px solid #eee;">' + esc(p.zone) + '</div>';
        lastZone = p.zone;
      }
      const v = needCache[p.key] != null ? needCache[p.key] : '';
      html +=
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">' +
        '<span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(p.proc + ' / skill=' + (p.skill || 'なし')) + '">' +
        esc(p.proc) + (p.skill ? ' <span style="color:#888;">[' + esc(p.skill) + ']</span>' : ' <span style="color:#c60;">[skill無]</span>') + '</span>' +
        '<span style="font-size:10px;color:#666;flex:none;" title="現在の配置 / 総セル数">' + p.filled + '/' + p.total + '</span>' +
        '<input type="number" inputmode="numeric" step="1" min="0" max="' + p.total + '" data-key="' + esc(p.key) + '" ' +
        'data-zone="' + esc(p.zone) + '" data-proc="' + esc(p.proc) + '" value="' + esc(v) + '" ' +
        'placeholder="' + p.filled + '" title="目標人数。空欄=この工程は変更しない / 0=全員外す" ' +
        'style="width:64px;flex:none;padding:3px 4px;border:1px solid #ccc;border-radius:4px;text-align:center;">' +
        '</div>';
    });
    rowsEl.innerHTML = html;

    rowsEl.querySelectorAll('input[data-key]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const cleaned = inp.value.replace(/[^\d]/g, '');   // 整数のみ
        if (inp.value !== cleaned) inp.value = cleaned;
        needCache[inp.dataset.key] = inp.value;
        updateTotal();
      });
    });

    updateTotal(st);

    // いまの構成を記録しておき、以降の変化を検知する
    lastStruct = structSig(procs);
    lastCount = countSig(procs);
  }

  let calcRows = null;   // 貼り付けを解析した結果

  const CALC_W = 300;

  // 本体パネルの左に並べる。左に入らなければ右、それも無理なら画面内に収める
  function placeCalc() {
    if (!calcEl || !panelEl || calcEl.style.display === 'none') return;
    const r = panelEl.getBoundingClientRect();
    let left = r.left - CALC_W - 8;
    if (left < 4) left = r.right + 8;
    if (left + CALC_W > window.innerWidth - 4) left = Math.max(4, window.innerWidth - CALC_W - 4);
    calcEl.style.left = Math.round(left) + 'px';
    calcEl.style.top = Math.round(Math.max(4, r.top)) + 'px';
  }

  function calcToggleLabel() {
    const tg = panelEl && panelEl.querySelector('#aa-calc-toggle');
    if (!tg) return;
    const open = calcEl && calcEl.isConnected && calcEl.style.display !== 'none';
    tg.textContent = (open ? '▾' : '▸') + ' Rodeo から NeedHC を算出';
  }

  function toggleCalc() {
    if (calcEl && !calcEl.isConnected) calcEl = null;
    if (!calcEl) { buildCalcPanel(); calcEl.style.display = 'none'; }
    const open = calcEl.style.display !== 'none';
    calcEl.style.display = open ? 'none' : 'flex';
    if (!open) placeCalc();
    calcToggleLabel();
  }

  function buildCalcPanel() {
    calcEl = document.createElement('div');
    calcEl.id = 'aa-calcpanel';
    calcEl.style.cssText =
      'position:fixed;z-index:2147483647;background:#fff;color:#111;' +
      'border:1px solid #bbb;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);' +
      'width:' + CALC_W + 'px;max-height:78vh;display:flex;flex-direction:column;' +
      'font-family:sans-serif;font-size:12px;left:0;top:0;';
    calcEl.innerHTML =
      '<div id="aa-calchead" style="display:flex;justify-content:space-between;align-items:center;' +
      'padding:10px 12px 6px;font-weight:700;cursor:move;">' +
      '<span>NeedHC 算出</span>' +
      '<span id="aa-calcclose" title="閉じる" style="cursor:pointer;color:#888;">✕</span></div>' +
      '<div style="overflow:auto;padding:0 12px 10px;">' + calcInner() + '</div>';
    document.body.appendChild(calcEl);
    wireCalc();
    makeDraggable(calcEl, calcEl.querySelector('#aa-calchead'));
  }

  function wireCalc() {
    calcEl.querySelector('#aa-calcclose').addEventListener('click', function () {
      calcEl.style.display = 'none';
      calcToggleLabel();
    });

    calcEl.querySelector('#aa-cpt').addEventListener('change', showCptInfo);

    // UPH は入力のたびに保存する
    calcEl.querySelectorAll('input[data-uph]').forEach(function (i) {
      i.addEventListener('input', saveUph);
    });
    // Ajast Time は残り時間の表示にも効くので即反映する
    calcEl.querySelector('#aa-ajast').addEventListener('input', function () {
      saveUph();
      showCptInfo();
    });

    calcEl.querySelector('#aa-calc-run').addEventListener('click', calcRun);

    const site = calcEl.querySelector('#aa-site');
    site.addEventListener('input', function () {
      lsSet(LS_SITE, String(site.value || '').trim().toUpperCase());
    });
    calcEl.querySelector('#aa-fetch').addEventListener('click', fetchRodeo);
  }

  // Rodeo から CSV を直接取得する。localhost からは同一オリジンでないため
  // CORS を越えられる GM_xmlhttpRequest が必要(@connect で許可済み)
  function fetchRodeo() {
    const siteEl = calcEl.querySelector('#aa-site');
    const site = String(siteEl.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,6}$/.test(site)) {
      calcOut('サイトコードが不正です: "' + site + '"');
      return;
    }
    siteEl.value = site;
    lsSet(LS_SITE, site);

    const btn = calcEl.querySelector('#aa-fetch');
    const label = btn.textContent;
    btn.textContent = '取得中...';
    btn.disabled = true;
    calcOut(site + ' のデータを取得中...');

    const done = function () { btn.textContent = label; btn.disabled = false; };

    httpGet(rodeoUrl(site)).then(function (text) {
      done();
      if (/^\s*</.test(text)) {
        calcOut('CSVではなくHTMLが返りました。\nMidway認証が切れている可能性があります。' +
          'Rodeoをブラウザで開いて認証してから再試行してください。');
        return;
      }
      if (!text.trim()) { calcOut('空のレスポンスでした。サイトコード "' + site + '" を確認してください'); return; }
      ingest(text);
    }).catch(function (e) {
      done();
      const gm = (typeof GM_xmlhttpRequest === 'function');
      calcOut('取得失敗: ' + (e && e.message || e) +
        (gm ? '' : '\nGM_xmlhttpRequestが使えないためCORSで拒否された可能性があります。') +
        '\n手動で貼り付けても算出できます。');
    });
  }

  function saveUph() {
    const o = {};
    calcEl.querySelectorAll('input[data-uph]').forEach(function (i) {
      const v = parseFloat(i.value);
      if (v > 0) o[i.dataset.uph] = v;
    });
    lsSet(LS_UPH, JSON.stringify(o));
    const a = parseFloat(calcEl.querySelector('#aa-ajast').value);
    lsSet(LS_AJAST, isNaN(a) ? '0' : String(a));
  }

  function curAjast() {
    const el = calcEl && calcEl.querySelector('#aa-ajast');
    const v = el ? parseFloat(el.value) : NaN;
    return isNaN(v) ? 0 : v;
  }

  function calcOut(s) {
    const el = calcEl && calcEl.querySelector('#aa-calcout');
    if (el) el.textContent = s;
  }

  // 取得したCSVを解析し、CPT候補を作って未来で最も近いものを選ぶ
  function ingest(text) {
    const sel = calcEl.querySelector('#aa-cpt');
    const r = parseRodeo(text);
    if (r.err) { calcRows = null; sel.innerHTML = ''; calcOut('読み取り失敗: ' + r.err); showCptInfo(); return; }
    calcRows = r.rows;
    const list = cptList(calcRows);
    const def = defaultCpt(list);
    sel.innerHTML = list.map(function (c) {
      return '<option value="' + c.t + '"' + (c.t === def ? ' selected' : '') + '>' +
        esc(c.label) + '  (' + Math.round(c.qty).toLocaleString() + ')</option>';
    }).join('');
    calcOut(calcRows.length + '行を読み込みました / CPT候補 ' + list.length + '件' +
      (r.skipped ? ' / ' + r.skipped + '行を読み飛ばし' : ''));
    showCptInfo();
  }

  function showCptInfo() {
    const el = calcEl.querySelector('#aa-cptinfo');
    const sel = calcEl.querySelector('#aa-cpt');
    if (!el) return;
    const t = parseInt(sel.value, 10);
    if (!t) { el.textContent = ''; return; }
    const aj = curAjast();
    const hl = hoursLeft(t, aj);
    el.textContent = '残り ' + hl.toFixed(2) + ' h' +
      (aj ? ' (Ajast ' + (aj > 0 ? '+' : '') + aj + ')' : '') +
      (hl <= 0 ? '  ← CPTを過ぎています' : '');
  }

  function calcRun() {
    if (!calcRows) { calcOut('先に「Rodeoから取得」を押してください'); return; }
    const t = parseInt(calcEl.querySelector('#aa-cpt').value, 10);
    if (!t) { calcOut('CPTを選択してください'); return; }

    const uph = {};
    calcEl.querySelectorAll('input[data-uph]').forEach(function (i) {
      uph[i.dataset.uph] = parseFloat(i.value);
    });
    const aj = curAjast();

    const r = computeNeed(calcRows, t, uph, aj);
    if (r.hoursLeft <= 0) {
      calcOut('残り時間が0以下です(' + r.hoursLeft.toFixed(2) + 'h)。CPTか Ajast Time を見直してください');
      return;
    }

    const lines = ['残り ' + r.hoursLeft.toFixed(2) + 'h' + (aj ? ' (Ajast ' + (aj > 0 ? '+' : '') + aj + ')' : '')];
    OB.forEach(function (p) {
      const d = r.detail[p.key];
      lines.push('  ' + p.label.padEnd(13) + Math.round(d.qty).toLocaleString().padStart(7) +
        ' / ' + d.tl.toFixed(2) + 'h / UPH' + (d.uph > 0 ? d.uph : '?') +
        ' = ' + (isNaN(d.hc) ? '算出不可' : d.hc.toFixed(1)));
    });

    // 配置表の工程へ割り当てる。小数は切り上げて整数にする
    const st = readState();
    const procs = st.ok ? collectProcs(st) : [];
    const applied = [];
    BOARD_MAP.forEach(function (m) {
      let sum = 0, ng = false;
      m.from.forEach(function (k) {
        const hc = r.detail[k].hc;
        if (isNaN(hc)) ng = true; else sum += hc;
      });
      if (ng) { applied.push('✕ ' + m.proc + ': UPH未設定'); return; }
      const need = Math.ceil(sum - 1e-9);
      const p = procs.find(x => x.proc === m.proc);
      if (!p) { applied.push('✕ ' + m.proc + ': 配置表に該当工程なし'); return; }
      const inp = panelEl.querySelector('input[data-key="' + p.key + '"]');
      if (!inp) { applied.push('✕ ' + m.proc + ': 入力欄なし'); return; }
      inp.value = String(need);
      needCache[p.key] = String(need);
      applied.push('→ ' + m.proc + ' = ' + need + '名 (' + sum.toFixed(1) + 'を切り上げ)');
    });

    updateTotal(st);
    calcOut(lines.join('\n') + '\n' + applied.join('\n') + '\n実行を押すと反映されます');
  }

  // 入力した数値を 0 にするだけ。盤面の配置には一切触らない。
  function reset() {
    if (!panelEl || !panelEl.isConnected) return;
    let n = 0;
    panelEl.querySelectorAll('input[data-key]').forEach(function (i) {
      i.value = '0';
      needCache[i.dataset.key] = '0';
      n++;
    });
    updateTotal();
    dbg('入力を0にしました(' + n + '工程)');   // トーストは出さない
  }

  // NeedHC は「目標人数」。現在より多ければ増員、少なければ減員し、同じなら何もしない。
  // よって何回押しても結果は同じ(冪等)。
  function run() {
    const st = readState();
    if (!st.ok) { log('アプリ未検出: ' + st.err); return; }
    st.useFilter = true;   // アプリのフィルタは常に尊重する

    // 実行直前に最新のLAYOUTで工程参照を作り直す
    const byKey = {};
    collectProcs(st).forEach(p => { byKey[p.key] = p; });

    // 入力のある行だけを対象にする。空欄はその工程を変更しない
    const targets = [];
    panelEl.querySelectorAll('input[data-key]').forEach(function (inp) {
      const raw = String(inp.value).trim();
      if (raw === '') return;
      const need = parseInt(raw, 10);
      if (isNaN(need) || need < 0) return;
      const ref = byKey[inp.dataset.key];
      if (!ref) { targets.push({ bad: inp.dataset.key + ': 工程が見つかりません(レイアウト変更?)' }); return; }
      // 添字キーは工程の削除や並び替えでズレる。名前が一致しない行は実行しない
      if (ref.zone !== inp.dataset.zone || ref.proc !== inp.dataset.proc) {
        targets.push({
          bad: inp.dataset.zone + '/' + inp.dataset.proc + ' → 現在は ' + ref.zone + '/' + ref.proc +
            ' です。レイアウトが変わったのでスキップしました',
        });
        return;
      }
      targets.push({ ref: ref, need: need, before: ref.filled });
    });

    if (!targets.length) {
      log('目標人数が入力されていません');
      return;
    }

    const results = [];

    // 第1パス: 減員。先に全部外して、余った人を後段の増員で使えるようにする
    targets.forEach(function (t) {
      if (t.bad) return;
      const cur = collectProcs(st).find(p => p.key === t.ref.key).filled;
      if (t.need < cur) {
        const r = removeFrom(st, t.ref, cur - t.need);
        t.removed = r;
      }
    });

    // 第2パス: 増員
    targets.forEach(function (t) {
      if (t.bad) return;
      const cur = collectProcs(st).find(p => p.key === t.ref.key).filled;
      if (t.need > cur) {
        const r = addTo(st, t.ref, t.need - cur);
        t.added = r;
      }
    });

    let nAdd = 0, nDel = 0;
    targets.forEach(function (t) {
      if (t.bad) { results.push('✕ ' + t.bad); return; }
      const after = collectProcs(st).find(p => p.key === t.ref.key).filled;
      nAdd += t.added ? t.added.n : 0;
      nDel += t.removed ? t.removed.n : 0;

      const delta = after - t.before;
      const mark = after === t.need ? '✔ ' : '△ ';
      const sign = delta > 0 ? '+' + delta : String(delta);
      const reason = (t.added && t.added.reason) || (t.removed && t.removed.reason) || '';
      let line = mark + t.ref.proc + ': ' + t.before + ' → ' + after + '名 (目標' + t.need + ', ' + sign + ')' +
        (after !== t.need && reason ? ' ' + reason : '');
      if (t.added && t.added.pairs.length) {
        line += '\n    + ' + t.added.pairs.map(p => p.name + (isNaN(p.val) ? '' : '(' + p.val + ')')).join(', ');
      }
      if (t.removed && t.removed.pairs.length) {
        line += '\n    − ' + t.removed.pairs.map(p => p.name + (isNaN(p.val) ? '' : '(' + p.val + ')')).join(', ');
      }
      results.push(line);
    });

    const fd = filterDesc();
    const summary = '増員 ' + nAdd + '名 / 減員 ' + nDel + '名   [フィルタ: ' + fd.text +
      (st.hasPass ? '' : ' ※passFilter未取得のため未適用') + ']';

    if (nAdd === 0 && nDel === 0) {
      log('変更なし\n' + results.join('\n'));
      return;
    }

    if (typeof st.render === 'function') st.render();
    else if (typeof W.render === 'function') W.render();
    if (typeof W.schedulePush === 'function') W.schedulePush();

    log(summary + '\n' + results.join('\n'));   // 要点はトースト、明細はコンソール
    refreshRows();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ------------------------------------------------------------
  // エントリポイント。すべての const / let 宣言より後で呼ぶこと(TDZ回避)
  // ------------------------------------------------------------
  try {
    if (location.hostname === 'rodeo-nrt.amazon.com') onBodyReady(initRodeo);
    else onBodyReady(initBoard);
  } catch (e) {
    // 起動に失敗しても何が起きたか画面に残す
    console.error('[Auto assign] 起動失敗:', e);
    try {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#b00;' +
        'color:#fff;padding:8px 12px;border-radius:6px;font:12px sans-serif;max-width:340px;';
      d.textContent = '[Auto assign] 起動失敗: ' + (e && e.message || e);
      document.body.appendChild(d);
    } catch (_) {}
  }
})();
