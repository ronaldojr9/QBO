// World-class UX, CFO-grade logic (demo). Uses repo JSON files under docs/data.

const fmtMoney = (n) => Number.isFinite(n)
  ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : '—';
const fmtPct = (n) => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const fmtDeltaPct = (n) => {
  if (!Number.isFinite(n)) return '—';
  const s = (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
  return s;
};

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(s) {
  if (!s) return null;
  const [mm, dd, yyyy] = String(s).split('/').map(x => parseInt(x, 10));
  if (!yyyy || !mm || !dd) return null;
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function monthKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function within(d, from, to) {
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

function groupSum(rows, keyFn, valFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = valFn(r);
    if (k == null || !Number.isFinite(v)) continue;
    map.set(k, (map.get(k) || 0) + v);
  }
  return map;
}

function bucketAge(days) {
  if (days <= 0) return 'Not due';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

async function loadJSON(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

async function loadFromFileList(fileList) {
  const files = Array.from(fileList || []);
  const parsed = [];
  for (const f of files) {
    try {
      const txt = await f.text();
      parsed.push({ name: f.name, json: JSON.parse(txt) });
    } catch {
      // ignore
    }
  }

  const norm = (s) => String(s || '').toLowerCase();
  const pick = (rx) => parsed.find(p => rx.test(norm(p.name)))?.json || null;

  const coa = pick(/chart.*accounts|coa/);
  const invoices = pick(/customer.*invoices|invoices/);
  const bills = pick(/vendor.*bills|bills/);
  const items = pick(/items/);
  const payments = pick(/customer.*payments|payments/);

  return {
    coa: coa || [],
    invoices: invoices || [],
    bills: bills || [],
    items: items || [],
    payments: payments || []
  };
}

function deriveReportDate({ invoices, bills, payments }) {
  let max = null;
  const all = [];
  for (const inv of invoices) all.push(parseDate(inv['Invoice Date']), parseDate(inv['Due Date']));
  for (const b of bills) all.push(parseDate(b['Bill Date']), parseDate(b['Due Date']));
  for (const p of payments) all.push(parseDate(p['Payment Date']));
  for (const d of all) {
    if (!d) continue;
    if (!max || d > max) max = d;
  }
  return max || new Date();
}

function buildInvoiceLines({ invoices, itemsByName }) {
  // Line-level facts = better margin truth + better anomaly detection.
  const out = [];
  for (const line of invoices) {
    const customer = line['Customer'] || 'Unknown';
    const invDate = parseDate(line['Invoice Date']);
    const dueDate = parseDate(line['Due Date']);
    const terms = line['Terms'] || '';
    if (!invDate) continue;

    const itemName = line['Item'] || '';
    const qty = safeNum(line['Qty']);
    const revenue = safeNum(line['Line Total']);
    const item = itemsByName.get(itemName);
    const unitCost = item ? safeNum(item['Purchase Cost']) : NaN;
    const estCogs = Number.isFinite(unitCost) ? (unitCost * qty) : 0;

    out.push({
      customer,
      invDate,
      dueDate,
      terms,
      itemName,
      qty,
      revenue,
      unitCost,
      estCogs,
      hasItemMap: Boolean(item)
    });
  }
  return out;
}

function buildInvoiceFacts({ invoiceLines }) {
  // Group invoice lines into an invoice-ish header.
  const map = new Map();
  for (const line of invoiceLines) {
    const key = `${line.customer}||${line.invDate.toISOString()}||${(line.dueDate ? line.dueDate.toISOString() : '')}||${line.terms}`;
    const row = map.get(key) || { customer: line.customer, invDate: line.invDate, dueDate: line.dueDate, terms: line.terms, revenue: 0, estCogs: 0, lines: 0 };
    row.revenue += line.revenue;
    row.estCogs += line.estCogs;
    row.lines += 1;
    map.set(key, row);
  }
  return Array.from(map.values());
}

function buildBillFacts({ bills }) {
  const map = new Map();
  for (const line of bills) {
    const vendor = line['Vendor'] || 'Unknown';
    const billDate = parseDate(line['Bill Date']);
    const dueDate = parseDate(line['Due Date']);
    const terms = line['Terms'] || '';
    if (!billDate) continue;

    const key = `${vendor}||${billDate.toISOString()}||${(dueDate ? dueDate.toISOString() : '')}||${terms}`;
    const row = map.get(key) || { vendor, billDate, dueDate, terms, amount: 0, lines: 0 };

    row.amount += safeNum(line['Line Total']);
    row.lines += 1;
    map.set(key, row);
  }
  return Array.from(map.values());
}

function plotMonthlyTrend({ invoiceFacts, from, to, customer }) {
  const rows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const revByMonth = groupSum(rows, r => monthKey(r.invDate), r => r.revenue);
  const cogsByMonth = groupSum(rows, r => monthKey(r.invDate), r => r.estCogs);
  const months = Array.from(new Set([...revByMonth.keys(), ...cogsByMonth.keys()])).sort();
  const rev = months.map(m => revByMonth.get(m) || 0);
  const cogs = months.map(m => cogsByMonth.get(m) || 0);

  Plotly.react('revCogs', [
    { x: months, y: rev, type: 'scatter', mode: 'lines+markers', name: 'Revenue', line: { color: '#22d3ee', width: 3 } },
    { x: months, y: cogs, type: 'scatter', mode: 'lines+markers', name: 'COGS (proxy)', line: { color: '#f472b6', width: 2, dash: 'dot' } }
  ], {
    margin: { l: 50, r: 10, t: 10, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    legend: { orientation: 'h', y: -0.2 }
  }, { displayModeBar: false, responsive: true });
}

function plotIndicator({ invTotal, ar90p, ap90p }) {
  const risk = (ar90p > 0 ? 1 : 0) + (ap90p > 0 ? 1 : 0) + (invTotal > 0 ? 1 : 0);
  const labels = ['Working capital flags'];
  Plotly.react('ccc', [{
    type: 'indicator',
    mode: 'number',
    value: risk,
    number: { valueformat: ',.0f' },
    title: { text: `Working Capital Risk Score <br><span style="font-size:11px;color:#94a3b8">AR 90+ / AP 90+ / Inventory size</span>` },
    domain: { x: [0, 1], y: [0, 1] }
  }], {
    margin: { l: 20, r: 20, t: 20, b: 20 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' }
  }, { displayModeBar: false, responsive: true });
}

function plotAging({ elId, facts, asOf, amountField, dueField, onBarClick }) {
  const buckets = new Map([['Not due',0],['1-30',0],['31-60',0],['61-90',0],['90+',0]]);
  for (const r of facts) {
    const due = r[dueField];
    if (!due) continue;
    const daysPastDue = Math.floor((asOf - due) / (24*3600*1000));
    const b = bucketAge(daysPastDue);
    buckets.set(b, (buckets.get(b) || 0) + safeNum(r[amountField]));
  }

  const x = Array.from(buckets.keys());
  const y = x.map(k => buckets.get(k) || 0);

  Plotly.react(elId, [{
    x, y,
    type: 'bar',
    marker: { color: ['#334155','#22d3ee','#8b5cf6','#f59e0b','#ef4444'] },
    hovertemplate: '%{x}<br>$%{y:,.0f}<extra></extra>'
  }], {
    margin: { l: 50, r: 10, t: 10, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)' }
  }, { displayModeBar: false, responsive: true });

  const el = document.getElementById(elId);
  if (el && onBarClick) {
    el.on('plotly_click', (evt) => {
      const bucket = evt?.points?.[0]?.x;
      if (!bucket) return;
      onBarClick(bucket);
    });
  }

  return { ninetyPlus: buckets.get('90+') || 0, buckets };
}

function plotTopCustomers({ invoiceFacts, from, to, customer, onCustomerClick }) {
  const rows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const revByCust = groupSum(rows, r => r.customer, r => r.revenue);
  const cogsByCust = groupSum(rows, r => r.customer, r => r.estCogs);

  const pairs = Array.from(revByCust.entries()).map(([cust, rev]) => {
    const cogs = cogsByCust.get(cust) || 0;
    const gm = rev - cogs;
    return { cust, rev, gm, gmPct: rev ? gm / rev : NaN };
  }).sort((a,b) => b.rev - a.rev).slice(0, 12);

  Plotly.react('topCustomers', [{
    x: pairs.map(p => p.cust),
    y: pairs.map(p => p.rev),
    type: 'bar',
    marker: { color: '#22d3ee' },
    hovertemplate: '%{x}<br>$%{y:,.0f}<extra></extra>'
  }], {
    margin: { l: 50, r: 10, t: 10, b: 120 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)', tickangle: 35 }
  }, { displayModeBar: false, responsive: true });

  const chart = document.getElementById('topCustomers');
  if (chart && onCustomerClick) {
    chart.on('plotly_click', (evt) => {
      const cust = evt?.points?.[0]?.x;
      if (!cust) return;
      onCustomerClick(cust);
    });
  }

  const tbody = document.querySelector('#customerTable tbody');
  tbody.innerHTML = '';
  for (const p of pairs) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.cust}</td>
      <td style="text-align:right">${fmtMoney(p.rev)}</td>
      <td style="text-align:right">${fmtMoney(p.gm)}</td>
      <td style="text-align:right">${fmtPct(p.gmPct)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function plotInventory({ coa }) {
  const inv = (coa || [])
    .filter(a => String(a['Detail Type'] || '').toLowerCase().includes('inventory') || String(a['Account Name']||'').toLowerCase().includes('inventory'))
    .map(a => ({ name: a['Account Name'], amt: safeNum(a['Opening Balance']) }))
    .filter(a => a.amt > 0);

  Plotly.react('inv', [{
    labels: inv.map(i => i.name),
    values: inv.map(i => i.amt),
    type: 'pie',
    hole: 0.5,
    marker: { colors: ['#22d3ee','#8b5cf6','#f59e0b','#f472b6','#94a3b8'] }
  }], {
    margin: { l: 10, r: 10, t: 10, b: 10 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    legend: { orientation: 'h' }
  }, { displayModeBar: false, responsive: true });

  return sum(inv.map(i => i.amt));
}

function setPill(el, text, cls) {
  el.textContent = text;
  el.classList.remove('good', 'warn', 'bad');
  if (cls) el.classList.add(cls);
}

function renderNotes({ revenue, gmPct, ar90p, ap90p, asOf, top1Share, top5Share, avgTermDays }) {
  const el = document.querySelector('#notes');
  const parts = [];

  // GM diagnostics
  if (Number.isFinite(gmPct) && gmPct < 0.30) {
    parts.push(`<div class="warn"><strong>GM% proxy &lt; 30%.</strong> Treat as red alarm: verify pricing discipline, purchase price variance, labor efficiency, and whether inventory/absorption is distorting COGS.</div>`);
  } else if (Number.isFinite(gmPct) && gmPct < 0.40) {
    parts.push(`<div class="note"><strong>GM% proxy 30–40%.</strong> Common for job shops—but volatility matters more than the level. We’ll add variance/absorption pages once ERP exports are wired.</div>`);
  } else {
    parts.push(`<div class="note"><strong>GM% proxy &gt; 40%.</strong> Either strong value pricing/mix or (more commonly) incomplete COGS capture. Next step is reconciling to GL + WIP/inventory movement.</div>`);
  }

  // AR/AP
  if (ar90p > 0) parts.push(`<div class="warn"><strong>AR 90+:</strong> ${fmtMoney(ar90p)}. Cash action: dispute triage, enforce terms, stop shipping on chronic offenders, tighten ship/invoice timing.</div>`);
  if (ap90p > 0) parts.push(`<div class="warn"><strong>AP 90+:</strong> ${fmtMoney(ap90p)}. Operational risk: credit holds + price creep + shortened terms.</div>`);

  if (Number.isFinite(top1Share) && Number.isFinite(top5Share)) {
    parts.push(`<div class="note"><strong>Concentration:</strong> Top 1 = ${(top1Share*100).toFixed(1)}% of revenue; Top 5 = ${(top5Share*100).toFixed(1)}%. If terms are long, concentration will amplify cash volatility.</div>`);
  }
  if (Number.isFinite(avgTermDays)) {
    parts.push(`<div class="note"><strong>Terms mix:</strong> weighted average terms ≈ ${avgTermDays.toFixed(0)} days (invoice terms). If this drifts up without price increases, you’re financing customers.</div>`);
  }

  parts.push(`<div style="color:#94a3b8;font-size:12px;margin-top:8px">Aging as-of: <span class="pill">${asOf.toISOString().slice(0,10)}</span>. Revenue basis: invoices. COGS basis: item purchase cost proxy.</div>`);

  el.innerHTML = parts.join('\n');
}

function renderAnoms({ invoiceFacts, billFacts, itemsMissingMap }) {
  const el = document.querySelector('#anoms');

  const issues = [];

  const missingCogs = invoiceFacts.filter(r => r.revenue > 0 && r.estCogs === 0).length;
  if (missingCogs > 0) {
    issues.push({
      title: 'COGS proxy missing on invoices',
      body: `${missingCogs} invoice(s) have revenue but no item purchase-cost match. This is usually item master mismatch (naming/SKU drift) or service lines mixed into product invoices.`
    });
  }

  if (itemsMissingMap?.length) {
    const top = itemsMissingMap.slice(0, 8)
      .map(x => `<div style="display:flex;justify-content:space-between;gap:10px"><span>${x.item}</span><span>${fmtMoney(x.revenue)}</span></div>`)
      .join('');
    issues.push({
      title: 'Top item mapping gaps (fix these first)',
      body: `These item names appear on invoices but do not match the Items master (so COGS proxy = 0).<div style="margin-top:8px">${top}</div>`
    });
  }

  const noDue = invoiceFacts.filter(r => !r.dueDate).length;
  if (noDue > 0) {
    issues.push({
      title: 'Invoices missing due dates',
      body: `${noDue} invoice(s) missing due date. That breaks AR aging and cash forecasting. Fix: enforce terms + due dates in QBO.`
    });
  }

  const lateAP = billFacts.filter(r => r.dueDate && (new Date() - r.dueDate) > 90*24*3600*1000).length;
  if (lateAP > 0) {
    issues.push({
      title: 'AP risk: very old bills detected',
      body: `${lateAP} bill(s) are >90 days past due (based on today). That can trigger credit holds and weaken purchasing leverage.`
    });
  }

  if (!issues.length) {
    el.innerHTML = `<div class="note"><strong>No anomalies triggered in the current view.</strong> Next step is adding ERP-driven flags: WIP build distortion, scrap spikes, labor efficiency variance, and OH absorption drift.</div>`;
    return;
  }

  el.innerHTML = issues.map(i => `
    <div class="warn"><strong>${i.title}</strong><div style="margin-top:6px;color:#fde68a">${i.body}</div></div>
  `).join('');
}

function wireNav() {
  const nav = document.querySelector('#nav');
  const title = document.querySelector('#pageTitle');
  const titleMap = {
    exec: 'Executive',
    cash: 'Cash + AR/AP',
    margin: 'Gross Margin',
    inventory: 'Inventory + WIP',
    customers: 'Customers',
    anoms: 'Anomalies'
  };

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const tab = btn.getAttribute('data-tab');

    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    for (const s of document.querySelectorAll('.section')) s.classList.remove('active');
    document.querySelector(`#tab-${tab}`).classList.add('active');

    title.textContent = titleMap[tab] || 'Dashboard';

    // Resize plots on tab change for crisp layout
    setTimeout(() => {
      for (const id of ['revCogs','ccc','arAging','apAging','topCustomers','inv']) {
        const el = document.getElementById(id);
        if (el) Plotly.Plots.resize(el);
      }
    }, 50);
  });
}

let __drawerCsv = null;

function openDrawer({ title, sub, html, csv }) {
  const drawer = document.querySelector('#drawer');
  const scrim = document.querySelector('#scrim');
  document.querySelector('#drawerTitle').textContent = title || 'Details';
  document.querySelector('#drawerSub').textContent = sub || '';
  document.querySelector('#drawerBody').innerHTML = html || '';
  __drawerCsv = csv || null;
  drawer.classList.add('open');
  scrim.classList.add('open');
}

function closeDrawer() {
  document.querySelector('#drawer')?.classList.remove('open');
  document.querySelector('#scrim')?.classList.remove('open');
}

function toast(msg) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function downloadText(filename, text, mime='text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireDrawer() {
  document.querySelector('#drawerClose')?.addEventListener('click', closeDrawer);
  document.querySelector('#scrim')?.addEventListener('click', closeDrawer);
  document.querySelector('#drawerDownload')?.addEventListener('click', () => {
    if (!__drawerCsv) { toast('No CSV available for this view'); return; }
    const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
    downloadText(`drilldown-${ts}.csv`, __drawerCsv, 'text/csv');
    toast('Downloaded CSV');
  });
}

function moneyCell(n) {
  return `<td style="text-align:right">${fmtMoney(n)}</td>`;
}

function renderFocusList({ elId, rows, kind }) {
  // kind: 'AR' | 'AP'
  const el = document.getElementById(elId);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div style="color:#94a3b8">No past-due items in the current filter window.</div>`;
    return;
  }

  const header = kind === 'AR'
    ? '<tr><th>Customer</th><th>Invoice date</th><th>Due</th><th>Bucket</th><th style="text-align:right">Amount</th></tr>'
    : '<tr><th>Vendor</th><th>Bill date</th><th>Due</th><th>Bucket</th><th style="text-align:right">Amount</th></tr>';

  const now = new Date();

  const body = rows.slice(0, 12).map(r => {
    const a = kind === 'AR' ? r.customer : r.vendor;
    const d1 = kind === 'AR' ? r.invDate : r.billDate;
    const d2 = r.dueDate;
    const amt = kind === 'AR' ? r.revenue : r.amount;
    const daysPast = d2 ? Math.floor((now - d2)/(24*3600*1000)) : 0;
    const bucket = bucketAge(daysPast);
    return `<tr><td>${a}</td><td>${d1 ? d1.toISOString().slice(0,10) : ''}</td><td>${d2 ? d2.toISOString().slice(0,10) : ''}</td><td>${bucket}</td>${moneyCell(amt)}</tr>`;
  }).join('');

  el.innerHTML = `
    <table class="table">
      <thead>${header}</thead>
      <tbody>${body}</tbody>
    </table>
    <div style="color:#94a3b8;font-size:12px;margin-top:8px">Showing top ${Math.min(12, rows.length)} items by amount.</div>
  `;
}

function renderCollectionsByCustomer({ invoiceLines, asOf, elId }) {
  const el = document.getElementById(elId);
  if (!el) return;

  const rows = invoiceLines
    .filter(l => l.dueDate)
    .map(l => {
      const daysPast = Math.floor((asOf - l.dueDate)/(24*3600*1000));
      return { ...l, daysPast, bucket: bucketAge(daysPast) };
    })
    .filter(l => l.daysPast > 0);

  const map = new Map();
  for (const l of rows) {
    const r = map.get(l.customer) || { customer: l.customer, totalPastDue: 0, b90: 0, b61: 0, b31: 0, b1: 0, count: 0 };
    r.totalPastDue += l.revenue;
    r.count += 1;
    if (l.bucket === '90+') r.b90 += l.revenue;
    else if (l.bucket === '61-90') r.b61 += l.revenue;
    else if (l.bucket === '31-60') r.b31 += l.revenue;
    else if (l.bucket === '1-30') r.b1 += l.revenue;
    map.set(l.customer, r);
  }

  const out = Array.from(map.values()).sort((a,b) => b.totalPastDue - a.totalPastDue).slice(0, 15);

  const action = (r) => {
    if (r.b90 > 0) return 'Escalate: stop-ship / exec outreach';
    if (r.b61 > 0) return 'Dispute triage + payment plan';
    if (r.b31 > 0) return 'Collections cadence + confirm receipt';
    return 'Reminder + tighten ship/invoice timing';
  };

  el.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Customer</th>
          <th style="text-align:right">Past due</th>
          <th style="text-align:right">90+</th>
          <th style="text-align:right">31–90</th>
          <th>Recommended action</th>
        </tr>
      </thead>
      <tbody>
        ${out.map(r => `
          <tr>
            <td>${r.customer}</td>
            <td style="text-align:right">${fmtMoney(r.totalPastDue)}</td>
            <td style="text-align:right">${fmtMoney(r.b90)}</td>
            <td style="text-align:right">${fmtMoney(r.b31 + r.b61)}</td>
            <td>${action(r)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div style="color:#94a3b8;font-size:12px;margin-top:8px">Top 15 past-due customers. This is your weekly collections meeting agenda.</div>
  `;
}

function startApp(data) {
  const { coa, invoices, bills, items, payments } = data;

  document.querySelector('#dataStatus').textContent = `Loaded: COA (${coa.length}), invoices (${invoices.length}), bills (${bills.length}), items (${items.length})`;

  const itemsByName = new Map(items.map(i => [i['Item Name'], i]));
  const invoiceLinesAll = buildInvoiceLines({ invoices, itemsByName });
  const billFactsAll = buildBillFacts({ bills });
  const asOf = deriveReportDate({ invoices, bills, payments });
  const asOfPill = document.querySelector('#asOfPill');
  if (asOfPill) asOfPill.textContent = asOf.toISOString().slice(0,10);

  // Defaults: last 12 months (with persistence)
  const invDates = invoiceLinesAll.map(r => r.invDate).filter(Boolean).sort((a,b)=>a-b);
  const maxD = invDates[invDates.length - 1] || asOf;
  const fromD = new Date(maxD.getTime() - 365*24*3600*1000);
  const iso = d => d.toISOString().slice(0,10);

  const saved = (() => {
    try { return JSON.parse(localStorage.getItem('qbo_dash_filters') || 'null'); } catch { return null; }
  })();

  document.querySelector('#from').value = saved?.from || iso(fromD);
  document.querySelector('#to').value = saved?.to || iso(maxD);

  // Customer list
  const customerSel = document.querySelector('#customer');
  customerSel.innerHTML = '<option value="">All</option>';
  for (const c of Array.from(new Set(invoiceLinesAll.map(r => r.customer))).sort()) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    customerSel.appendChild(opt);
  }
  if (saved?.customer) customerSel.value = saved.customer;

  function refresh() {
    const fromStr = document.querySelector('#from').value;
    const toStr = document.querySelector('#to').value;
    const from = fromStr ? new Date(fromStr + 'T00:00:00Z') : null;
    const to = toStr ? new Date(toStr + 'T23:59:59Z') : null;
    const customer = customerSel.value || '';

    localStorage.setItem('qbo_dash_filters', JSON.stringify({ from: fromStr, to: toStr, customer }));

    const sub = document.querySelector('#subTitle');
    if (sub) {
      const custText = customer ? ` · Customer: ${customer}` : '';
      sub.textContent = `Period: ${fromStr || '—'} → ${toStr || '—'}${custText}`;
    }

    const invoiceLines = invoiceLinesAll.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
    const invoiceFacts = buildInvoiceFacts({ invoiceLines });
    const billFacts = billFactsAll.filter(r => within(r.billDate, from, to));

    const revenue = sum(invoiceLines.map(r => r.revenue));
    const cogs = sum(invoiceLines.map(r => r.estCogs));
    const gm = revenue - cogs;
    const gmPct = revenue ? gm / revenue : NaN;

    const windowMs = (from && to) ? (to - from) : null;
    let prevFrom = null, prevTo = null;
    if (windowMs && windowMs > 0) {
      prevTo = new Date(from.getTime() - 1);
      prevFrom = new Date(prevTo.getTime() - windowMs);
    }
    const prevLines = prevFrom && prevTo
      ? invoiceLinesAll.filter(r => within(r.invDate, prevFrom, prevTo) && (!customer || r.customer === customer))
      : [];
    const prevRevenue = sum(prevLines.map(r => r.revenue));
    const prevCogs = sum(prevLines.map(r => r.estCogs));
    const prevGmPct = prevRevenue ? (prevRevenue - prevCogs) / prevRevenue : NaN;

    document.querySelector('#kpiRevenue').textContent = fmtMoney(revenue);
    document.querySelector('#kpiRevenueHint').textContent = `${invoiceFacts.length.toLocaleString()} invoices (grouped)`;
    document.querySelector('#kpiCogs').textContent = fmtMoney(cogs);
    document.querySelector('#kpiGm').textContent = fmtPct(gmPct);
    document.querySelector('#kpiGmHint').textContent = `GM $: ${fmtMoney(gm)}`;

    const revDeltaEl = document.querySelector('#kpiRevenueDelta');
    const cogsDeltaEl = document.querySelector('#kpiCogsDelta');
    const gmDeltaEl = document.querySelector('#kpiGmDelta');
    if (revDeltaEl) {
      const d = (prevRevenue && revenue) ? (revenue - prevRevenue) / prevRevenue : NaN;
      revDeltaEl.textContent = prevFrom ? `vs prior period: ${fmtDeltaPct(d)} (${fmtMoney(revenue - prevRevenue)})` : 'vs prior period: —';
      revDeltaEl.style.color = (Number.isFinite(d) && d < 0) ? '#fecaca' : '#bbf7d0';
    }
    if (cogsDeltaEl) {
      const d = (prevCogs && cogs) ? (cogs - prevCogs) / prevCogs : NaN;
      cogsDeltaEl.textContent = prevFrom ? `vs prior period: ${fmtDeltaPct(d)} (${fmtMoney(cogs - prevCogs)})` : 'vs prior period: —';
      cogsDeltaEl.style.color = (Number.isFinite(d) && d > 0) ? '#fde68a' : '#bbf7d0';
    }
    if (gmDeltaEl) {
      const d = (Number.isFinite(prevGmPct) && Number.isFinite(gmPct)) ? (gmPct - prevGmPct) : NaN;
      gmDeltaEl.textContent = prevFrom ? `vs prior period: ${(Number.isFinite(d) ? ((d>=0?'+':'') + (d*100).toFixed(1) + ' pts') : '—')}` : 'vs prior period: —';
      gmDeltaEl.style.color = (Number.isFinite(d) && d < 0) ? '#fecaca' : '#bbf7d0';
    }

    setPill(document.querySelector('#pillRev'), revenue > 0 ? 'Active' : 'No data', revenue > 0 ? 'good' : 'warn');
    setPill(document.querySelector('#pillCogs'), cogs > 0 ? 'Mapped' : 'Missing', cogs > 0 ? 'good' : 'warn');
    const gmCls = !Number.isFinite(gmPct) ? 'warn' : (gmPct < 0.30 ? 'bad' : (gmPct < 0.40 ? 'warn' : 'good'));
    setPill(document.querySelector('#pillGm'), Number.isFinite(gmPct) ? 'Signal' : '—', gmCls);

    plotMonthlyTrend({ invoiceFacts, from, to, customer });

    const drillRows = (kind, bucket) => {
      const rows = kind === 'AR' ? invoiceFacts : billFacts;
      const amountField = kind === 'AR' ? 'revenue' : 'amount';
      const nameField = kind === 'AR' ? 'customer' : 'vendor';
      const dateField = kind === 'AR' ? 'invDate' : 'billDate';

      const filtered = rows.filter(r => {
        if (!r.dueDate) return false;
        const daysPastDue = Math.floor((asOf - r.dueDate) / (24*3600*1000));
        return bucketAge(daysPastDue) === bucket;
      }).sort((a,b) => safeNum(b[amountField]) - safeNum(a[amountField]));

      const csv = [
        [kind === 'AR' ? 'Customer' : 'Vendor', kind === 'AR' ? 'InvoiceDate' : 'BillDate', 'DueDate', 'Terms', 'Lines', 'Amount'].join(','),
        ...filtered.map(r => {
          const a = String(r[nameField] ?? '').replace(/"/g,'""');
          const d1 = r[dateField] ? r[dateField].toISOString().slice(0,10) : '';
          const d2 = r.dueDate ? r.dueDate.toISOString().slice(0,10) : '';
          const terms = String(r.terms ?? '').replace(/"/g,'""');
          const lines = safeNum(r.lines);
          const amt = safeNum(r[amountField]);
          return `"${a}",${d1},${d2},"${terms}",${lines},${amt}`;
        })
      ].join('\n');

      const html = `
        <table class="table">
          <thead><tr>
            <th>${kind === 'AR' ? 'Customer' : 'Vendor'}</th>
            <th>${kind === 'AR' ? 'Invoice date' : 'Bill date'}</th>
            <th>Due</th>
            <th>Terms</th>
            <th style="text-align:right">Lines</th>
            <th style="text-align:right">Amount</th>
          </tr></thead>
          <tbody>
            ${filtered.slice(0, 200).map(r => `
              <tr>
                <td>${r[nameField]}</td>
                <td>${r[dateField] ? r[dateField].toISOString().slice(0,10) : ''}</td>
                <td>${r.dueDate ? r.dueDate.toISOString().slice(0,10) : ''}</td>
                <td>${r.terms || ''}</td>
                <td style="text-align:right">${safeNum(r.lines)}</td>
                <td style="text-align:right">${fmtMoney(safeNum(r[amountField]))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <div style="color:#94a3b8;font-size:12px;margin-top:8px">Showing up to 200 rows. Sort: largest first. Use download for full CSV.</div>
      `;

      openDrawer({ title: `${kind} detail — ${bucket}`, sub: `As-of ${asOf.toISOString().slice(0,10)} · Rows: ${filtered.length}`, html, csv });
    };

    const ar = plotAging({ elId: 'arAging', facts: invoiceFacts, asOf, amountField: 'revenue', dueField: 'dueDate', onBarClick: (bucket) => drillRows('AR', bucket) });
    const ap = plotAging({ elId: 'apAging', facts: billFacts, asOf, amountField: 'amount', dueField: 'dueDate', onBarClick: (bucket) => drillRows('AP', bucket) });

    plotTopCustomers({ invoiceFacts, from, to, customer, onCustomerClick: (cust) => { customerSel.value = cust; refresh(); } });
    const invTotal = plotInventory({ coa });

    plotIndicator({ invTotal, ar90p: ar.ninetyPlus, ap90p: ap.ninetyPlus });

    const flagsCount = (ar.ninetyPlus > 0 ? 1 : 0) + (ap.ninetyPlus > 0 ? 1 : 0) + (invTotal > 0 ? 1 : 0);
    document.querySelector('#kpiFlags').textContent = String(flagsCount);
    setPill(document.querySelector('#pillFlags'), flagsCount ? 'Review' : 'OK', flagsCount ? 'warn' : 'good');

    const frictionHint = document.querySelector('#kpiFrictionHint');
    if (frictionHint) {
      frictionHint.textContent = `AR 90+: ${fmtMoney(ar.ninetyPlus)} · AP 90+: ${fmtMoney(ap.ninetyPlus)} · Inv: ${fmtMoney(invTotal)}`;
      frictionHint.style.color = (flagsCount ? '#fde68a' : '#bbf7d0');
    }

    // Concentration + terms mix
    const revByCust = groupSum(invoiceFacts, r => r.customer, r => r.revenue);
    const revPairs = Array.from(revByCust.entries()).map(([cust, rev]) => ({ cust, rev })).sort((a,b) => b.rev - a.rev);
    const totalRev = sum(revPairs.map(x => x.rev));
    const top1Share = totalRev ? (revPairs[0]?.rev || 0) / totalRev : NaN;
    const top5Share = totalRev ? sum(revPairs.slice(0,5).map(x => x.rev)) / totalRev : NaN;

    const termDays = (t) => { const m = String(t || '').match(/(\d+)/); return m ? Number(m[1]) : NaN; };
    const termWeighted = invoiceFacts.map(r => { const d = termDays(r.terms); return Number.isFinite(d) ? { days: d, w: r.revenue } : null; }).filter(Boolean);
    const avgTermDays = termWeighted.length ? (sum(termWeighted.map(x => x.days * x.w)) / sum(termWeighted.map(x => x.w))) : NaN;

    const conc = document.querySelector('#concentration');
    if (conc) {
      const top1 = revPairs[0];
      const top5 = revPairs.slice(0,5);
      conc.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="pill">Top 1 share: ${Number.isFinite(top1Share) ? (top1Share*100).toFixed(1)+'%' : '—'}</div>
          <div class="pill">Top 5 share: ${Number.isFinite(top5Share) ? (top5Share*100).toFixed(1)+'%' : '—'}</div>
        </div>
        <div style="margin-top:10px;color:#94a3b8;font-size:12px">Top customer: <span style="color:#e5e7eb">${top1 ? top1.cust : '—'}</span> (${top1 ? fmtMoney(top1.rev) : '—'})</div>
        <div style="margin-top:8px">
          ${(top5.length ? top5.map(x => `<div style="display:flex;justify-content:space-between;gap:10px;color:#cbd5e1"><span>${x.cust}</span><span>${fmtMoney(x.rev)}</span></div>`).join('') : '<div style="color:#94a3b8">No data</div>')}
        </div>
      `;
    }

    const termsBuckets = new Map();
    for (const r of invoiceFacts) {
      const t = r.terms || 'Unknown';
      termsBuckets.set(t, (termsBuckets.get(t) || 0) + r.revenue);
    }
    const tx = Array.from(termsBuckets.keys());
    const ty = tx.map(k => termsBuckets.get(k) || 0);
    Plotly.react('termsMix', [{ x: tx, y: ty, type: 'bar', marker: { color: '#8b5cf6' }, hovertemplate: '%{x}<br>$%{y:,.0f}<extra></extra>' }], {
      margin: { l: 50, r: 10, t: 10, b: 80 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#e5e7eb' },
      yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
      xaxis: { gridcolor: 'rgba(148,163,184,.12)', tickangle: 30 }
    }, { displayModeBar: false, responsive: true });

    const itemsMissingMap = (() => {
      const m = new Map();
      for (const l of invoiceLines) {
        if (!l.hasItemMap) m.set(l.itemName || 'Unknown item', (m.get(l.itemName || 'Unknown item') || 0) + l.revenue);
      }
      return Array.from(m.entries()).map(([item, revenue]) => ({ item, revenue })).sort((a,b)=>b.revenue-a.revenue);
    })();

    renderNotes({ revenue, gmPct, ar90p: ar.ninetyPlus, ap90p: ap.ninetyPlus, asOf, top1Share, top5Share, avgTermDays });
    renderAnoms({ invoiceFacts, billFacts, itemsMissingMap });

    renderCollectionsByCustomer({ invoiceLines, asOf, elId: 'collections' });

    const pastDueAR = invoiceFacts.filter(r => r.dueDate && (asOf - r.dueDate) > 0).sort((a,b) => b.revenue - a.revenue);
    const pastDueAP = billFacts.filter(r => r.dueDate && (asOf - r.dueDate) > 0).sort((a,b) => b.amount - a.amount);
    renderFocusList({ elId: 'arFocus', rows: pastDueAR, kind: 'AR' });
    renderFocusList({ elId: 'apFocus', rows: pastDueAP, kind: 'AP' });
  }

  document.querySelector('#refresh').onclick = refresh;
  refresh();
  toast('Ready');
}

async function main() {
  wireNav();
  wireDrawer();

  document.querySelector('#reset')?.addEventListener('click', () => {
    localStorage.removeItem('qbo_dash_filters');
    location.reload();
  });

  document.querySelector('#help')?.addEventListener('click', () => {
    openDrawer({
      title: 'How to use this dashboard',
      sub: 'Operator-first workflow (Cash → Margin → Working Capital)',
      html: `
        <div style="color:#e5e7eb">
          <div style="color:#94a3b8">This dashboard is intentionally built for manufacturing CFO decisions, not generic BI.</div>
          <div style="margin-top:12px" class="note"><strong>1) Start with Cash tab</strong><br/>Click AR/AP aging bars to drill into the underlying invoices/bills. Use the focus lists to drive weekly collections + vendor risk calls.</div>
          <div class="note"><strong>2) Executive tab</strong><br/>Use KPI deltas to spot directionally wrong trends fast (revenue up, GM% down → pricing/PPV/labor/absorption).</div>
          <div class="note"><strong>3) Customers tab</strong><br/>Click a customer bar to filter the entire dashboard. Concentration + terms drive cash volatility.</div>
          <div class="warn"><strong>Important:</strong> COGS/GM are proxies until we connect ERP/WIP/standard cost + variances.</div>
        </div>
      `
    });
  });

  const loading = document.querySelector('#loading');

  // Local-file loader (for downloaded zip opened via file://)
  const loadBtn = document.querySelector('#loadLocal');
  const fileInput = document.querySelector('#localFiles');
  if (loadBtn && fileInput) {
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
      const data = await loadFromFileList(e.target.files);
      if (loading) loading.style.display = 'none';
      startApp(data);
    });
  }

  try {
    const [coa, invoices, bills, items, payments] = await Promise.all([
      loadJSON('./data/chart_of_accounts.json'),
      loadJSON('./data/customer_invoices.json'),
      loadJSON('./data/vendor_bills.json'),
      loadJSON('./data/items.json'),
      loadJSON('./data/customer_payments.json').catch(() => [])
    ]);
    if (loading) loading.style.display = 'none';
    startApp({ coa, invoices, bills, items, payments });
  } catch (err) {
    console.error(err);
    const status = document.querySelector('#dataStatus');
    if (status) status.textContent = `Could not fetch repo JSON (likely opened via file://). Use “Load local JSON”.`;
    if (loading) loading.style.display = 'none';
    toast('Load local JSON to continue');
  }
}

main().catch(err => {
  console.error(err);
});
