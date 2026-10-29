/* =============== 我的定投记录 - 业务逻辑 =============== */
"use strict";

const STORE_KEY = "myInvestmentData_v1";

/* ---------- 数据层 ---------- */
let db = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return { records: d.records || [], yearly: d.yearly || [], alert: d.alert || defaultAlert() };
    }
  } catch (e) { console.warn("读取本地数据失败", e); }
  return { records: [], yearly: [], alert: defaultAlert() };
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
function defaultAlert() {
  return { target: 8, sellPct: 25, dest: "转入纯债", doneDate: "", executed: "否" };
}

/* ---------- 工具 ---------- */
const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => (n * 100).toFixed(2) + "%";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

/* 类型 → 资产大类 & 颜色 */
function assetClass(type) {
  if (type === "宽基指数" || type === "行业指数") return "权益";
  if (type === "纯债基金") return "债券";
  if (type === "货币基金") return "现金";
  if (type === "纸黄金") return "黄金";
  return "其他";
}
const CLASS_COLOR = { "权益": "#2f6fed", "债券": "#12a05c", "现金": "#e8a33d", "黄金": "#d4a017", "其他": "#8a6fd1" };

/* ---------- 实时估值（天天基金，经 server.py 代理） ---------- */
let estimates = {};   // 基金代码 -> {name, gsz, gszzl, gztime}

async function fetchEst(code) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(`/api/fundest/${code}`, { signal: ctrl.signal });
    const data = await resp.json();
    return data.ok ? data : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

async function fetchGold() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch("/api/gold", { signal: ctrl.signal });
    const data = await resp.json();
    return data.ok ? data : null;
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

async function refreshEstimates() {
  const btn = $("btnRefreshEst");
  // 每个标的取最新一条记录；基金需有代码，纸黄金无需代码
  const c = computeAll();
  const targets = c.holdings.map(h => {
    const recs = db.records.filter(r => r.name === h.name)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latestRec = recs[recs.length - 1];
    return { name: h.name, type: h.type, code: latestRec.code || "", recId: latestRec.id, shares: latestRec.shares };
  }).filter(t => t.code || assetClass(t.type) === "黄金");

  if (!targets.length) { toast("没有可刷新的标的：请先填写 6 位基金代码（纸黄金无需代码）"); return; }

  btn.disabled = true;
  btn.textContent = "⏳ 获取中…";
  let updated = 0, failed = 0;
  const skipped = [];

  // 纸黄金：上金所实时金价，市值 = 克数 × 金价
  const goldTargets = targets.filter(t => assetClass(t.type) === "黄金");
  if (goldTargets.length) {
    const gold = await fetchGold();
    if (gold) {
      estimates["GOLD"] = { ...gold, gsz: gold.price, mode: "实时金价" };
      goldTargets.forEach(t => {
        if (t.shares && Number(t.shares) > 0) {
          const rec = db.records.find(r => r.id === t.recId);
          if (rec) { rec.mv = Math.round(Number(t.shares) * gold.price * 100) / 100; updated++; }
        } else {
          skipped.push(t.name + "(未填克数，仅展示金价涨跌)");
        }
      });
    } else {
      failed += goldTargets.length;
      skipped.push("金价获取失败");
    }
  }

  // 基金：按代码去重后逐个查估值
  const fundTargets = [...new Map(targets.filter(t => t.code).map(t => [t.code, t])).values()];
  for (const t of fundTargets) {
    if (assetClass(t.type) === "现金") { skipped.push(t.name + "(货币基金无估值)"); continue; }
    const est = await fetchEst(t.code);
    if (!est || !est.gsz) { failed++; skipped.push(t.name + "(" + t.code + " 获取失败)"); continue; }
    estimates[t.code] = est;
    // 填了份额 → 自动更新最新记录的市值 = 份额 × 估算净值
    if (t.shares && Number(t.shares) > 0) {
      const rec = db.records.find(r => r.id === t.recId);
      if (rec) { rec.mv = Math.round(Number(t.shares) * Number(est.gsz) * 100) / 100; updated++; }
    }
  }

  btn.disabled = false;
  btn.textContent = "🔄 刷新实时估值";
  if (updated > 0) save();
  $("estTime").textContent = "估值更新时间：" + new Date().toLocaleString("zh-CN");
  renderAll();
  const parts = [`估值刷新完成：${updated} 个标的市值已更新`];
  if (failed) parts.push(`${failed} 个获取失败`);
  if (skipped.length) parts.push("跳过：" + skipped.join("、"));
  toast(parts.join("；"));
}

