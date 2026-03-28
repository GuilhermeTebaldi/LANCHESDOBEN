const express = require('express');
const cors = require('cors');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const APP_VERSION = '1.0.0';
const HOST = process.env.LOCAL_PRINT_AGENT_HOST || '127.0.0.1';
const PORT = Number(process.env.LOCAL_PRINT_AGENT_PORT || 18181);
const DEFAULT_PRINTER_NAME =
  typeof process.env.LOCAL_PRINT_AGENT_DEFAULT_PRINTER === 'string' &&
  process.env.LOCAL_PRINT_AGENT_DEFAULT_PRINTER.trim()
    ? process.env.LOCAL_PRINT_AGENT_DEFAULT_PRINTER.trim()
    : 'EPSON TM-T20';
const AGENT_TOKEN =
  typeof process.env.LOCAL_PRINT_AGENT_TOKEN === 'string'
    ? process.env.LOCAL_PRINT_AGENT_TOKEN.trim()
    : '';
const CONFIG_DIR = path.join(
  process.env.APPDATA || os.homedir(),
  'XBurgerPrintAgent'
);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STARTUP_SHORTCUT_NAME = 'XBurger Print Agent.lnk';

const LOOPBACK_SET = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const normalizeIp = (ip) => {
  if (typeof ip !== 'string') return '';
  return ip.trim();
};

const isLocalRequest = (req) => {
  const remoteAddress = normalizeIp(req.socket && req.socket.remoteAddress);
  if (LOOPBACK_SET.has(remoteAddress)) return true;
  const host = typeof req.hostname === 'string' ? req.hostname.trim().toLowerCase() : '';
  return host === 'localhost' || host === '127.0.0.1';
};

const powerShellLiteral = (value) => `'${String(value || '').replace(/'/g, "''")}'`;

const runPowerShell = (script, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              stderr && String(stderr).trim()
                ? String(stderr).trim()
                : error.message || 'Falha ao executar PowerShell.'
            )
          );
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    );
  });

const parsePrinterRows = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
};

const listPrinters = async () => {
  const script =
    'Get-Printer | Select-Object Name,Default,PrinterStatus | ConvertTo-Json -Depth 3';
  const { stdout } = await runPowerShell(script, 6000);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = JSON.parse(trimmed);
  const rows = parsePrinterRows(parsed);
  return rows
    .map((row) => ({
      name: typeof row.Name === 'string' ? row.Name.trim() : '',
      isDefault: Boolean(row.Default),
      status:
        typeof row.PrinterStatus === 'number' || typeof row.PrinterStatus === 'string'
          ? row.PrinterStatus
          : null,
    }))
    .filter((row) => row.name.length > 0);
};

const normalizeText = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const createDefaultConfig = () => ({
  printerName: DEFAULT_PRINTER_NAME,
  port: PORT,
  tokenEnabled: Boolean(AGENT_TOKEN),
  autoStartEnabled: false,
  lastDetectedPrinters: [],
  updatedAt: new Date().toISOString(),
});

const normalizeConfig = (value) => {
  const fallback = createDefaultConfig();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const printerName = normalizeText(value.printerName, fallback.printerName);
  const port = Number(value.port);
  const tokenEnabled =
    typeof value.tokenEnabled === 'boolean' ? value.tokenEnabled : fallback.tokenEnabled;
  const autoStartEnabled =
    typeof value.autoStartEnabled === 'boolean'
      ? value.autoStartEnabled
      : fallback.autoStartEnabled;
  const lastDetectedPrinters = Array.isArray(value.lastDetectedPrinters)
    ? value.lastDetectedPrinters
        .map((entry) => normalizeText(entry, ''))
        .filter((entry) => entry.length > 0)
    : fallback.lastDetectedPrinters;
  const updatedAt =
    typeof value.updatedAt === 'string' && value.updatedAt.trim()
      ? value.updatedAt.trim()
      : fallback.updatedAt;
  return {
    printerName,
    port: Number.isFinite(port) && port > 0 ? Math.round(port) : fallback.port,
    tokenEnabled: Boolean(tokenEnabled),
    autoStartEnabled: Boolean(autoStartEnabled),
    lastDetectedPrinters,
    updatedAt,
  };
};

const loadConfig = async () => {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8');
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return createDefaultConfig();
  }
};

