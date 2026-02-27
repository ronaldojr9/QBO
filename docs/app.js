// World-class UX, CFO-grade logic (demo). Uses repo JSON files under docs/data.

const fmtMoney = (n) => Number.isFinite(n)
  ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  : '—';
const fmtPct = (n) => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';

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

function buildInvoiceFacts({ invoices, itemsByName }) {
  // Group invoice lines into an invoice-ish header.
  const map = new Map();
  for (const line of invoices) {
    const customer = line['Customer'] || 'Unknown';
    const invDate = parseDate(line['Invoice Date']);
    const dueDate = parseDate(line['Due Date']);
    const terms = line['Terms'] || '';
    if (!invDate) continue;

    const key = `${customer}||${invDate.toISOString()}||${(dueDate ? dueDate.toISOString() : '')}||${terms}`;
    const row = map.get(key) || { customer, invDate, dueDate, terms, revenue: 0, estCogs: 0, lines: 0 };

    const qty = safeNum(line['Qty']);
    const lineTotal = safeNum(line['Line Total']);
    const itemName = line['Item'];
    const item = itemsByName.get(itemName);

    row.revenue += lineTotal;
    row.lines += 1;
    if (item) {
      const unitCost = safeNum(item['Purchase Cost']);
      row.estCogs += unitCost * qty;
    }

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

  Plotly.newPlot('revCogs', [
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
  Plotly.newPlot('ccc', [{
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

function plotAging({ elId, facts, asOf, amountField, dueField }) {
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

  Plotly.newPlot(elId, [{ x, y, type: 'bar', marker: { color: ['#334155','#22d3ee','#8b5cf6','#f59e0b','#ef4444'] } }], {
    margin: { l: 50, r: 10, t: 10, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)' }
  }, { displayModeBar: false, responsive: true });

  return { ninetyPlus: buckets.get('90+') || 0 };
}

function plotTopCustomers({ invoiceFacts, from, to, customer }) {
  const rows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const revByCust = groupSum(rows, r => r.customer, r => r.revenue);
  const cogsByCust = groupSum(rows, r => r.customer, r => r.estCogs);

  const pairs = Array.from(revByCust.entries()).map(([cust, rev]) => {
    const cogs = cogsByCust.get(cust) || 0;
    const gm = rev - cogs;
    return { cust, rev, gm, gmPct: rev ? gm / rev : NaN };
  }).sort((a,b) => b.rev - a.rev).slice(0, 12);

  Plotly.newPlot('topCustomers', [{ x: pairs.map(p => p.cust), y: pairs.map(p => p.rev), type: 'bar', marker: { color: '#22d3ee' } }], {
    margin: { l: 50, r: 10, t: 10, b: 120 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)', tickangle: 35 }
  }, { displayModeBar: false, responsive: true });

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

  Plotly.newPlot('inv', [{
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

function renderNotes({ revenue, gmPct, ar90p, ap90p, asOf }) {
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

  parts.push(`<div style="color:#94a3b8;font-size:12px;margin-top:8px">Aging as-of: <span class="pill">${asOf.toISOString().slice(0,10)}</span>. Revenue basis: invoices. COGS basis: item purchase cost proxy.</div>`);

  el.innerHTML = parts.join('\n');
}

function renderAnoms({ invoiceFacts, billFacts }) {
  const el = document.querySelector('#anoms');

  const issues = [];
  const missingCogs = invoiceFacts.filter(r => r.revenue > 0 && r.estCogs === 0).length;
  if (missingCogs > 0) {
    issues.push({
      title: 'COGS proxy missing on invoices',
      body: `${missingCogs} invoice(s) have revenue but no item purchase-cost match. Likely item master mismatch or non-inventory/service lines. Fix: normalize item names/SKUs, map BOM components, or reconcile to GL COGS.`
    });
  }

  const noDue = invoiceFacts.filter(r => !r.dueDate).length;
  if (noDue > 0) {
    issues.push({
      title: 'Invoices missing due dates',
      body: `${noDue} invoice(s) missing due date. That breaks AR aging and cash forecasting. Fix: enforce terms and due dates in QBO.`
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

async function main() {
  wireNav();

  // Load repo JSON (GitHub Pages friendly)
  const [coa, invoices, bills, items, payments] = await Promise.all([
    loadJSON('./data/chart_of_accounts.json'),
    loadJSON('./data/customer_invoices.json'),
    loadJSON('./data/vendor_bills.json'),
    loadJSON('./data/items.json'),
    loadJSON('./data/customer_payments.json').catch(() => [])
  ]);

  document.querySelector('#dataStatus').textContent = `Loaded: COA (${coa.length}), invoices (${invoices.length}), bills (${bills.length}), items (${items.length})`;

  const itemsByName = new Map(items.map(i => [i['Item Name'], i]));
  const invoiceFactsAll = buildInvoiceFacts({ invoices, itemsByName });
  const billFactsAll = buildBillFacts({ bills });
  const asOf = deriveReportDate({ invoices, bills, payments });

  // Defaults: last 12 months
  const invDates = invoiceFactsAll.map(r => r.invDate).filter(Boolean).sort((a,b)=>a-b);
  const maxD = invDates[invDates.length - 1] || asOf;
  const fromD = new Date(maxD.getTime() - 365*24*3600*1000);
  const iso = d => d.toISOString().slice(0,10);
  document.querySelector('#from').value = iso(fromD);
  document.querySelector('#to').value = iso(maxD);

  // Customer list
  const customerSel = document.querySelector('#customer');
  for (const c of Array.from(new Set(invoiceFactsAll.map(r => r.customer))).sort()) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    customerSel.appendChild(opt);
  }

  function refresh() {
    const from = document.querySelector('#from').value ? new Date(document.querySelector('#from').value + 'T00:00:00Z') : null;
    const to = document.querySelector('#to').value ? new Date(document.querySelector('#to').value + 'T23:59:59Z') : null;
    const customer = customerSel.value || '';

    const invoiceFacts = invoiceFactsAll.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
    const billFacts = billFactsAll.filter(r => within(r.billDate, from, to));

    const revenue = sum(invoiceFacts.map(r => r.revenue));
    const cogs = sum(invoiceFacts.map(r => r.estCogs));
    const gm = revenue - cogs;
    const gmPct = revenue ? gm / revenue : NaN;

    document.querySelector('#kpiRevenue').textContent = fmtMoney(revenue);
    document.querySelector('#kpiRevenueHint').textContent = `${invoiceFacts.length.toLocaleString()} invoices (grouped)`;
    document.querySelector('#kpiCogs').textContent = fmtMoney(cogs);
    document.querySelector('#kpiGm').textContent = fmtPct(gmPct);
    document.querySelector('#kpiGmHint').textContent = `GM $: ${fmtMoney(gm)}`;

    // Pills
    const pillRev = document.querySelector('#pillRev');
    setPill(pillRev, revenue > 0 ? 'Active' : 'No data', revenue > 0 ? 'good' : 'warn');

    const pillCogs = document.querySelector('#pillCogs');
    setPill(pillCogs, cogs > 0 ? 'Mapped' : 'Missing', cogs > 0 ? 'good' : 'warn');

    const pillGm = document.querySelector('#pillGm');
    const gmCls = !Number.isFinite(gmPct) ? 'warn' : (gmPct < 0.30 ? 'bad' : (gmPct < 0.40 ? 'warn' : 'good'));
    setPill(pillGm, Number.isFinite(gmPct) ? 'Signal' : '—', gmCls);

    // Plots
    plotMonthlyTrend({ invoiceFacts, from, to, customer });
    const ar = plotAging({ elId: 'arAging', facts: invoiceFacts, asOf, amountField: 'revenue', dueField: 'dueDate' });
    const ap = plotAging({ elId: 'apAging', facts: billFacts, asOf, amountField: 'amount', dueField: 'dueDate' });

    plotTopCustomers({ invoiceFacts, from, to, customer });
    const invTotal = plotInventory({ coa });

    plotIndicator({ invTotal, ar90p: ar.ninetyPlus, ap90p: ap.ninetyPlus });

    const flagsCount = (ar.ninetyPlus > 0 ? 1 : 0) + (ap.ninetyPlus > 0 ? 1 : 0) + (invTotal > 0 ? 1 : 0);
    document.querySelector('#kpiFlags').textContent = String(flagsCount);
    setPill(document.querySelector('#pillFlags'), flagsCount ? 'Review' : 'OK', flagsCount ? 'warn' : 'good');

    renderNotes({ revenue, gmPct, ar90p: ar.ninetyPlus, ap90p: ap.ninetyPlus, asOf });
    renderAnoms({ invoiceFacts, billFacts });
  }

  document.querySelector('#refresh').addEventListener('click', refresh);
  refresh();
}

main().catch(err => {
  console.error(err);
  const status = document.querySelector('#dataStatus');
  if (status) status.textContent = `Failed to load repo JSON: ${String(err.message || err)}`;
});