/* ---------- 核心计算（复刻Excel公式） ---------- */
function computeAll() {
  // 按日期升序排序（同日按录入顺序）
  const recs = db.records.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // 每个标的：累计投入 & 最新市值（G列 = F - E；实际占比 J列 = F / 组合总市值）
  const latest = {};           // 标的 -> {type, mv, cumIn, target, date}
  const runCum = {};           // 标的 -> 按日期线性累计的投入
  recs.forEach(r => {
    runCum[r.name] = (runCum[r.name] || 0) + (Number(r.amount) || 0);
    r._cumIn = runCum[r.name];
    const mv = r.mv === "" || r.mv == null ? null : Number(r.mv);
    if (!latest[r.name] || latest[r.name].date <= r.date) {
      latest[r.name] = { name: r.name, type: r.type, date: r.date, mv, cumIn: r._cumIn, target: Number(r.target) || 0 };
    }
  });

  // 组合总市值：每个标的取最新一条有市值的记录
  const holdings = Object.values(latest).filter(h => h.mv != null);
  const totalMv = holdings.reduce((s, h) => s + h.mv, 0);
  const totalIn = holdings.reduce((s, h) => s + h.cumIn, 0);

  holdings.forEach(h => {
    h.pnl = h.mv - h.cumIn;                                   // G列
    h.pnlPct = h.cumIn === 0 ? 0 : h.pnl / h.cumIn;           // H列 IF(E=0,0,G/E)
    h.actualPct = totalMv === 0 ? 0 : h.mv / totalMv;         // J列
    h.cls = assetClass(h.type);
  });

  return { recs, holdings, latest, totalMv, totalIn, totalPnl: totalMv - totalIn };
}

/* ---------- 页面：总览卡片 ---------- */
function renderOverview(c) {
  $("ovTotalIn").textContent = "¥" + fmt(c.totalIn);
  $("ovTotalMv").textContent = "¥" + fmt(c.totalMv);
  const pnlEl = $("ovTotalPnl"), pctEl = $("ovTotalPct");
  pnlEl.textContent = (c.totalPnl >= 0 ? "+" : "") + "¥" + fmt(c.totalPnl);
  const pct = c.totalIn === 0 ? 0 : c.totalPnl / c.totalIn;
  pctEl.textContent = (pct >= 0 ? "+" : "") + fmtPct(pct);
  [pnlEl, pctEl].forEach(el => {
    el.classList.remove("pos", "neg");
    el.classList.add(c.totalPnl >= 0 ? "pos" : "neg");
  });
}

