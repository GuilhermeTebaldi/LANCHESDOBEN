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
  updatedAt: new Date().toISOString(),
});

const normalizeConfig = (value) => {
  const fallback = createDefaultConfig();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const printerName = normalizeText(value.printerName, fallback.printerName);
  const updatedAt =
    typeof value.updatedAt === 'string' && value.updatedAt.trim()
      ? value.updatedAt.trim()
      : fallback.updatedAt;
  return {
    printerName,
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
    now: new Date().toISOString(),
  });
});

app.get('/printers', requireToken, async (req, res) => {
  try {
    const printers = await listPrinters();
    res.json({
      ok: true,
      printers: printers.map((printer) => printer.name),
      detailed: printers,
      defaultPrinterName: DEFAULT_PRINTER_NAME,
      selectedPrinterName: agentConfig.printerName,
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

app.use((error, req, res, next) => {
  res.status(500).json({
    ok: false,
    code: 'agent_unhandled_error',
    message: error instanceof Error ? error.message : 'Erro interno no agente local.',
  });
});

const bootstrap = async () => {
  agentConfig = await loadConfig();
  if (!agentConfig.printerName) {
    agentConfig = await saveConfig(createDefaultConfig());
  }
  app.listen(PORT, HOST, () => {
    console.log(
      `[LOCAL_PRINT_AGENT] online em http://${HOST}:${PORT} (default printer: ${DEFAULT_PRINTER_NAME}, selected: ${agentConfig.printerName})`
    );
  });
};

void bootstrap();
