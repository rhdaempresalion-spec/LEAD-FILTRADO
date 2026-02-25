import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ══════ ROBUST PATH DETECTION ══════
// Tries multiple locations to find index.html (works on Railway, Docker, local)
function findPublicDir() {
  // First: try public/ subfolder in various locations
  const publicCandidates = [
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '..', 'public'),
    '/app/public',
  ];
  for (const dir of publicCandidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`✅ public dir found (subfolder): ${dir}`);
      return dir;
    }
  }
  // Second: check if index.html is at root level (no public/ folder)
  const rootCandidates = [
    __dirname,
    process.cwd(),
    '/app',
  ];
  for (const dir of rootCandidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log(`✅ index.html found at root: ${dir}`);
      return dir;
    }
  }
  // Log diagnostic info if not found
  console.error('❌ index.html NOT FOUND ANYWHERE!');
  console.error('__dirname:', __dirname);
  console.error('cwd:', process.cwd());
  console.error('Files in __dirname:', fs.existsSync(__dirname) ? fs.readdirSync(__dirname).join(', ') : 'DIR NOT FOUND');
  console.error('Files in cwd:', fs.readdirSync(process.cwd()).join(', '));
  return path.join(__dirname, 'public');
}

const PUBLIC_DIR = findPublicDir();

const PK = 'pk_WNNg2i_r8_iqeG3XrdJFI_q1I8ihd1yLoUa08Ip0LKaqxXxE';
const SK = 'sk_jz1yyIaa0Dw2OWhMH0r16gUgWZ7N2PCpb6aK1crKPIFq02aD';
const API = 'https://api.shieldtecnologia.com/v1';
const CRM = 'https://api.datacrazy.io/v1/crm/api/crm/flows/webhooks/a3161e6d-6f4d-4b16-a1b5-16bcb9641994/560e62f9-9a1c-4e95-8afe-99794f66f1a8';
const AUTH = 'Basic ' + Buffer.from(`${PK}:${SK}`).toString('base64');
const PORT = process.env.PORT || 3005;

const PLATE_TOKEN = 'a7d46b00fed52a3e93f449ff48b2d584';
const CPF_API_KEY = '7de282c1a84728bacfacc8e584af95c7';

let transactions = [];
let logs = [];
const sentIds = new Set();
const plateCache = {};
const cpfCache = {};
const fipeCache = {};

function log(msg) {
  const entry = { msg, time: new Date().toISOString() };
  console.log(msg);
  logs.unshift(entry);
  if (logs.length > 300) logs.length = 300;
}

function validarTelefone(raw) {
  if (!raw) return { valido: false, motivo: 'vazio', formatado: '', whatsapp: '' };
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.substring(2);
  if (d.length === 11 && d[2] === '9') {
    const ddd = d.substring(0, 2);
    const rest = d.substring(2);
    if (/^(\d)\1+$/.test(rest)) return { valido: false, motivo: 'falso', formatado: '', whatsapp: '' };
    return { valido: true, motivo: 'celular', formatado: `(${ddd}) ${rest[0]}${rest.substring(1,5)}-${rest.substring(5)}`, whatsapp: `55${d}` };
  }
  if (d.length === 10) {
    const ddd = d.substring(0, 2);
    const rest = d.substring(2);
    if (/^(\d)\1+$/.test(rest)) return { valido: false, motivo: 'falso', formatado: '', whatsapp: '' };
    return { valido: true, motivo: 'fixo', formatado: `(${ddd}) ${rest.substring(0,4)}-${rest.substring(4)}`, whatsapp: '' };
  }
  return { valido: false, motivo: `${d.length} digitos`, formatado: '', whatsapp: '' };
}