/* ---------- 页面：股债占比条 ---------- */
function renderRatio(c) {
  const box = $("ratioBars");
  if (!c.holdings.length) { box.innerHTML = '<p class="hint">暂无市值数据，填写「当前市值」后可查看占比</p>'; return; }
  // 按资产大类汇总实际占比；目标占比取该大类下各标的最新目标之和
  const clsMap = {};
  c.holdings.forEach(h => {
    clsMap[h.cls] = clsMap[h.cls] || { actual: 0, target: 0 };
    clsMap[h.cls].actual += h.actualPct;
    clsMap[h.cls].target += (h.target || 0) / 100;
  });
  const order = ["权益", "债券", "现金", "黄金", "其他"].filter(k => clsMap[k]);
  box.innerHTML = order.map(k => {
    const v = clsMap[k], color = CLASS_COLOR[k];
    const aw = Math.min(100, v.actual * 100), tw = Math.min(100, v.target * 100);
    const diff = (v.actual - v.target) * 100;
    const diffTxt = (diff >= 0 ? "+" : "") + diff.toFixed(1) + "pct";
    return `<div class="ratio-row">
      <span class="ratio-name">${k}</span>
      <div class="ratio-track">
        <div class="ratio-bar target" style="width:${tw}%;background:${color}"></div>
        <div class="ratio-bar" style="width:${aw}%;background:${color};height:6px;top:5px"></div>
      </div>
      <span class="ratio-nums">目标 ${fmtPct(v.target)} / 实际 ${fmtPct(v.actual)}（${diffTxt}）</span>
    </div>`;
  }).join("");
}

/* ---------- 页面：定投记录表 ---------- */
let filterState = { type: "", name: "", year: "" };

function renderRecordTable(c) {
  // 更新筛选下拉
  const types = [...new Set(db.records.map(r => r.type))];
  const names = [...new Set(db.records.map(r => r.name))];
  const years = [...new Set(db.records.map(r => r.date.slice(0, 4)))].sort().reverse();
  fillSelect($("filterType"), types, "全部类型", filterState.type);
  fillSelect($("filterName"), names, "全部标的", filterState.name);
  fillSelect($("filterYear"), years, "全部年份", filterState.year);
  // 名称联想
  $("nameList").innerHTML = names.map(n => `<option value="${esc(n)}">`).join("");

  const rows = c.recs.slice().reverse().filter(r =>
    (!filterState.type || r.type === filterState.type) &&
    (!filterState.name || r.name === filterState.name) &&
    (!filterState.year || r.date.startsWith(filterState.year))
  );

  $("recordCount").textContent = `共 ${rows.length} 条记录`;
  $("recordsEmpty").style.display = rows.length ? "none" : "block";

  const tbody = $("recordTbody");
  tbody.innerHTML = rows.map(r => {
    const mv = r.mv === "" || r.mv == null ? null : Number(r.mv);
    const pnl = mv == null ? null : mv - r._cumIn;
    const pnlPct = (pnl == null || r._cumIn === 0) ? null : pnl / r._cumIn;
    const h = c.latest[r.name];
    const actualPct = (h && h.mv != null && c.totalMv > 0 && (!mv || h.date === r.date)) ? h.actualPct : null;
    const pnlCls = pnl == null ? "" : (pnl >= 0 ? "pos" : "neg");
    // 实时估值（仅在该标的最新一条记录上展示；纸黄金用上金所金价）
    const isGold = assetClass(r.type) === "黄金";
    const est = isGold ? estimates["GOLD"] : estimates[r.code || ""];
    const isLatestRow = h && h.date === r.date;
    const estCell = (est && (r.code || isGold) && isLatestRow)
      ? `<span class="${Number(est.gszzl) >= 0 ? "pos" : "neg"}" title="${est.mode} ${est.gsz}${isGold ? " 元/克" : ""}（${est.gztime}）">${Number(est.gszzl) >= 0 ? "+" : ""}${est.gszzl}%</span>`
      : "—";
    const sharesCell = ((r.code || isGold) && isLatestRow)
      ? `<input type="number" class="shares-input" data-id="${r.id}" step="0.01" min="0" value="${r.shares ?? ""}" placeholder="${isGold ? "克数" : "份额"}">`
      : (r.shares === "" || r.shares == null ? "—" : fmt(Number(r.shares)));
    return `<tr data-id="${r.id}">
      <td>${r.date}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.code || "—")}</td>
      <td class="num">${fmt(Number(r.amount) || 0)}</td>
      <td class="num">${fmt(r._cumIn)}</td>
      <td class="num">${sharesCell}</td>
      <td class="num">${mv == null ? "—" : fmt(mv)}</td>
      <td class="num">${estCell}</td>
      <td class="num ${pnlCls}">${pnl == null ? "—" : (pnl >= 0 ? "+" : "") + fmt(pnl)}</td>
      <td class="num ${pnlCls}">${pnlPct == null ? "—" : (pnlPct >= 0 ? "+" : "") + fmtPct(pnlPct)}</td>
      <td class="num">${r.target ? Number(r.target) + "%" : "—"}</td>
      <td class="num">${actualPct == null ? "—" : fmtPct(actualPct)}</td>
      <td title="${esc(r.note || "")}">${esc(truncate(r.note || "", 14))}</td>
      <td>
        <button class="op-btn" data-act="edit">编辑</button>
        <button class="op-btn del" data-act="del">删除</button>
      </td>
    </tr>`;
  }).join("");
}

