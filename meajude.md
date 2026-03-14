# Migração Completa dos Ajustes (Mobile + Cálculo de Arquivos)

Este documento descreve **tudo o que foi feito neste chat**, do começo ao fim, para você replicar no projeto SaaS equivalente.

## 1) Objetivo inicial do trabalho

Problema reportado:
- Layout mobile estava ruim e desproporcional.
- Abas principais afetadas: `CAIXA`, `ESTOQUE`, `VENDAS`, `OUTROS`.
- Área `ADMINISTRAÇÃO` também quebrava no mobile: `geral`, `ANALISE`, `vendas`, `estornos`, `estoque`, `materiais`, `arquivos`, `CONFIG`.

Meta:
- Corrigir responsividade sem regressão de lógica de negócio.
- Preservar layout desktop.
- Melhorar navegação mobile.
- Depois, corrigir divergência de valores na aba `Arquivos`.

---

## 2) Arquivos alterados no projeto atual

- `components/Header.tsx`
- `components/AdminDashboard.tsx`
- `components/AdminSalesAnalyticsTab.tsx`
- `components/InventoryManager.tsx`
- `index.css`

---

## 3) Ajuste 1: Menu hambúrguer mobile (de dropdown empurrando layout para drawer lateral)

### Problema
- O menu mobile abria de cima para baixo e empurrava o conteúdo.

### Solução aplicada
Em `components/Header.tsx`:
- Substituição do menu inline por **drawer lateral off-canvas**.
- Inclusão de **overlay/backdrop** para fechar ao tocar fora.
- Fechamento com tecla `Esc`.
- Lock de scroll do body quando drawer está aberto (`document.body.style.overflow = 'hidden'`).
- Mantidas as mesmas rotas/abas (`CAIXA`, `ESTOQUE`, `VENDAS`, `OUTROS`, `ADMIN`) e mesma lógica de navegação.

### Resultado
- Menu abre lateralmente, elegante e sem deslocar layout da página.

---

## 4) Ajuste 2: Correções de responsividade mobile em massa

Foi feito um pacote conservador focado em UI, principalmente em `ADMIN`.

## 4.1) Correção crítica encontrada

Em `components/InventoryManager.tsx`:
- Classe raiz estava escrita como `qqb-inventory`.
- Corrigido para `qb-inventory`.

Impacto:
- As regras mobile de `.qb-inventory` em `index.css` voltaram a aplicar corretamente.

---

## 4.2) Melhorias em `components/AdminDashboard.tsx`

### Ajustes gerais responsivos
- Título de `ADMINISTRAÇÃO` ajustado para `text-3xl sm:text-4xl`.
- Painéis principais ficaram responsivos com padding/radius adaptáveis:
  - De `p-8 rounded-[40px]` para padrões como `p-4 sm:p-8 rounded-[28px] sm:rounded-[40px]`.
- Mesma lógica de dados preservada.

### Abas ajustadas
- `estornos`
- `arquivos`
- `configuracao`
- `vendas`
- `materiais`
- `estoque`

### Ajustes de componentes internos
- Botões de expansão de mês/dia receberam classes auxiliares:
  - `qb-admin-month-toggle`
  - `qb-admin-day-toggle`
- Cards de arquivo receberam `qb-archive-tile`.
- Tipografia reduzida no mobile para datas/labels longos.
- Botões grandes de `CONFIG` ficaram `w-full` no mobile para evitar quebra e overflow.

---

## 4.3) Melhorias em `components/AdminSalesAnalyticsTab.tsx`

### Ajustes aplicados
- Painel analytics responsivo com `p-4 sm:p-8` e radius adaptado.
- Headings principais ajustados para `text-xl sm:text-2xl`.
- Grades internas que quebravam no celular alteradas para mobile-first:
  - de `grid-cols-2` para `grid-cols-1 sm:grid-cols-2` em blocos críticos.

### Resultado
- Cards e blocos analíticos deixam de ficar espremidos em telas pequenas.

---

## 4.4) Melhorias estruturais em `index.css`

Foi feito reforço de CSS responsivo para garantir prioridade sobre classes utilitárias fixas.

### Principais mudanças
- `qb-admin-tabs`:
  - virou trilha horizontal com scroll (`nowrap`, `overflow-x-auto`), sem wrap quebrando linha.
  - botões com `flex: 0 0 auto`, `white-space: nowrap`.
- Painéis admin (`.qb-admin-panel`, `.qb-admin-config`, `.qb-admin-summary`, `.qb-admin-cash`):
  - padding e border-radius responsivos com prioridade.
