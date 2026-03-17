# Guia Completo de Impressão (Cupom + Histórico de Fechamentos)

## 1) Objetivo deste documento
Este documento descreve exatamente como ficou o sistema de impressão neste projeto, para você replicar no outro projeto (inclusive versão SaaS) sem perder funcionalidades existentes.

Foco principal:
- manter o cupom fiscal da aba `CAIXA` intacto;
- padronizar o `Histórico de Fechamentos` (aba `VENDAS`) para imprimir com o mesmo comportamento visual do cupom;
- corrigir corte lateral, alinhamento de valores e confiabilidade de abertura/impressão.

## 2) Escopo final (o que foi mantido e o que mudou)

### 2.1 Mantido (sem alteração funcional)
- fluxo do cupom fiscal da aba `CAIXA` (rota de impressão e regras de negócio);
- dados e blocos já existentes do relatório de fechamento;
- controles e histórico já existentes.

### 2.2 Alterado
- impressão do `Histórico de Fechamentos` passou a usar rota própria (como o cupom), não `about:blank`;
- aplicação de presets de papel para histórico (48/58/72/80/A4);
- alinhamento em duas colunas no render final (rótulo à esquerda, valor à direita), estilo cupom;
- robustez de transporte de payload de impressão com 3 caminhos (localStorage + window.name + hash da URL);
- `VALORES INFORMADOS` no fechamento passou a considerar somente balcão/local; apps ficam apenas em `CANAIS DE VENDA`.

## 3) Modelos e medidas

## 3.1 Modelos de impressão disponíveis
Usados no `Histórico de Fechamentos`:
- 48 x 297 mm
- 58 x 297 mm
- 72 x 297 mm
- 80 x 297 mm
- A4 210 x 297 mm

## 3.2 Padrões no código
- `Histórico de Fechamentos` (VENDAS):
  - preset default: `80x297`
  - storage key: `qb_history_print_preset_v1`
- `Histórico do Dia` / Relatório diário (FULL):
  - mantém preset próprio com opção `Padrão`
  - storage key: `qb_cash_print_preset_v1`
- Cupom fiscal:
  - presets no App
  - storage key: `qb_receipt_print_preset_v1`
  - largura ativa também em `qb_receipt_paper_width_mm`

## 3.3 Medida efetiva da folha no render final
No estado atual, tanto cupom quanto `Histórico de Fechamentos` usam a mesma lógica visual de largura:
- `@page { size: <paperWidthMm>mm auto; margin: 0; }`
- largura visual baseada em `getReceiptPaperWidthMm()`
- tipografia mono (`Courier New`) e padding igual ao cupom.

Observação importante:
- no preview do Chrome, o tamanho visual também depende de opções do diálogo de impressão (`Margens`, `Ajustar à página`, etc). O código já fixa a página para o formato térmico.

## 4) Fluxo do cupom fiscal (referência que foi preservada)

1. `App.tsx` abre janela na rota:
- `/print/:receiptId`
2. `index.tsx` detecta rota de impressão e renderiza `PrintReceipt`.
3. `PrintReceipt.tsx`:
- carrega dados;
- chama `window.print()`;
- no `window.onafterprint`, fecha a janela;
- usa CSS de impressão térmica (largura dinâmica + `@page` + estilo mono).

Nada desse fluxo foi quebrado.

## 5) Fluxo do Histórico de Fechamentos (como ficou)

## 5.1 Geração do conteúdo (SalesSummary)
Em `components/SalesSummary.tsx`, no `mode: 'SUMMARY'`:
- monta todas as linhas do relatório (`reportLines`);
- calcula resumo de pagamentos local;
- monta canais de venda separadamente;
- aplica alinhamento térmico e separadores.

### Regra de pagamento ajustada
Para `SUMMARY`:
- `VALORES INFORMADOS` = somente vendas não-app (`LOCAL`);
- `IFOOD/APP99/KEETA` aparecem apenas em `CANAIS DE VENDA`.

## 5.2 Abertura da impressão por rota (sem about:blank)
Ainda em `SalesSummary.tsx`:
- salva payload de impressão;
- abre rota:
  - `/print/report/:payloadId`
- envia payload por 3 canais:
  - localStorage;
  - `window.name`;
  - hash na URL (`#srp=...`) quando couber.

## 5.3 Render da rota de impressão
`index.tsx` detecta a rota e renderiza `PrintSalesReport`.

`components/PrintSalesReport.tsx`:
- recupera payload (localStorage > window.name > hash);
- chama `window.print()`;
- fecha no `onafterprint`;
- remove payload após impressão;
- renderiza em layout de linhas estilo cupom (duas colunas quando aplicável).

## 6) Ajustes visuais aplicados para ficar “igual cupom”

No `PrintSalesReport.tsx`:
- mesmo modelo de página do cupom:
  - `@page size: largura_mm auto`;