// AbortController-based timeout for node-fetch v3 (timeout option was removed)
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchPage(page, size) {
  const r = await fetchWithTimeout(`${API}/transactions?page=${page}&pageSize=${size}`, {
    headers: { 'Authorization': AUTH, 'Connection': 'keep-alive' },
  }, 30000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function fetchAllTransactions() {
  try {
    log('🔄 Buscando todas as transações...');
    let allTxs = [];
    const firstData = await fetchPage(1, 500);
    allTxs = firstData.data || [];
    const totalPages = firstData.pagination?.totalPages || 1;

    for (let p = 2; p <= totalPages && p <= 20; p++) {
      try {
        const pageData = await fetchPage(p, 500);
        if (pageData.data?.length) allTxs = [...allTxs, ...pageData.data];
      } catch (e) {
        log(`⚠️ Erro página ${p}: ${e.message}`);
      }
    }

    transactions = allTxs;
    log(`✅ ${transactions.length} transações carregadas (${totalPages} páginas)`);
    return { success: true, total: transactions.length };
  } catch (e) {
    log(`❌ Erro: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function consultarPlaca(placa) {
  const placaClean = placa.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (plateCache[placaClean]) {
    log(`📋 Placa ${placaClean} — cache`);
    return plateCache[placaClean];
  }
  try {
    log(`🔍 Consultando placa ${placaClean}...`);
    const r = await fetchWithTimeout(`https://wdapi2.com.br/consulta/${placaClean}/${PLATE_TOKEN}`, {}, 15000);
    const data = await r.json();
    if (data.erro || data.error) {
      log(`❌ Placa ${placaClean}: ${data.message || data.erro || 'erro'}`);
      return { error: data.message || data.erro || 'Placa não encontrada' };
    }
    plateCache[placaClean] = data;
    log(`✅ Placa ${placaClean}: ${data.MARCA || data.marca || '?'} ${data.MODELO || data.modelo || '?'}`);
    return data;
  } catch (e) {
    log(`❌ Erro placa ${placaClean}: ${e.message}`);
    return { error: e.message };
  }
}

async function consultarCPF(cpf) {
  const cpfClean = cpf.replace(/\D/g, '');
  if (cpfClean.length !== 11) return { error: 'CPF deve ter 11 dígitos' };
  if (cpfCache[cpfClean]) {
    log(`📋 CPF ***${cpfClean.substring(9)} — cache`);
    return cpfCache[cpfClean];
  }
  try {
    log(`🔍 Consultando CPF ***${cpfClean.substring(9)}...`);
    const r = await fetchWithTimeout(`https://api.cpf-brasil.org/cpf/${cpfClean}`, {
      headers: { 'X-API-Key': CPF_API_KEY, 'Content-Type': 'application/json' },
    }, 15000);
    const data = await r.json();
    if (data.success === false) {
      log(`❌ CPF: ${data.message || 'erro'}`);
      return { error: data.message || 'CPF não encontrado' };
    }
    cpfCache[cpfClean] = data;
    log(`✅ CPF consultado: ${data.data?.NOME || '?'}`);
    return data;
  } catch (e) {
    log(`❌ Erro CPF: ${e.message}`);
    return { error: e.message };
  }
}

async function consultarFIPE(marca, modelo, ano) {
  const key = `${marca}|${modelo}|${ano}`.toLowerCase();
  if (fipeCache[key]) return fipeCache[key];

  try {
    log(`🔍 Buscando FIPE: ${marca} ${modelo} ${ano}...`);

    const marcasR = await fetchWithTimeout('https://parallelum.com.br/fipe/api/v1/carros/marcas', {}, 10000);
    const marcas = await marcasR.json();

    const marcaClean = marca.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    let marcaFound = marcas.find(m => {
      const mn = m.nome.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const mnCompact = mn.replace(/\s/g, '');
      const mcCompact = marcaClean.replace(/\s/g, '');
      return mnCompact.includes(mcCompact) || mcCompact.includes(mnCompact);
    });
    if (!marcaFound) {
      // Fallback: match any word from the marca against FIPE names
      const marcaParts = marcaClean.split(/\s+/).filter(p => p.length > 2);
      marcaFound = marcas.find(m => {
        const mn = m.nome.toLowerCase();
        return marcaParts.some(p => mn.includes(p));
      });
    }
    if (!marcaFound) return { error: `Marca "${marca}" não encontrada na FIPE` };

    const modelosR = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFound.codigo}/modelos`, {}, 10000);
    const modelosData = await modelosR.json();
    const modelos = modelosData.modelos || [];

    const modeloClean = modelo.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const modeloParts = modeloClean.split(/\s+/).filter(p => p.length > 1);

    let modeloFound = null;
    let bestScore = 0;
    for (const m of modelos) {
      const mn = m.nome.toLowerCase();
      let score = 0;
      for (const part of modeloParts) { if (mn.includes(part)) score++; }
      if (score > bestScore) { bestScore = score; modeloFound = m; }
    }
    if (!modeloFound || bestScore === 0) {
      modeloFound = modelos.find(m => m.nome.toLowerCase().includes(modeloParts[0] || modeloClean));
    }
    if (!modeloFound) return { error: `Modelo "${modelo}" não encontrado para ${marcaFound.nome}` };

    const anosR = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFound.codigo}/modelos/${modeloFound.codigo}/anos`, {}, 10000);
    const anos = await anosR.json();

    const anoStr = String(ano);
    let anoFound = anos.find(a => a.nome.includes(anoStr) || a.codigo.includes(anoStr));
    if (!anoFound && anos.length > 0) {
      const anoNum = parseInt(anoStr);
      let closestDiff = Infinity;
      for (const a of anos) {
        const aNum = parseInt(a.nome);
        if (!isNaN(aNum) && Math.abs(aNum - anoNum) < closestDiff) {
          closestDiff = Math.abs(aNum - anoNum);
          anoFound = a;
        }
      }
    }
    if (!anoFound) return { error: `Ano ${ano} não encontrado` };

    const fipeR = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${marcaFound.codigo}/modelos/${modeloFound.codigo}/anos/${anoFound.codigo}`, {}, 10000);
    const fipeData = await fipeR.json();

    const result = {
      success: true,
      valor: fipeData.Valor || 'N/A',
      marca: fipeData.Marca || marcaFound.nome,
      modelo: fipeData.Modelo || modeloFound.nome,
      ano: fipeData.AnoModelo || ano,
      combustivel: fipeData.Combustivel || '',
      codigoFipe: fipeData.CodigoFipe || '',
      mesReferencia: fipeData.MesReferencia || '',
    };

    // FIX: Check if FIPE returned a real value (not zero/empty)
    if (!result.valor || result.valor === 'N/A' || result.valor === 'R$ 0,00') {
      return { error: 'Valor FIPE não disponível para este veículo/ano' };
    }

    fipeCache[key] = result;
    log(`✅ FIPE: ${result.marca} ${result.modelo} ${result.ano} = ${result.valor}`);
    return result;
  } catch (e) {
    log(`❌ Erro FIPE: ${e.message}`);
    return { error: e.message };
  }
}

// ══════ EXPRESS ══════
const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/debug', (req, res) => {
  const sample = transactions.find(t => t.status === 'paid') || transactions[0];
  if (!sample) return res.json({ error: 'Sem dados ainda' });
  res.json({ keys: Object.keys(sample), customer: sample.customer, full: sample });
});

app.get('/api/stats', (req, res) => {
  const paid = transactions.filter(t => t.status === 'paid');
  const leads = new Map();
  transactions.forEach(t => {
    const key = t.customer?.document?.number || t.customer?.email;
    if (key && !leads.has(key)) leads.set(key, t.customer);
  });
  let telValid = 0, telInvalid = 0, telEmpty = 0, telWa = 0;
  leads.forEach(c => {
    const ph = c?.phone;
    if (!ph) { telEmpty++; return; }
    const v = validarTelefone(ph);
    if (v.valido) { telValid++; if (v.whatsapp) telWa++; } else telInvalid++;
  });
  res.json({
    total: transactions.length, paid: paid.length,
    revenue: paid.reduce((s, t) => s + (t.amount || 0), 0) / 100,
    leads: leads.size, telValid, telInvalid, telEmpty, telWa,
    crmSent: sentIds.size,
  });
});

app.get('/api/leads', (req, res) => {
  const map = {};
  const filter = req.query.phoneFilter || '';
  const search = (req.query.search || '').toLowerCase();

  transactions.forEach(t => {
    const c = t.customer;
    if (!c) return;
    const key = c.document?.number || c.email || c.name;
    if (!key) return;
    if (!map[key]) {
      const tel = validarTelefone(c.phone);
      map[key] = {
        id: key, nome: c.name || '', email: c.email || '',
        telefoneRaw: c.phone || '', telefone: tel.formatado || c.phone || '',
        telValido: tel.valido, telMotivo: tel.motivo, whatsapp: tel.whatsapp || '',
        documento: c.document?.number || '',
        compras: 0, comprasPagas: 0, totalGasto: 0,
        ultimaCompra: t.createdAt, produtos: new Set(),
        paidTxIds: [], sentCRM: false,
      };
    }
    const l = map[key];
    l.compras++;
    if (t.status === 'paid') {
      l.comprasPagas++;
      l.totalGasto += (t.amount || 0) / 100;
      l.paidTxIds.push(t.id);
      if (sentIds.has(t.id)) l.sentCRM = true;
    }
    if (new Date(t.createdAt) > new Date(l.ultimaCompra)) l.ultimaCompra = t.createdAt;
    if (t.items?.[0]?.title) l.produtos.add(t.items[0].title.split(' - ')[0].trim());
  });

  let leads = Object.values(map).map(l => ({
    ...l, produtos: Array.from(l.produtos).join(', '),
    placaData: plateCache[l.documento] || null,
    cpfData: cpfCache[l.documento?.replace(/\D/g, '')] || null,
  }));

  if (filter === 'valid') leads = leads.filter(l => l.telValido);
  else if (filter === 'whatsapp') leads = leads.filter(l => l.whatsapp);
  else if (filter === 'invalid') leads = leads.filter(l => !l.telValido && l.telefoneRaw);
  else if (filter === 'no_phone') leads = leads.filter(l => !l.telefoneRaw);

  if (search) {
    leads = leads.filter(l =>
      l.nome.toLowerCase().includes(search) || l.email.toLowerCase().includes(search) ||
      l.documento.includes(search) || l.telefoneRaw.includes(search)
    );
  }
  leads.sort((a, b) => new Date(b.ultimaCompra) - new Date(a.ultimaCompra));
  res.json(leads);
});

app.get('/api/transactions', (req, res) => {
  let txs = [...transactions];
  const search = (req.query.search || '').toLowerCase();
  const status = req.query.status || '';
  if (status === 'paid') txs = txs.filter(t => t.status === 'paid');
  else if (status === 'pending') txs = txs.filter(t => ['waiting_payment', 'pending'].includes(t.status));
  if (search) txs = txs.filter(t =>
    (t.customer?.name || '').toLowerCase().includes(search) ||
    (t.customer?.email || '').toLowerCase().includes(search) ||
    (t.id || '').toString().includes(search)
  );
  const page = parseInt(req.query.page) || 1;
  const size = 50;
  const start = (page - 1) * size;
  res.json({
    data: txs.slice(start, start + size),
    pagination: { page, totalRecords: txs.length, totalPages: Math.ceil(txs.length / size) },
  });
});

app.post('/api/crm/send/:id', async (req, res) => {
  const tx = transactions.find(t => String(t.id) === req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transação não encontrada' });
  const c = tx.customer || {};
  const tel = validarTelefone(c.phone);
  try {
    log(`📤 CRM ← ${c.name || 'N/A'} | R$ ${((tx.amount||0)/100).toFixed(2)}`);
    const r = await fetchWithTimeout(CRM, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'venda_paga',
        lead: { nome: c.name||'', email: c.email||'', telefone: tel.formatado||c.phone||'', telefone_valido: tel.valido, whatsapp: tel.whatsapp||'', documento: c.document?.number||'' },
        transacao: { id: tx.id, valor: (tx.amount||0)/100, produto: tx.items?.[0]?.title||'', metodo: tx.paymentMethod||'', status: tx.status, data: tx.createdAt },
      }),
    }, 20000);
    const text = await r.text().catch(()=>'');
    if (r.ok) { sentIds.add(tx.id); log(`✅ CRM ✓ ${c.name||'N/A'}`); }
    else log(`❌ CRM erro ${r.status}`);
    res.json({ success: r.ok, status: r.status });
  } catch (e) { log(`❌ CRM: ${e.message}`); res.json({ success: false, error: e.message }); }
});

app.post('/api/crm/bulk-send', async (req, res) => {
  const { txIds } = req.body;
  if (!txIds?.length) return res.status(400).json({ error: 'Nenhuma transação selecionada' });
  let success = 0, errors = 0;
  for (const id of txIds) {
    if (sentIds.has(id)) continue;
    const tx = transactions.find(t => String(t.id) === String(id));
    if (!tx) { errors++; continue; }
    const c = tx.customer || {};
    const tel = validarTelefone(c.phone);
    try {
      const r = await fetchWithTimeout(CRM, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'venda_paga',
          lead: { nome: c.name||'', email: c.email||'', telefone: tel.formatado||c.phone||'', telefone_valido: tel.valido, whatsapp: tel.whatsapp||'', documento: c.document?.number||'' },
          transacao: { id: tx.id, valor: (tx.amount||0)/100, produto: tx.items?.[0]?.title||'', metodo: tx.paymentMethod||'', status: tx.status, data: tx.createdAt },
        }),
      }, 20000);
      if (r.ok) { sentIds.add(tx.id); success++; log(`✅ CRM bulk: ${c.name||'N/A'}`); }
      else { errors++; }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { errors++; }
  }
  log(`📤 Bulk: ${success} enviados, ${errors} erros`);
  res.json({ success: true, sent: success, errors });
});

app.post('/api/placa', async (req, res) => {
  const { placa } = req.body;
  if (!placa) return res.status(400).json({ error: 'Placa não informada' });
  res.json(await consultarPlaca(placa));
});

app.post('/api/cpf', async (req, res) => {
  const { cpf } = req.body;
  if (!cpf) return res.status(400).json({ error: 'CPF não informado' });
  res.json(await consultarCPF(cpf));
});

app.post('/api/cpf/bulk', async (req, res) => {
  const { cpfs } = req.body;
  if (!cpfs?.length) return res.status(400).json({ error: 'Nenhum CPF' });
  const results = [];
  for (const item of cpfs) {
    const data = await consultarCPF(item.cpf);
    results.push({ leadId: item.leadId, cpf: item.cpf, data });
    await new Promise(r => setTimeout(r, 500));
  }
  res.json(results);
});

app.post('/api/fipe', async (req, res) => {
  const { marca, modelo, ano } = req.body;
  if (!marca || !modelo) return res.status(400).json({ error: 'Marca e modelo obrigatórios' });
  res.json(await consultarFIPE(marca, modelo, ano || ''));
});

app.get('/api/fipe/marcas', async (req, res) => {
  try {
    const r = await fetchWithTimeout('https://parallelum.com.br/fipe/api/v1/carros/marcas', {}, 10000);
    res.json(await r.json());
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/fipe/marcas/:id/modelos', async (req, res) => {
  try {
    const r = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${req.params.id}/modelos`, {}, 10000);
    res.json(await r.json());
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/fipe/marcas/:id/modelos/:mid/anos', async (req, res) => {
  try {
    const r = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${req.params.id}/modelos/${req.params.mid}/anos`, {}, 10000);
    res.json(await r.json());
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/fipe/marcas/:id/modelos/:mid/anos/:aid', async (req, res) => {
  try {
    const r = await fetchWithTimeout(`https://parallelum.com.br/fipe/api/v1/carros/marcas/${req.params.id}/modelos/${req.params.mid}/anos/${req.params.aid}`, {}, 10000);
    res.json(await r.json());
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/refresh', async (req, res) => { res.json(await fetchAllTransactions()); });
app.get('/api/status', (req, res) => res.json({ sent: sentIds.size, total: transactions.length }));
app.get('/api/logs', (req, res) => res.json(logs));
app.get('/health', (req, res) => res.json({ ok: true, transactions: transactions.length }));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`⚡ DHR Leads → http://localhost:${PORT}`);
  console.log(`📂 Public dir: ${PUBLIC_DIR}`);
  console.log(`📂 __dirname: ${__dirname}`);
  console.log(`📂 cwd: ${process.cwd()}`);
  console.log(`🚫 Sem envio automático — apenas manual`);
});