- Ajustes de tipografia e espaçamento:
  - header admin, stat cards, panel-head.
- Ajustes de elementos de arquivo:
  - `qb-admin-month-toggle`, `qb-admin-day-toggle`, `qb-archive-tile`.
- Ajustes de tabelas:
  - min-width reduzido para mobile (`560px`) com scroll horizontal.
- Ajustes específicos de analytics mobile:
  - grids forçados para 1 coluna em pontos críticos.
  - alturas de gráficos reduzidas para `220px` no mobile.
- Ajustes extras para `max-width: 480px`:
  - refinamento de botões de tabs admin.

---

## 5) Ajuste 3: Correção de cálculo na aba `Arquivos` (ADMIN)

Você reportou que os valores da aba `Arquivos` estavam incorretos.

### Causa identificada
A aba `Arquivos` somava receita/lucro direto por item (`sale.total`), sem consolidar pedido:
- Em pedidos com múltiplos itens (`saleDraftId`), pode haver distorção quando a leitura esperada é por pedido.
- Em pedidos de app (`IFOOD`, `APP99`, `KEETA`), o valor real do pedido pode ser `appOrderTotal`, diferente da soma item a item.

### Solução implementada
Em `components/AdminDashboard.tsx`:

#### Foi criado:
- `interface ConsolidatedArchiveFinance`
- `const isAppOrigin(...)`
- `const buildConsolidatedArchiveFinance(entries: Sale[])`

#### Regra de consolidação aplicada
Para cada venda:
- Chave de agrupamento:
  - `draft:${saleDraftId}` quando existe `saleDraftId`
  - `sale:${sale.id}` caso contrário
- Receita fallback: soma de `sale.total` dos itens
- Receita app efetiva:
  - se origem é app e `appOrderTotal > 0`, usa `appOrderTotal`
  - senão usa fallback
- Custo: soma de `sale.totalCost` do grupo
- Lucro: `receita efetiva - custo`
- Tudo com arredondamento monetário (`roundMoney`).

### Onde os valores foram trocados para o novo cálculo
Na aba `Arquivos`:
- Card de mês (lucro do mês)
- Card de dia (lucro do dia)
- Header de detalhe do dia (lucro do dia)
- Cards de detalhe (`Receita` e `Lucro`)

Observação:
- Resumo de apps (`Apps: pedidos e valor`) continua usando `buildAppChannelSummary`, mantendo compatibilidade com leitura já existente.

---

## 6) Segurança e preservação de comportamento

Durante todas as alterações:
- Não foi alterada lógica de comandos de estado.
- Não foi alterada persistência remota/local.
- Não houve mudança de schema/migrations.
- Não houve alteração de autenticação/permissões.
- Mudanças concentradas em UI responsiva + cálculo de exibição em Arquivos.

---

## 7) Validação executada

Comando executado após as mudanças:
- `npm run build:sistema`

Status:
- Build concluído com sucesso.
- Sem erros de TypeScript/compilação.

---

## 8) Checklist para aplicar no projeto SaaS (igual)

Use esta sequência no outro projeto:

1. Aplicar mudança do drawer mobile no `Header`.
2. Corrigir typo de classe raiz de estoque (`qqb-inventory` -> `qb-inventory`), se existir.
3. Replicar ajustes responsivos do `AdminDashboard`.
4. Replicar ajustes responsivos do `AdminSalesAnalyticsTab`.
5. Replicar bloco de CSS mobile reforçado no `index.css`.
6. Implementar consolidação de cálculo em `Arquivos` com `buildConsolidatedArchiveFinance`.
7. Substituir as leituras antigas (`monthProfit/dayProfit/selectedProfit` por soma direta) pelas novas consolidadas.
8. Rodar build do frontend e validar em celular real.

---

## 9) Pontos de atenção ao portar para SaaS

- Se o SaaS tiver nomes de arquivo/componentes diferentes, portar por bloco lógico, não por linha.
- Se o SaaS tiver outra modelagem para app (`appOrderTotal` com outro nome), adaptar na função consolidada.
- Se houver múltiplas moedas/locales, manter `roundMoney` centralizado para evitar divergência visual.
- Garantir que agrupamento por pedido continue usando `saleDraftId` (ou equivalente no SaaS).

---

## 10) Resumo executivo (curto)

Foi entregue:
- Navegação mobile moderna com drawer lateral.
- Responsividade ampla nas telas críticas mobile (com foco no ADMIN completo).
- Correção real de cálculo na aba `Arquivos`, consolidando por pedido e respeitando `appOrderTotal` para apps.
- Build validado sem quebrar o sistema.