- mesma base tipográfica:
  - `font-size: 10px`;
  - `line-height` equivalente;
  - `font-weight: 700`;
- mesmo estilo de área útil:
  - padding térmico equivalente;
- separador visual:
  - `border-top: 2px dashed #000`;
- linhas com grid em 2 colunas:
  - label à esquerda;
  - valor à direita (`text-align: right; white-space: nowrap`).

No `SalesSummary.tsx`:
- ajuste para preservar espaçamento da coluna de valor (sem colapsar espaços no alinhamento de pares);
- deslocamento lateral aplicado apenas em `SUMMARY` para evitar corte de primeira letra sem afetar `FULL`.

## 7) Confiabilidade (correções de erro de payload não encontrado)

Erro tratado:
- `Erro ao gerar relatório / Relatório não encontrado para impressão`.

Camadas de fallback implementadas:
1. payload em localStorage (`qb_sales_report_print_payload_v1:<id>`);
2. payload em `window.name` da janela aberta;
3. payload no hash da URL de impressão (`#srp=...`).

Com isso, mesmo em cenários de bloqueio/sincronização da aba, o relatório abre.

## 8) Chaves de armazenamento usadas

- `qb_receipt_print_preset_v1`
- `qb_receipt_paper_width_mm`
- `qb_history_print_preset_v1`
- `qb_cash_print_preset_v1`
- `qb_sales_report_print_payload_v1:<payloadId>`

## 9) Arquivos principais envolvidos

- `App.tsx`
- `index.tsx`
- `components/PrintReceipt.tsx`
- `components/SalesSummary.tsx`
- `components/PrintSalesReport.tsx`
- `utils/printRoutes.ts`
- `utils/salesReportPrintPayload.ts`
- `utils/receiptPaper.ts`

## 10) Como replicar no outro projeto (base igual)

1. Copiar utilitários:
- `utils/printRoutes.ts`
- `utils/salesReportPrintPayload.ts`

2. Garantir roteamento de impressão em `index.tsx`:
- `/print/:id` -> `PrintReceipt`
- `/print/report/:payloadId` -> `PrintSalesReport`

3. Levar componente:
- `components/PrintSalesReport.tsx`

4. Atualizar `SalesSummary.tsx`:
- abrir impressão de `SUMMARY` pela rota `/print/report/:payloadId`;
- enviar payload por localStorage + window.name + hash;
- manter regras de conteúdo existentes.

5. Conferir presets/chaves:
- histórico (`qb_history_print_preset_v1`)
- cupom (`qb_receipt_print_preset_v1`, `qb_receipt_paper_width_mm`)
- full/cash (`qb_cash_print_preset_v1`).

6. Rodar validações:
- build do front;
- testes backend/regressivos;
- teste manual em impressão real.

## 11) Adaptação para SaaS (por usuário/tenant)

No SaaS, não usar chaves globais únicas para todos.

## 11.1 Estratégia recomendada
Prefixar as chaves de impressão com contexto do usuário/tenant.

Exemplo:
- `qb:<tenantId>:<userId>:receipt_print_preset`
- `qb:<tenantId>:<userId>:receipt_paper_width_mm`
- `qb:<tenantId>:<userId>:history_print_preset`
- `qb:<tenantId>:<userId>:cash_print_preset`

## 11.2 Opção ideal (persistência server-side)
Salvar no backend por usuário/tenant:
- preset do cupom;
- largura ativa;
- preset do histórico;
- preset do relatório full.

Vantagem:
- configuração permanente por usuário;
- funciona em qualquer dispositivo do usuário;
- evita conflito entre clientes no mesmo navegador.

## 11.3 Compatibilidade
Se não houver backend imediato:
- usar localStorage com prefixo de tenant/user;
- manter fallback local sem quebrar fluxo atual.

## 12) Checklist de validação manual no projeto destino

1. Cupom fiscal da aba `CAIXA`:
- abre em `/print/:id`;
- imprime e fecha sozinho;
- não perdeu layout.

2. Histórico de Fechamentos (`VENDAS`):
- abre em `/print/report/:payloadId`;
- não cai em `about:blank`;
- não aparece erro de payload;
- valores alinhados à direita;
- sem corte de primeira letra.

3. Regras de negócio no fechamento:
- `VALORES INFORMADOS` sem app;
- app apenas em `CANAIS DE VENDA`.

4. Presets:
- 48/58/72/80/A4 funcionando;
- preset selecionado persistindo.

## 13) Resumo final para copiar no outro sistema
- O cupom foi preservado.
- O relatório de fechamento foi migrado para rota de impressão dedicada.
- O layout do relatório foi padronizado para o estilo do cupom.
- Foram adicionados mecanismos robustos de transporte de payload para eliminar falhas intermitentes.
- As regras de cálculo de canais/pagamentos no fechamento foram ajustadas sem remover informações.
- A base está pronta para SaaS com persistência por usuário/tenant.