function fillSelect(sel, options, allLabel, current) {
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    options.map(o => `<option ${o === current ? "selected" : ""}>${esc(o)}</option>`).join("");
}
function esc(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

/* ---------- 页面：年度汇总 ---------- */
function renderYearly(c) {
  const years = [...new Set(db.records.map(r => Number(r.date.slice(0, 4))))].sort().reverse();
  const tbody = $("yearlyTbody");
  $("yearlyEmpty").style.display = years.length ? "none" : "block";

  tbody.innerHTML = years.map(y => {
    const yStr = String(y);
    // 全年投入 = 当年所有记录 amount 之和
    const yearIn = db.records.filter(r => r.date.startsWith(yStr)).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    // 年末市值 = 每个标的取 ≤ 该年末的最后一条有市值记录求和
    const mvAt = (endDate) => {
      const last = {};
      db.records.slice().sort((a, b) => a.date.localeCompare(b.date))
        .filter(r => r.date <= endDate && r.mv !== "" && r.mv != null)
        .forEach(r => last[r.name] = r);
      return Object.values(last);
    };
    const yearEndRecs = mvAt(`${y}-12-31`);
    const prevEndRecs = mvAt(`${y - 1}-12-31`);
    const yearEndMv = yearEndRecs.reduce((s, r) => s + Number(r.mv), 0);
    const prevMv = prevEndRecs.reduce((s, r) => s + Number(r.mv), 0);
    const yearPnl = yearEndMv - prevMv - yearIn;
    // 年度收益率 = 年度盈亏 / (年初市值 + 全年投入)
    const base = prevMv + yearIn;
    const rate = base === 0 ? 0 : yearPnl / base;
    // 分类市值
    const cls = { "权益": 0, "债券": 0, "现金": 0, "黄金": 0, "其他": 0 };
    yearEndRecs.forEach(r => cls[assetClass(r.type)] += Number(r.mv));
    const meta = db.yearly.find(x => Number(x.year) === y) || {};
    const pnlCls = yearPnl >= 0 ? "pos" : "neg";
    return `<tr data-year="${y}">
      <td>${y}</td>
      <td class="num">${fmt(yearIn)}</td>
      <td class="num">${fmt(yearEndMv)}</td>
      <td class="num ${pnlCls}">${(yearPnl >= 0 ? "+" : "") + fmt(yearPnl)}</td>
      <td class="num ${pnlCls}">${(rate >= 0 ? "+" : "") + fmtPct(rate)}</td>
      <td class="num">${fmt(cls["权益"])}</td>
      <td class="num">${fmt(cls["债券"])}</td>
      <td class="num">${fmt(cls["现金"] + cls["其他"])}</td>
      <td class="num">${fmt(cls["黄金"])}</td>
      <td>${meta.rebalance || "未记录"}</td>
      <td>
        <button class="op-btn" data-act="yedit">编辑</button>
        ${meta.id ? `<button class="op-btn del" data-act="ydel" data-id="${meta.id}">删除</button>` : ""}
      </td>
    </tr>`;
  }).join("");
}

/* ---------- 页面：止盈提醒 ---------- */
function currentAnnualized(c) {
  if (!db.records.length || c.totalIn === 0) return null;
  const firstDate = db.records.map(r => r.date).sort()[0];
  const days = Math.max(1, (Date.now() - new Date(firstDate).getTime()) / 86400000);
  return (c.totalPnl / c.totalIn) * 365 / days;
}

function renderAlert(c) {
  const a = db.alert;
  $("aTarget").value = a.target ?? 8;
  $("aSellPct").value = a.sellPct ?? 25;
  $("aDest").value = a.dest || "";
  $("aDoneDate").value = a.doneDate || "";
  $("aExecuted").value = a.executed || "否";

  const ann = currentAnnualized(c);
  const banner = $("alertBanner");
  let triggered = false, annTxt = "—";
  if (ann == null) {
    banner.className = "alert-banner idle";
    banner.textContent = "📭 暂无足够数据计算年化收益，请先添加定投记录并填写当前市值";
  } else {
    annTxt = (ann >= 0 ? "+" : "") + fmtPct(ann);
    triggered = ann >= (Number(a.target) || 0) / 100;
    banner.className = "alert-banner " + (triggered ? "trigger" : "ok");
    banner.textContent = triggered
      ? `🔔 触发止盈！当前年化 ${annTxt} ≥ 目标 ${a.target}%，按计划卖出 ${a.sellPct}%（${a.dest || "—"}）`
      : `✅ 尚未触发止盈：当前年化 ${annTxt}，目标年化 ${a.target}%，继续持有定投`;
  }

  $("alertTbody").innerHTML = `<tr>
    <td class="num">${a.target ?? 8}%</td>
    <td class="num">${annTxt}</td>
    <td>${ann == null ? "—" : (triggered ? '<span class="pos">⚠️ 是</span>' : '<span class="neg">否</span>')}</td>
    <td class="num">${a.sellPct ?? 25}%</td>
    <td>${esc(a.dest || "—")}</td>
    <td>${a.doneDate || (a.executed === "是" ? "已完成" : "—")}</td>
  </tr>`;
}

/* ---------- 表单：定投记录 ---------- */
function resetRecordForm() {
  $("recordForm").reset();
  $("editId").value = "";
  $("formTitle").textContent = "➕ 新增记录";
  $("btnSave").textContent = "保存记录";
  $("btnCancelEdit").style.display = "none";
}

$("recordForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("editId").value;
  const rec = {
    id: id || uid(),
    date: $("fDate").value,
    type: $("fType").value,
    name: $("fName").value.trim(),
    code: $("fCode").value.trim(),
    amount: $("fAmount").value === "" ? "" : Number($("fAmount").value),
    shares: $("fShares").value === "" ? "" : Number($("fShares").value),
    mv: $("fMv").value === "" ? "" : Number($("fMv").value),
    target: $("fTarget").value === "" ? "" : Number($("fTarget").value),
    note: $("fNote").value.trim(),
  };
  if (id) {
    const i = db.records.findIndex(r => r.id === id);
    if (i >= 0) db.records[i] = rec;
    toast("已更新记录");
  } else {
    db.records.push(rec);
    toast("已新增记录");
  }
  save(); resetRecordForm(); renderAll();
});