const saveConfig = async (config) => {
  const normalized = normalizeConfig(config);
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
};

const getStartupDir = () => {
  const appData = process.env.APPDATA;
  if (typeof appData !== 'string' || !appData.trim()) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
};

const getStartupShortcutPath = () => {
  const startupDir = getStartupDir();
  if (!startupDir) return null;
  return path.join(startupDir, STARTUP_SHORTCUT_NAME);
};

const detectAutoStartEnabled = async () => {
  const startupShortcutPath = getStartupShortcutPath();
  if (!startupShortcutPath) return false;
  try {
    await fs.access(startupShortcutPath);
    return true;
  } catch {
    return false;
  }
};

const resolveAutoStartTarget = () => {
  const execPath = normalizeText(process.execPath, '');
  if (!execPath) {
    return {
      targetPath: '',
      arguments: '',
      workingDirectory: process.cwd(),
    };
  }

  const isNodeBinary = /node(?:\.exe)?$/i.test(path.basename(execPath));
  if (isNodeBinary) {
    const scriptPath = path.resolve(__filename);
    return {
      targetPath: execPath,
      arguments: `"${scriptPath}"`,
      workingDirectory: path.dirname(scriptPath),
    };
  }

  return {
    targetPath: execPath,
    arguments: '',
    workingDirectory: path.dirname(execPath),
  };
};

const setAutoStartEnabled = async (enabled) => {
  const startupShortcutPath = getStartupShortcutPath();
  if (!startupShortcutPath) {
    throw new Error('Pasta de inicialização do Windows não encontrada.');
  }

  if (!enabled) {
    await fs.unlink(startupShortcutPath).catch(() => undefined);
    return false;
  }

  const startupDir = path.dirname(startupShortcutPath);
  await fs.mkdir(startupDir, { recursive: true });

  const target = resolveAutoStartTarget();
  if (!target.targetPath) {
    throw new Error('Executável do agente não encontrado para auto-inicialização.');
  }

  const script = [
    `$linkPath = ${powerShellLiteral(startupShortcutPath)};`,
    `$targetPath = ${powerShellLiteral(target.targetPath)};`,
    `$arguments = ${powerShellLiteral(target.arguments)};`,
    `$workingDirectory = ${powerShellLiteral(target.workingDirectory)};`,
    '$wshShell = New-Object -ComObject WScript.Shell;',
    '$shortcut = $wshShell.CreateShortcut($linkPath);',
    '$shortcut.TargetPath = $targetPath;',
    '$shortcut.Arguments = $arguments;',
    '$shortcut.WorkingDirectory = $workingDirectory;',
    '$shortcut.WindowStyle = 7;',
    "$shortcut.Description = 'XBurger Local Print Agent';",
    '$shortcut.Save();',
  ].join(' ');

  await runPowerShell(script, 10000);
  return true;
};

const persistDetectedPrinters = async (printers) => {
  const names = printers.map((printer) => normalizeText(printer.name, '')).filter(Boolean);
  const nextConfig = await saveConfig({
    ...agentConfig,
    port: PORT,
    tokenEnabled: Boolean(AGENT_TOKEN),
    autoStartEnabled: await detectAutoStartEnabled(),
    lastDetectedPrinters: names,
    updatedAt: new Date().toISOString(),
  });
  agentConfig = nextConfig;
};

let agentConfig = createDefaultConfig();

const normalizeMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
};

const formatMoney = (value) => normalizeMoney(value).toFixed(2);

const validateReceiptPayload = (receipt) => {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, message: 'Payload de cupom ausente.' };
  }

  const lines = Array.isArray(receipt.lines) ? receipt.lines : [];
  if (lines.length === 0) {
    return { ok: false, message: 'Cupom sem itens para impressão.' };
  }

  return { ok: true };
};

