# Instalador Windows (Inno Setup)

Arquivo principal: `XBurgerPrintAgent.iss`

## Pré-requisitos (equipe técnica)

- Inno Setup 6 instalado (`ISCC.exe`)
- Executável do agente já gerado em `../dist/xburger-print-agent.exe`

## Gerar instalador

```bash
cd local-print-agent
npm install
npm run build:exe
npm run build:installer
```

Saída:

- `local-print-agent/installer/dist/XBurgerPrintAgent-Setup.exe`

## O que o instalador faz

- Copia `xburger-print-agent.exe` para `Program Files`.
- Cria atalhos no menu iniciar.
- Opcionalmente cria atalho de auto-início no startup do usuário.
- Inicia o agente ao final da instalação.
- Abre o painel local (`http://127.0.0.1:18181/ui`) ao concluir.