$("btnCancelEdit").addEventListener("click", resetRecordForm);

/* 表格操作（编辑/删除），事件委托 */
$("recordTbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".op-btn");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  if (btn.dataset.act === "edit") {
    const r = db.records.find(x => x.id === id);
    if (!r) return;
    $("editId").value = r.id;
    $("fDate").value = r.date;
    $("fType").value = r.type;
    $("fName").value = r.name;
    $("fCode").value = r.code || "";
    $("fAmount").value = r.amount;
    $("fShares").value = r.shares ?? "";
    $("fMv").value = r.mv;
    $("fTarget").value = r.target;
    $("fNote").value = r.note || "";
    $("formTitle").textContent = "✏️ 编辑记录（" + r.date + " " + r.name + "）";
    $("btnSave").textContent = "更新记录";
    $("btnCancelEdit").style.display = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (btn.dataset.act === "del") {
    if (!confirm("确定删除这条记录吗？删除后累计投入等会自动重算。")) return;
    db.records = db.records.filter(x => x.id !== id);
    save(); renderAll(); toast("已删除");
  }
});

/* 筛选 */
["filterType", "filterName", "filterYear"].forEach(id => {
  $(id).addEventListener("change", () => {
    filterState = { type: $("filterType").value, name: $("filterName").value, year: $("filterYear").value };
    renderRecordTable(computeAll());
  });
});