const buildReceiptText = (receipt) => {
  const lines = [];
  const now = new Date();
  lines.push(normalizeText(receipt.restaurantName, 'LANCHESDOBEN'));
  lines.push('----------------------------------------');
  lines.push(`Pedido: ${normalizeText(receipt.orderId, '--')}`);
  if (receipt.orderNumber !== null && receipt.orderNumber !== undefined) {
    lines.push(`Numero: ${String(receipt.orderNumber)}`);
  }
  lines.push(`Emissao: ${now.toLocaleString('pt-BR')}`);
  lines.push('----------------------------------------');

  for (const item of Array.isArray(receipt.lines) ? receipt.lines : []) {
    const qty = Math.max(1, Number(item.qty) || 1);
    const name = normalizeText(item.name, 'Item');
    const subtotal = formatMoney(item.subtotal);
    lines.push(`${qty}x ${name}`);
    lines.push(`  R$ ${subtotal}`);
    const note = normalizeText(item.note, '');
    if (note) {
      lines.push(`  obs: ${note}`);
    }
  }

  lines.push('----------------------------------------');
  lines.push(`Total itens: R$ ${formatMoney(receipt.itemsTotal)}`);
  lines.push(`Total pedido: R$ ${formatMoney(receipt.total)}`);
  lines.push(`Pagamento: ${normalizeText(receipt.paymentMethodLabel, '--')}`);
  if (Array.isArray(receipt.paymentSplits) && receipt.paymentSplits.length > 0) {
    lines.push('Dividido:');
    receipt.paymentSplits.forEach((split) => {
      const label = normalizeText(split.label, 'Parcela');
      const method = normalizeText(split.methodLabel, '--');
      lines.push(`- ${label} ${method} R$ ${formatMoney(split.amount)}`);
    });
  }
  if (Array.isArray(receipt.observations) && receipt.observations.length > 0) {
    lines.push('----------------------------------------');
    lines.push('Observacoes:');
    receipt.observations.forEach((entry) => {
      const text = normalizeText(entry, '');
      if (text) {
        lines.push(`- ${text}`);
      }
    });
  }

  lines.push('----------------------------------------');
  lines.push('Obrigado pela preferencia!');
  lines.push('');
  lines.push('');

  return lines.join('\r\n');
};

const sendTextToPrinter = async (printerName, textContent) => {
  const tempFilePath = path.join(
    os.tmpdir(),
    `xburger-local-print-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`
  );

  await fs.writeFile(tempFilePath, textContent, 'utf8');
  const script = [
    `$printer = ${powerShellLiteral(printerName)};`,
    `$file = ${powerShellLiteral(tempFilePath)};`,
    'Get-Content -Path $file | Out-Printer -Name $printer;',
  ].join(' ');

  try {
    await runPowerShell(script, 12000);
  } finally {
    await fs.unlink(tempFilePath).catch(() => undefined);
  }
};

