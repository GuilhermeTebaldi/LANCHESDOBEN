# XBURGER Local Print Agent (Windows)

Agente local de impressão térmica para o PDV web.

## Função

- Escuta **somente em `127.0.0.1`** (padrão `http://127.0.0.1:18181`).
- Recebe cupom em JSON do sistema web.
- Envia o texto para a impressora configurada no Windows (ex.: `EPSON TM-T20`).
- Oferece endpoints:
  - `GET /health`
  - `GET /printers`
  - `POST /print/test`
  - `POST /print/receipt`

## Entrega para cliente final (sem terminal)

Fluxo recomendado para operador comum:

1. Entregar o instalador `XBurgerPrintAgent-Setup.exe` (gerado por você).
2. Cliente instala com **Avançar > Avançar > Concluir**.
3. O agente inicia automaticamente com o Windows.
4. Cliente abre o painel local em `http://127.0.0.1:18181/ui`.
5. Seleciona `EPSON TM-T20` uma vez, salva e testa.
6. No PDV, selecionar modo `Agente local Windows` e salvar.

## Build para entrega (equipe técnica)

```bash
cd local-print-agent
npm install
npm run build:exe
npm run build:installer
```

Saídas:

- `dist/xburger-print-agent.exe`
- `installer/dist/XBurgerPrintAgent-Setup.exe`

## Variáveis de ambiente opcionais

- `LOCAL_PRINT_AGENT_HOST` (default: `127.0.0.1`)
- `LOCAL_PRINT_AGENT_PORT` (default: `18181`)
- `LOCAL_PRINT_AGENT_DEFAULT_PRINTER` (default: `EPSON TM-T20`)
- `LOCAL_PRINT_AGENT_TOKEN` (token opcional para autenticação)

## Gerar EXE Windows

```bash
cd local-print-agent
npm install
npm run build:exe
```

Saída esperada:

- `local-print-agent/dist/xburger-print-agent.exe`

## Configuração local da impressora no agente

O agente salva a impressora padrão localmente (arquivo em `%APPDATA%\\XBurgerPrintAgent\\config.json`).

Endpoints úteis:

- `GET /health` (mostra `selectedPrinterName`)
- `GET /printers` (lista impressoras e a selecionada)
- `POST /config/printer` (define a padrão)
- `POST /config/autostart` (liga/desliga auto-início)
- `GET /ui` (painel local amigável para usuário)

Exemplo:

```bash
curl -s -X POST http://127.0.0.1:18181/config/printer \
  -H "Content-Type: application/json" \
  -d '{"printerName":"EPSON TM-T20"}'
```

## Teste rápido com curl

```bash
curl -s http://127.0.0.1:18181/health
curl -s http://127.0.0.1:18181/printers
curl -s -X POST http://127.0.0.1:18181/print/test \
  -H "Content-Type: application/json" \
  -d '{"printerName":"EPSON TM-T20"}'
```

Se `LOCAL_PRINT_AGENT_TOKEN` estiver ativo, enviar também:

```bash
-H "x-local-print-token: SEU_TOKEN"
```