/* 刷新实时估值 & 表格内份额行内编辑 */
$("btnRefreshEst").addEventListener("click", refreshEstimates);
$("recordTbody").addEventListener("change", (e) => {
  const input = e.target.closest(".shares-input");
  if (!input) return;
  const rec = db.records.find(r => r.id === input.dataset.id);
  if (!rec) return;
  rec.shares = input.value === "" ? "" : Number(input.value);
  save();
  toast(rec.name + " 份额已保存，点「刷新实时估值」可更新市值");
});

/* ---------- 表单：年度汇总 ---------- */
$("yearlyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const year = Number($("yYear").value);
  const rebalance = $("yRebalance").value;
  const exist = db.yearly.find(x => Number(x.year) === year);
  if (exist) { exist.rebalance = rebalance; }
  else { db.yearly.push({ id: uid(), year, rebalance }); }
  save(); renderAll();
  $("yearlyForm").reset(); $("yEditId").value = "";
  $("yearlyFormTitle").textContent = "➕ 补充/编辑年度汇总";
  $("btnCancelYearlyEdit").style.display = "none";
  toast("已保存 " + year + " 年度信息");
});
$("btnCancelYearlyEdit").addEventListener("click", () => {
  $("yearlyForm").reset(); $("yEditId").value = "";
  $("yearlyFormTitle").textContent = "➕ 补充/编辑年度汇总";
  $("btnCancelYearlyEdit").style.display = "none";
});
$("yearlyTbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".op-btn");
  if (!btn) return;
  if (btn.dataset.act === "yedit") {
    const year = btn.closest("tr").dataset.year;
    const meta = db.yearly.find(x => Number(x.year) === Number(year)) || {};
    $("yEditId").value = meta.id || "";
    $("yYear").value = year;
    $("yRebalance").value = meta.rebalance || "";
    $("yearlyFormTitle").textContent = "✏️ 编辑 " + year + " 年度汇总";
    $("btnCancelYearlyEdit").style.display = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (btn.dataset.act === "ydel") {
    db.yearly = db.yearly.filter(x => x.id !== btn.dataset.id);
    save(); renderAll(); toast("已删除年度记录");
  }
});

/* ---------- 表单：止盈设置 ---------- */
$("alertForm").addEventListener("submit", (e) => {
  e.preventDefault();
  db.alert = {
    target: Number($("aTarget").value) || 0,
    sellPct: Number($("aSellPct").value) || 0,
    dest: $("aDest").value.trim(),
    doneDate: $("aDoneDate").value,
    executed: $("aExecuted").value,
  };
  save(); renderAll(); toast("止盈设置已保存");
});

/* ---------- Tab 切换 ---------- */
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + btn.dataset.tab));
});

/* ---------- 数据管理 ---------- */
$("btnExportJson").addEventListener("click", () => {
  download(JSON.stringify(db, null, 2), `投资数据备份_${today()}.json`, "application/json");
  toast("已导出 JSON 备份");
});