const buildUiHtml = () => `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>XBurger Print Agent</title>
  <style>
    :root { font-family: Segoe UI, Arial, sans-serif; }
    body { margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 20px; }
    .card { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 14px; }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { margin: 4px 0; }
    label { display: block; margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #94a3b8; }
    input, select, button { width: 100%; box-sizing: border-box; border-radius: 10px; border: 1px solid #475569; background: #0b1220; color: #e2e8f0; padding: 10px; font-size: 14px; }
    .row { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
    button { background: #1d4ed8; border-color: #1e40af; font-weight: 700; cursor: pointer; }
    button.secondary { background: #1f2937; border-color: #374151; }
    .ok { color: #22c55e; font-weight: 700; }
    .warn { color: #f59e0b; font-weight: 700; }
    .muted { color: #94a3b8; font-size: 12px; }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; border: 1px solid #334155; background: #0b1220; font-size: 12px; margin-right: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>XBurger Local Print Agent</h1>
      <p class="muted">Configure a impressora térmica uma única vez.</p>
      <p><span id="agentStatus" class="pill">Carregando...</span><span id="printerStatus" class="pill">--</span></p>
      <p class="muted">URL local: <strong>http://127.0.0.1:${PORT}</strong></p>
    </div>
    <div class="card">
      <label>Token (opcional)</label>
      <input id="token" type="password" placeholder="x-local-print-token" />
      <label>Impressora padrão</label>
      <select id="printerSelect"></select>
      <label>Ou digite o nome da impressora</label>
      <input id="printerManual" type="text" placeholder="EPSON TM-T20" />
      <div class="row" style="margin-top:10px">
        <button id="refreshBtn" class="secondary">Listar impressoras</button>
        <button id="savePrinterBtn">Salvar impressora padrão</button>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="testBtn" class="secondary">Imprimir teste</button>
        <button id="autostartBtn" class="secondary">Alternar auto-início</button>
      </div>
      <p id="message" class="muted" style="margin-top:10px">Aguardando ação.</p>
      <p id="autostartState" class="muted"></p>
    </div>
  </div>
  <script>
    const headers = () => {
      const token = localStorage.getItem('xburger_print_agent_token') || '';
      const h = { 'Content-Type': 'application/json' };
      if (token.trim()) h['x-local-print-token'] = token.trim();
      return h;
    };
    const setMessage = (text, ok = false) => {
      const el = document.getElementById('message');
      el.textContent = text;
      el.className = ok ? 'ok' : 'warn';
    };
    const setTokenFromInput = () => {
      const value = document.getElementById('token').value || '';
      localStorage.setItem('xburger_print_agent_token', value);
    };
    const getPrinterNameInput = () => {
      const manualValue = (document.getElementById('printerManual').value || '').trim();
      if (manualValue) return manualValue;
      return (document.getElementById('printerSelect').value || '').trim();
    };
    const setPrinterInputs = (printerName) => {
      const normalized = (printerName || '').trim();
      if (!normalized) return;
      const select = document.getElementById('printerSelect');
      const manual = document.getElementById('printerManual');
      if (manual && !manual.value.trim()) {
        manual.value = normalized;
      }
      if (!select) return;
      const hasOption = Array.from(select.options || []).some((option) => option.value === normalized);
      if (hasOption) {
        select.value = normalized;
      }
    };
    const loadToken = () => {
      const token = localStorage.getItem('xburger_print_agent_token') || '';
      document.getElementById('token').value = token;
    };
    const request = async (path, init = {}) => {
      const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
      let data = {};
      try { data = await response.json(); } catch {}
      if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status));
      return data;
    };
    const refreshHealth = async () => {
      const health = await request('/health');
      document.getElementById('agentStatus').textContent = 'Agente online v' + (health.version || '--');
      document.getElementById('agentStatus').className = 'pill ok';
      const printer = health.selectedPrinterName || '--';
      document.getElementById('printerStatus').textContent = 'Padrão: ' + printer;
      document.getElementById('autostartState').textContent = 'Auto-início: ' + (health.autoStartEnabled ? 'ligado' : 'desligado');
      setPrinterInputs(health.selectedPrinterName || '');
    };
    const refreshPrinters = async () => {
      const result = await request('/printers');
      const select = document.getElementById('printerSelect');
      select.innerHTML = '';
      (result.printers || []).forEach((name) => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });
      if (result.selectedPrinterName) select.value = result.selectedPrinterName;
      if (!select.value && select.options.length > 0) select.value = select.options[0].value;
      setPrinterInputs(result.selectedPrinterName || select.value || '');
      setMessage('Impressoras atualizadas.', true);
    };
    document.getElementById('token').addEventListener('change', setTokenFromInput);
    document.getElementById('printerSelect').addEventListener('change', () => {
      const selectValue = (document.getElementById('printerSelect').value || '').trim();
      if (!selectValue) return;
      const manual = document.getElementById('printerManual');
      if (manual && !manual.value.trim()) {
        manual.value = selectValue;
      }
    });
    document.getElementById('refreshBtn').addEventListener('click', async () => {
      try { setTokenFromInput(); await refreshHealth(); await refreshPrinters(); } catch (error) { setMessage(error.message || 'Falha ao listar impressoras.'); }
    });
    document.getElementById('savePrinterBtn').addEventListener('click', async () => {
      try {
        setTokenFromInput();
        const printerName = getPrinterNameInput();
        if (!printerName) {
          setMessage('Digite ou selecione uma impressora.');
          return;
        }
        await request('/config/printer', { method: 'POST', body: JSON.stringify({ printerName }) });
        await refreshHealth();
        setMessage('Impressora padrão salva.', true);
      } catch (error) { setMessage(error.message || 'Falha ao salvar impressora.'); }
    });
    document.getElementById('testBtn').addEventListener('click', async () => {
      try {
        setTokenFromInput();
        const printerName = getPrinterNameInput();
        if (!printerName) {
          setMessage('Digite ou selecione uma impressora.');
          return;
        }
        await request('/print/test', { method: 'POST', body: JSON.stringify({ printerName }) });
        setMessage('Teste enviado para impressora.', true);
      } catch (error) { setMessage(error.message || 'Falha no teste de impressão.'); }
    });
    document.getElementById('autostartBtn').addEventListener('click', async () => {
      try {
        setTokenFromInput();
        const health = await request('/health');
        await request('/config/autostart', { method: 'POST', body: JSON.stringify({ enabled: !health.autoStartEnabled }) });
        await refreshHealth();
        setMessage('Auto-início atualizado.', true);
      } catch (error) { setMessage(error.message || 'Falha ao alterar auto-início.'); }
    });
    (async () => {
      try {
        loadToken();
        await refreshHealth();
        await refreshPrinters();
      } catch (error) {
        document.getElementById('agentStatus').textContent = 'Agente offline';
        document.getElementById('agentStatus').className = 'pill warn';
        setMessage(error.message || 'Falha ao inicializar painel.');
      }
    })();
  </script>
</body>
</html>`;

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '400kb' }));

