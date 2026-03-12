# Guia de Portabilidade: Impressao (Replica Local -> SaaS)

## Resumo do que foi implementado neste sistema

Foi implementado um pacote completo de ajustes de impressao, sem remover funcionalidades existentes:

1. Correcao de corte lateral na impressao.
2. Correcao do Historico de Fechamentos para trazer valores de pagamento corretamente (PIX, Debito, Credito, Dinheiro, Dividido, canais de app).
3. Engrenagem com modelos de impressao no Historico de Fechamentos.
4. Engrenagem com modelos de impressao na Aba Caixa (Relatorio do Dia), mantendo o modo `Padrao` sem alterar o comportamento anterior.
5. Engrenagem com modelos de impressao no Historico de Vendas (segunda via de cupom), com `Padrao` intacto.
6. Salvamento permanente das escolhas de modelo no navegador (localStorage).

## Correcoes tecnicas feitas

### 1) Historico de Fechamentos sem perder valores de pagamento

Antes, alguns fechamentos podiam cair em "Sem valores por forma de pagamento" mesmo com vendas no periodo.

Causa principal:
- Associacao de vendas ao fechamento por `dia` (data local), que falha em cenarios de virada de dia.

Correcao aplicada:
- Associacao de vendas por janela temporal entre fechamentos (ordenado por `closedAt`), com fallback por dia quando necessario.
- Evita duplicidade no historico inferido usando controle de IDs de venda ja consumidos.

Impacto:
- O fechamento impresso passa a usar o conjunto correto de vendas do periodo.

### 2) Corte de texto nas laterais

Causas tratadas:
- Colunas calculadas sem considerar bem a area util interna.
- Linhas longas enviadas inteiras para `pre`.

Correcao aplicada:
- Calculo de colunas baseado na largura interna (descontando padding horizontal).
- Margem de seguranca no calculo de colunas para reduzir risco de clipping fisico.
- Quebra de mensagens longas com `wrap()` antes de imprimir.

Impacto:
- Reducao de cortes de letras nas bordas e de frases truncadas no papel.

## Modelos de impressao adicionados

Os mesmos modelos foram expostos em pontos diferentes da interface:

- `48 x 297 mm`
- `58 x 297 mm`
- `72 x 297 mm`
- `80 x 297 mm`
- `A4 210 x 297 mm`

No cupom/segunda via existe tambem:
- `Padrao` (nao altera o comportamento antigo)

## Onde cada engrenagem aparece

### A) Historico de Fechamentos (SalesSummary)
- Local: painel lateral "Historico de Fechamentos".
- Exibe modelo atual e permite troca por preset.
- Persistencia local por chave:
  - `qb_history_print_preset_v1`

### B) Aba Caixa - Relatorio do Dia (SalesSummary)
- Local: card escuro "Previa do dia".
- Engrenagem com modelos de impressao para o relatorio.
- `Padrao` preserva o layout anterior (larguras e colunas antigas).
- Persistencia local por chave:
  - `qb_cash_print_preset_v1`

### C) Historico de Vendas (App - modal de segunda via)
- Local: cabecalho do modal "Historico de Vendas".
- Engrenagem ao lado do botao de fechar.
- Modelos aplicados ao cupom via largura de bobina salva em localStorage.
- `Padrao` remove override e volta ao comportamento original.
- Persistencia local por chave:
  - `qb_receipt_print_preset_v1`
- Chave de largura usada pelo cupom:
  - `qb_receipt_paper_width_mm`

## Ajuste de limite de largura para suportar A4

Arquivo utilitario:
- `utils/receiptPaper.ts`

Mudanca:
- `MAX_RECEIPT_PAPER_WIDTH_MM` passou de `80` para `210`.

Motivo:
- Permitir preset `A4 210 x 297 mm` no fluxo de cupom/segunda via.

## Garantia de nao regressao executada aqui

Foi executado apos as alteracoes:

1. `npm run build:sistema` (frontend): OK
2. `npm --prefix backend test` (backend): OK (60/60)

## Commits relevantes (ordem cronologica)

- `3d46545` - fix(history-print): vincular vendas por janela de fechamento e quebrar linhas longas
- `5ab151e` - feat(history-print): adicionar engrenagem com presets de tamanho de papel
- `6ac521c` - feat(print-settings): presets permanentes no historico e cupom da aba caixa
- `d817220` - feat(receipt-history): engrenagem de modelos no historico de vendas

---

## Como portar para o SaaS com padrao por usuario

No SaaS, a persistencia nao deve ficar so em localStorage. Cada usuario precisa ter sua propria configuracao salva no backend.

### Objetivo

Cada usuario autenticado deve ter:

- preset de impressao do Historico de Fechamentos
- preset de impressao da Aba Caixa
- preset de impressao do Historico de Vendas (segunda via)

### Modelo de dados recomendado

Criar tabela (exemplo): `user_print_preferences`

Campos sugeridos:

- `user_id` (FK unico)
- `history_closing_preset` (string)
- `cash_report_preset` (string)
- `receipt_history_preset` (string)
- `updated_at` (timestamp)

Opcional:
- `overrides_json` para extensoes futuras (ex: fonte, margem, densidade)

### API recomendada

1. `GET /api/print-preferences`
- retorna preferencias do usuario logado

2. `PUT /api/print-preferences`
- atualiza parcial/total
- valida presets permitidos em whitelist

Payload exemplo:

```json
{
  "historyClosingPreset": "80x297",
  "cashReportPreset": "PADRAO",
  "receiptHistoryPreset": "58x297"
}
```

### Regra de precedencia no frontend SaaS

1. Preferencia vinda da API do usuario
2. Fallback para localStorage (migracao suave)
3. Fallback para default do sistema (`Padrao` ou `80x297`, conforme contexto)

### Estrategia de migracao segura

1. Deploy backend com tabela + endpoints (sem quebrar clientes antigos)
2. Frontend passa a ler API primeiro
3. Se usuario tiver apenas valor local antigo, enviar `PUT` 1 vez para migrar e marcar migrou
4. Depois da migracao, manter sincronizado (salvou no UI -> salva no backend)

### Regras importantes no SaaS

- Validar preset no backend para impedir valores invalidos.
- Nunca confiar apenas no valor vindo do cliente.
- Garantir isolamento por `user_id`.
- Em ambiente multi-tenant, incluir escopo de tenant quando necessario.

## Checklist rapido para replicar no SaaS

1. Portar constantes de presets e IDs.
2. Portar os 3 pontos de UI com engrenagem.
3. Portar o comportamento de `Padrao` sem alteracao de medidas legadas.
4. Portar a associacao por janela temporal no Historico de Fechamentos.
5. Portar `wrap` de mensagens longas no layout de impressao.
6. Substituir persistencia local por API por usuario.
7. Rodar build + testes de regressao apos merge.

## Observacao final

A implementacao atual ficou preparada para operacao local (persistencia no browser) e ja separa claramente os contextos de impressao. Isso facilita a migracao para SaaS por usuario sem alterar regra de negocio de vendas, caixa e historico.
