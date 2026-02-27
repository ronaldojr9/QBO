const fmtMoney = (n) => {
  if (!isFinite(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
};
const fmtPct = (n) => {
  if (!isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
};

function parseDate(s) {
  // Input is like MM/DD/YYYY in the sample
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

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

function groupSum(rows, keyFn, valFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = valFn(r);
    if (k == null || !isFinite(v)) continue;
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

function sum(n) {
  return n.reduce((a, b) => a + b, 0);
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function deriveReportDate({ invoices, bills, payments }) {
  // Use latest date seen in any dataset as a stable “as of” date.
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
  // Group lines into an “invoice” using (Customer, Invoice Date, Due Date, Terms)
  const map = new Map();
  for (const line of invoices) {
    const customer = line['Customer'] || 'Unknown';
    const invDate = parseDate(line['Invoice Date']);
    const dueDate = parseDate(line['Due Date']);
    const terms = line['Terms'] || '';
    if (!invDate) continue;

    const key = `${customer}||${invDate.toISOString()}||${(dueDate ? dueDate.toISOString() : '')}||${terms}`;
    const row = map.get(key) || {
      customer,
      invDate,
      dueDate,
      terms,
      revenue: 0,
      estCogs: 0,
      lines: 0
    };

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
  // Group bills by (Vendor, Bill Date, Due Date, Terms)
  const map = new Map();
  for (const line of bills) {
    const vendor = line['Vendor'] || 'Unknown';
    const billDate = parseDate(line['Bill Date']);
    const dueDate = parseDate(line['Due Date']);
    const terms = line['Terms'] || '';
    if (!billDate) continue;
    const key = `${vendor}||${billDate.toISOString()}||${(dueDate ? dueDate.toISOString() : '')}||${terms}`;
    const row = map.get(key) || {
      vendor,
      billDate,
      dueDate,
      terms,
      amount: 0,
      lines: 0,
      categories: new Map()
    };
    const amt = safeNum(line['Line Total']);
    row.amount += amt;
    row.lines += 1;
    const cat = line['Category/Item'] || 'Uncategorized';
    row.categories.set(cat, (row.categories.get(cat) || 0) + amt);
    map.set(key, row);
  }
  return Array.from(map.values()).map(r => ({ ...r, categories: Object.fromEntries(r.categories) }));
}

function within(d, from, to) {
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function renderNotes({ kpis, flags, context }) {
  const el = document.querySelector('#notes');
  const parts = [];

  const gm = kpis.gmPct;
  if (isFinite(gm) && gm < 0.35) {
    parts.push(`<div class="warn"><strong>Gross margin proxy is below 35%.</strong> In a discrete manufacturer, this often traces to (1) pricing discipline, (2) purchase price variance, (3) labor efficiency, or (4) overhead absorption noise. Treat this as a trigger to investigate, not a final answer.</div>`);
  } else {
    parts.push(`<div class="ok"><strong>Gross margin proxy is stable.</strong> Next step is to separate real economics (price/mix, scrap, PPV) from accounting artifacts (inventory accuracy, absorption).</div>`);
  }

  if (flags.ar90p > 0) {
    parts.push(`<div class="warn"><strong>AR aging:</strong> ${fmtMoney(flags.ar90p)} is 90+ days past due (based on due date). For cash, attack disputes, tighten ship/invoice timing, and enforce terms on repeat offenders.</div>`);
  }

  if (flags.ap90p > 0) {
    parts.push(`<div class="warn"><strong>AP aging:</strong> ${fmtMoney(flags.ap90p)} is 90+ days past due. This can mask cash problems and create supply risk (credit holds, price increases, shortened terms).</div>`);
  }

  parts.push(`<p style="color:var(--muted);margin-top:8px">As-of date used for aging: <span class="badge">${context.asOf.toISOString().slice(0,10)}</span>. This demo infers invoices/bills from line-level exports and uses item purchase costs as a COGS proxy. In a real build, we’d reconcile to GL and incorporate standard vs actual + absorption.</p>`);

  el.innerHTML = parts.join('\n');
}

function plotMonthlyTrend({ invoiceFacts, from, to, customer }) {
  const rows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const revByMonth = groupSum(rows, r => monthKey(r.invDate), r => r.revenue);
  const cogsByMonth = groupSum(rows, r => monthKey(r.invDate), r => r.estCogs);

  const months = Array.from(new Set([...revByMonth.keys(), ...cogsByMonth.keys()])).sort();
  const rev = months.map(m => revByMonth.get(m) || 0);
  const cogs = months.map(m => cogsByMonth.get(m) || 0);

  const data = [
    { x: months, y: rev, type: 'scatter', mode: 'lines+markers', name: 'Revenue', line: { color: '#22d3ee', width: 3 } },
    { x: months, y: cogs, type: 'scatter', mode: 'lines+markers', name: 'COGS (proxy)', line: { color: '#f472b6', width: 2, dash: 'dot' } }
  ];

  const layout = {
    margin: { l: 50, r: 15, t: 10, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    legend: { orientation: 'h', y: -0.2 }
  };

  Plotly.newPlot('revCogs', data, layout, { displayModeBar: false, responsive: true });
}

function plotAging({ elId, facts, asOf, amountField, dueField, label }) {
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

  Plotly.newPlot(elId, [{
    x, y,
    type: 'bar',
    marker: { color: ['#334155','#22d3ee','#8b5cf6','#f59e0b','#ef4444'] }
  }], {
    margin: { l: 50, r: 10, t: 10, b: 40 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    yaxis: { gridcolor: 'rgba(148,163,184,.12)', tickprefix: '$' },
    xaxis: { gridcolor: 'rgba(148,163,184,.12)' }
  }, { displayModeBar: false, responsive: true });

  return {
    ar90p: buckets.get('90+') || 0,
    ap90p: buckets.get('90+') || 0
  };
}

function plotTopCustomers({ invoiceFacts, from, to, customer }) {
  const rows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const revByCust = groupSum(rows, r => r.customer, r => r.revenue);
  const cogsByCust = groupSum(rows, r => r.customer, r => r.estCogs);

  const pairs = Array.from(revByCust.entries()).map(([cust, rev]) => {
    const cogs = cogsByCust.get(cust) || 0;
    const gm = rev - cogs;
    return { cust, rev, cogs, gm, gmPct: rev ? gm / rev : NaN };
  }).sort((a,b) => b.rev - a.rev).slice(0, 12);

  Plotly.newPlot('topCustomers', [{
    x: pairs.map(p => p.cust),
    y: pairs.map(p => p.rev),
    type: 'bar',
    marker: { color: '#22d3ee' }
  }], {
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
  // Pull inventory-like opening balances from COA
  const inv = coa
    .filter(a => String(a['Detail Type'] || '').toLowerCase().includes('inventory') || String(a['Account Name']||'').toLowerCase().includes('inventory'))
    .map(a => ({ name: a['Account Name'], amt: safeNum(a['Opening Balance']) }))
    .filter(a => a.amt > 0);

  Plotly.newPlot('inv', [{
    labels: inv.map(i => i.name),
    values: inv.map(i => i.amt),
    type: 'pie',
    hole: 0.45,
    marker: { colors: ['#22d3ee','#8b5cf6','#f59e0b','#f472b6','#94a3b8'] }
  }], {
    margin: { l: 10, r: 10, t: 10, b: 10 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' },
    legend: { orientation: 'h' }
  }, { displayModeBar: false, responsive: true });

  return sum(inv.map(i => i.amt));
}

function plotCCC({ invoiceFacts, billFacts, asOf, from, to, customer, view }) {
  // This is a *lens*, not a full CCC calculation (needs beginning/ending balances).
  // We show:
  // - Invoiced vs cash received (payments)
  // - Bills vs cash paid
  // - Net cash-ish movement in period

  const invRows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
  const billed = billFacts.filter(r => within(r.billDate, from, to));

  const invTotal = sum(invRows.map(r => r.revenue));
  const billTotal = sum(billed.map(r => r.amount));

  const data = [{
    type: 'indicator',
    mode: 'number+delta',
    value: invTotal - billTotal,
    delta: { reference: 0, increasing: { color: '#22c55e' }, decreasing: { color: '#ef4444' } },
    number: { prefix: '$', valueformat: ',.0f' },
    title: { text: `Net in-period inflow (invoice - bills) <br><span style="font-size:11px;color:#94a3b8">(${view} view; proxy)</span>` },
    domain: { x: [0, 1], y: [0, 1] }
  }];

  Plotly.newPlot('ccc', data, {
    margin: { l: 20, r: 20, t: 20, b: 20 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e5e7eb' }
  }, { displayModeBar: false, responsive: true });
}

async function main() {
  const [coa, invoices, bills, items, payments] = await Promise.all([
    loadJSON('./data/chart_of_accounts.json'),
    loadJSON('./data/customer_invoices.json'),
    loadJSON('./data/vendor_bills.json'),
    loadJSON('./data/items.json'),
    loadJSON('./data/customer_payments.json')
  ]);

  const itemsByName = new Map(items.map(i => [i['Item Name'], i]));
  const invoiceFacts = buildInvoiceFacts({ invoices, itemsByName });
  const billFacts = buildBillFacts({ bills });
  const asOf = deriveReportDate({ invoices, bills, payments });

  // Populate customer filter
  const customers = Array.from(new Set(invoiceFacts.map(r => r.customer))).sort();
  const customerSel = document.querySelector('#customer');
  for (const c of customers) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    customerSel.appendChild(opt);
  }

  // Default date range: last 12 months of invoice facts
  const dates = invoiceFacts.map(r => r.invDate).filter(Boolean).sort((a,b)=>a-b);
  const minD = dates[0];
  const maxD = dates[dates.length-1];

  const toInput = document.querySelector('#to');
  const fromInput = document.querySelector('#from');
  const defaultTo = maxD || asOf;
  const defaultFrom = new Date(defaultTo.getTime() - 365*24*3600*1000);

  const iso = d => d.toISOString().slice(0,10);
  fromInput.value = iso(defaultFrom);
  toInput.value = iso(defaultTo);

  function refresh() {
    const from = fromInput.value ? new Date(fromInput.value + 'T00:00:00Z') : null;
    const to = toInput.value ? new Date(toInput.value + 'T23:59:59Z') : null;
    const customer = customerSel.value || '';
    const view = document.querySelector('#view').value;

    const invRows = invoiceFacts.filter(r => within(r.invDate, from, to) && (!customer || r.customer === customer));
    const revenue = sum(invRows.map(r => r.revenue));
    const cogs = sum(invRows.map(r => r.estCogs));
    const gmPct = revenue ? (revenue - cogs) / revenue : NaN;

    document.querySelector('#kpiRevenue').textContent = fmtMoney(revenue);
    document.querySelector('#kpiRevenueHint').textContent = `${invRows.length.toLocaleString()} invoices (grouped)`;
    document.querySelector('#kpiCogs').textContent = fmtMoney(cogs);
    document.querySelector('#kpiGm').textContent = fmtPct(gmPct);
    document.querySelector('#kpiGmHint').textContent = `GM $: ${fmtMoney(revenue - cogs)}`;

    plotMonthlyTrend({ invoiceFacts, from, to, customer });

    // Aging uses all open-ish facts (for demo we age everything)
    const arFlags = plotAging({ elId: 'arAging', facts: invRows, asOf, amountField: 'revenue', dueField: 'dueDate', label: 'AR' });
    const apRows = billFacts.filter(r => within(r.billDate, from, to));
    const apFlags = plotAging({ elId: 'apAging', facts: apRows, asOf, amountField: 'amount', dueField: 'dueDate', label: 'AP' });

    plotTopCustomers({ invoiceFacts, from, to, customer });
    const invTotal = plotInventory({ coa });
    plotCCC({ invoiceFacts, billFacts, asOf, from, to, customer, view });

    // Flags summary
    const flags = {
      ar90p: arFlags.ar90p,
      ap90p: apFlags.ap90p,
      invTotal
    };
    const flagCount = [flags.ar90p > 0, flags.ap90p > 0, flags.invTotal > 0].filter(Boolean).length;
    document.querySelector('#kpiFlags').textContent = String(flagCount);

    renderNotes({ kpis: { revenue, cogs, gmPct }, flags, context: { asOf } });
  }

  document.querySelector('#refresh').addEventListener('click', refresh);
  refresh();
}

main().catch(err => {
  console.error(err);
  document.querySelector('#notes').innerHTML = `<div class="warn"><strong>Failed to load dashboard data.</strong> ${String(err.message || err)}</div>`;
});