$("btnExportCsv").addEventListener("click", () => {
  const c = computeAll();
  const head = ["日期", "定投标的类型", "标的名称", "基金代码", "当月投入金额(元)", "累计总投入(元)", "持仓份额(份)", "当前市值(元)", "持仓盈亏(元)", "盈亏比例", "目标股债占比", "实际股债占比", "备注（估值/操作记录）"];
  const lines = c.recs.map(r => {
    const mv = r.mv === "" || r.mv == null ? null : Number(r.mv);
    const pnl = mv == null ? "" : mv - r._cumIn;
    const pnlPct = (pnl === "" || r._cumIn === 0) ? "" : fmtPct(pnl / r._cumIn);
    const h = c.latest[r.name];
    const actual = (h && h.mv != null && h.date === r.date && c.totalMv > 0) ? fmtPct(h.actualPct) : "";
    return [r.date, r.type, r.name, r.code || "", r.amount, fmt(r._cumIn), r.shares ?? "", mv == null ? "" : fmt(mv), pnl === "" ? "" : fmt(pnl), pnlPct, r.target ? r.target + "%" : "", actual, r.note || ""];
  });
  const csv = "\uFEFF" + [head, ...lines].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  download(csv, `定投记录_${today()}.csv`, "text/csv");
  toast("已导出 CSV，可直接粘贴到 Excel");
});

$("importFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const d = JSON.parse(reader.result);
      if (!Array.isArray(d.records)) throw new Error("格式不正确");
      if (!confirm("导入将覆盖当前全部数据，确定继续吗？")) return;
      db = { records: d.records, yearly: d.yearly || [], alert: d.alert || defaultAlert() };
      save(); renderAll(); toast("导入成功，共 " + db.records.length + " 条记录");
    } catch (err) { alert("导入失败：不是有效的备份文件"); }
    e.target.value = "";
  };
  reader.readAsText(file);
});

$("btnLoadSample").addEventListener("click", () => {
  if (db.records.length && !confirm("载入示例会覆盖现有数据，确定继续吗？")) return;
  const t = today();
  db = {
    records: [
      { id: uid(), date: t, type: "宽基指数", name: "沪深300联接A", code: "110020", amount: 560, shares: "", mv: 528, target: 20, note: "PE分位42%，正常定投" },
      { id: uid(), date: t, type: "纯债基金", name: "XX纯债", code: "", amount: 1960, shares: "", mv: 2530, target: 70, note: "无操作" },
      { id: uid(), date: t, type: "货币基金", name: "XX货基", code: "", amount: 280, shares: "", mv: 280, target: 10, note: "备用弹药" },
      { id: uid(), date: t, type: "纸黄金", name: "工行纸黄金", code: "", amount: 500, shares: "", mv: 500, target: 5, note: "份额填克数，刷新自动按金价算市值" },
    ],
    yearly: [], alert: defaultAlert(),
  };
  // 示例中纯债累计2520，为演示累计效果补一条历史投入
  db.records[1].amount = 1960;
  db.records.push({ id: uid(), date: shiftMonth(t, -1), type: "纯债基金", name: "XX纯债", code: "", amount: 560, shares: "", mv: "", target: 70, note: "上月定投" });
  save(); renderAll(); toast("已载入示例数据");
});

$("btnClear").addEventListener("click", () => {
  if (!confirm("确定清空全部数据吗？此操作不可恢复！")) return;
  if (!confirm("再次确认：真的清空所有投资数据？")) return;
  db = { records: [], yearly: [], alert: defaultAlert() };
  save(); renderAll(); toast("已清空全部数据");
});

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
function today() { return new Date().toISOString().slice(0, 10); }
function shiftMonth(dateStr, delta) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 10);
}

/* ---------- 总渲染 ---------- */
function renderAll() {
  const c = computeAll();
  renderOverview(c);
  renderRatio(c);
  renderRecordTable(c);
  renderYearly(c);
  renderAlert(c);
}

/* ---------- 初始化 ---------- */
$("fDate").value = today();
renderAll();