app.use((req, res, next) => {
  if (!isLocalRequest(req)) {
    res.status(403).json({
      ok: false,
      code: 'local_only',
      message: 'Este agente aceita somente chamadas locais (127.0.0.1).',
    });
    return;
  }
  next();
});

const requireToken = (req, res, next) => {
  if (!AGENT_TOKEN) {
    next();
    return;
  }
  const byHeader = normalizeText(req.get('x-local-print-token'), '');
  const authHeader = normalizeText(req.get('authorization'), '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (byHeader === AGENT_TOKEN || bearer === AGENT_TOKEN) {
    next();
    return;
  }
  res.status(401).json({
    ok: false,
    code: 'unauthorized',
    message: 'Token do agente inválido.',
  });
};

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    name: 'xburger-local-print-agent',
    version: APP_VERSION,
    host: HOST,
    port: PORT,
    tokenRequired: Boolean(AGENT_TOKEN),
    defaultPrinterName: DEFAULT_PRINTER_NAME,
    selectedPrinterName: agentConfig.printerName,
    autoStartEnabled: agentConfig.autoStartEnabled,
    configUpdatedAt: agentConfig.updatedAt,
    now: new Date().toISOString(),
  });
});

app.get('/printers', requireToken, async (req, res) => {
  try {
    const printers = await listPrinters();
    await persistDetectedPrinters(printers);
    res.json({
      ok: true,
      printers: printers.map((printer) => printer.name),
      detailed: printers,
      defaultPrinterName: DEFAULT_PRINTER_NAME,
      selectedPrinterName: agentConfig.printerName,
      autoStartEnabled: agentConfig.autoStartEnabled,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'printer_list_failed',
      message: error instanceof Error ? error.message : 'Falha ao listar impressoras.',
    });
  }
});

app.post('/print/test', requireToken, async (req, res) => {
  const printerName = normalizeText(
    req.body?.printerName,
    normalizeText(agentConfig.printerName, DEFAULT_PRINTER_NAME)
  );
  try {
    const printers = await listPrinters();
    const printerExists = printers.some(
      (printer) => printer.name.toLowerCase() === printerName.toLowerCase()
    );
    if (!printerExists) {
      res.status(404).json({
        ok: false,
        code: 'printer_not_found',
        message: `Impressora '${printerName}' não encontrada no Windows.`,
      });
      return;
    }

    const testText = [
      '*** TESTE DE IMPRESSAO LOCAL ***',
      `PDV: XBURGER`,
      `Impressora: ${printerName}`,
      `Data: ${new Date().toLocaleString('pt-BR')}`,
      '----------------------------------------',
      'Se este texto saiu no papel, o agente local esta OK.',
      '',
      '',
    ].join('\r\n');

    await sendTextToPrinter(printerName, testText);
    res.json({
      ok: true,
      printed: true,
      code: 'printed',
      message: 'Teste enviado para a impressora local.',
      printerName,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      printed: false,
      code: 'print_test_failed',
      message: error instanceof Error ? error.message : 'Falha ao imprimir teste.',
      printerName,
    });
  }
});

app.post('/print/receipt', requireToken, async (req, res) => {
  const printerName = normalizeText(
    req.body?.printerName,
    normalizeText(agentConfig.printerName, DEFAULT_PRINTER_NAME)
  );
  const receipt = req.body?.receipt;

  const validation = validateReceiptPayload(receipt);
  if (!validation.ok) {
    res.status(400).json({
      ok: false,
      printed: false,
      code: 'invalid_receipt_payload',
      message: validation.message,
    });
    return;
  }

  try {
    const printers = await listPrinters();
    const printerExists = printers.some(
      (printer) => printer.name.toLowerCase() === printerName.toLowerCase()
    );
    if (!printerExists) {
      res.status(404).json({
        ok: false,
        printed: false,
        code: 'printer_not_found',
        message: `Impressora '${printerName}' não encontrada no Windows.`,
      });
      return;
    }

    const text = buildReceiptText(receipt);
    await sendTextToPrinter(printerName, text);

    res.json({
      ok: true,
      printed: true,
      code: 'printed',
      message: 'Cupom enviado para a impressora local.',
      printerName,
      lineCount: Array.isArray(receipt.lines) ? receipt.lines.length : 0,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      printed: false,
      code: 'print_failed',
      message: error instanceof Error ? error.message : 'Falha ao imprimir cupom.',
      printerName,
    });
  }
});

app.get('/config', requireToken, async (req, res) => {
  res.json({
    ok: true,
    config: {
      printerName: agentConfig.printerName,
      port: agentConfig.port,
      tokenEnabled: agentConfig.tokenEnabled,
      autoStartEnabled: agentConfig.autoStartEnabled,
      lastDetectedPrinters: agentConfig.lastDetectedPrinters,
      updatedAt: agentConfig.updatedAt,
    },
  });
});

app.post('/config/printer', requireToken, async (req, res) => {
  const printerName = normalizeText(req.body?.printerName, '');
  if (!printerName) {
    res.status(400).json({
      ok: false,
      code: 'invalid_printer_name',
      message: 'Nome da impressora é obrigatório.',
    });
    return;
  }

  try {
    const printers = await listPrinters();
    const printerExists = printers.some(
      (printer) => printer.name.toLowerCase() === printerName.toLowerCase()
    );
    if (!printerExists) {
      res.status(404).json({
        ok: false,
        code: 'printer_not_found',
        message: `Impressora '${printerName}' não encontrada no Windows.`,
      });
      return;
    }

    agentConfig = await saveConfig({
      ...agentConfig,
      printerName,
      updatedAt: new Date().toISOString(),
    });
    res.json({
      ok: true,
      code: 'printer_saved',
      message: 'Impressora padrão salva no agente local.',
      selectedPrinterName: agentConfig.printerName,
      autoStartEnabled: agentConfig.autoStartEnabled,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'printer_save_failed',
      message:
        error instanceof Error ? error.message : 'Falha ao salvar impressora padrão no agente.',
    });
  }
});

app.post('/config/autostart', requireToken, async (req, res) => {
  const enabled = Boolean(req.body && req.body.enabled);
  try {
    const autoStartEnabled = await setAutoStartEnabled(enabled);
    agentConfig = await saveConfig({
      ...agentConfig,
      autoStartEnabled,
      updatedAt: new Date().toISOString(),
    });
    res.json({
      ok: true,
      code: 'autostart_saved',
      message: `Auto-início ${autoStartEnabled ? 'ativado' : 'desativado'}.`,
      autoStartEnabled,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      code: 'autostart_save_failed',
      message:
        error instanceof Error ? error.message : 'Falha ao configurar auto-início do agente.',
    });
  }
});

app.get('/ui', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(buildUiHtml());
});

app.use((error, req, res, next) => {
  res.status(500).json({
    ok: false,
    code: 'agent_unhandled_error',
    message: error instanceof Error ? error.message : 'Erro interno no agente local.',
  });
});

const bootstrap = async () => {
  const loadedConfig = await loadConfig();
  const autoStartEnabled = await detectAutoStartEnabled();
  agentConfig = await saveConfig({
    ...loadedConfig,
    printerName: normalizeText(loadedConfig.printerName, DEFAULT_PRINTER_NAME),
    port: PORT,
    tokenEnabled: Boolean(AGENT_TOKEN),
    autoStartEnabled,
    lastDetectedPrinters: Array.isArray(loadedConfig.lastDetectedPrinters)
      ? loadedConfig.lastDetectedPrinters
      : [],
    updatedAt: loadedConfig.updatedAt || new Date().toISOString(),
  });
  app.listen(PORT, HOST, () => {
    console.log(
      `[LOCAL_PRINT_AGENT] online em http://${HOST}:${PORT} (default printer: ${DEFAULT_PRINTER_NAME}, selected: ${agentConfig.printerName})`
    );
  });
};

void bootstrap();
