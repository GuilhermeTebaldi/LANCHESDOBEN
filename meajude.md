# ME AJUDE - Replica SaaS (100% do que foi feito neste chat)

## 1) Objetivo final alcançado

Implementamos no sistema de caixa uma mudança estrutural:

- Antes: a cada clique em produto, já enviava para API/banco (`SALE_DRAFT_ADD_ITEM`), deixando o operador lento.
- Depois: clique de produto fica local (rápido), e o envio para banco acontece em lote no `CONFIRMAR PAGO`.
- O operador pode continuar vendendo enquanto o banco processa em background.
- O status de sincronização ficou discreto no canto (quase imperceptível), sem overlay intrusivo no topo.
- A impressão do cupom passou a abrir imediatamente com dados do front, sem esperar persistência do banco.
- Ajustamos ainda:
1. feedback imediato no `DESFAZER ÚLTIMA`;
2. contagem de `PEDIDOS` no relatório por pedido (carrinho), não por item.

---

## 2) Arquivos alterados/criados

- `App.tsx`
- `components/PrintReceipt.tsx`
- `utils/receiptPrintPayload.ts` (novo)
- `components/SalesSummary.tsx`
- `index.css`

---

## 3) Mudanças detalhadas no Caixa (envio só no CONFIRMAR PAGO)

### 3.1 Fila local de itens pendentes (novo fluxo de venda)

Criado mecanismo local para segurar itens do carrinho antes de enviar ao banco:

- chave localStorage: `qb_pending_draft_adds_v1`
- tipos:
1. `PendingDraftAdd`
2. `PendingDraftAddsByDraftId`
- funções:
1. `normalizePendingDraftAdd`
2. `loadPendingDraftAdds`
3. `savePendingDraftAdds`
4. `replacePendingDraftAdds`
5. `hydratePendingDraftAdds`

Objetivo:

- operador clica produto -> item entra no estado local imediatamente;
- zero espera de rede no clique;
- persistência local evita perda em refresh/instabilidade curta.

### 3.2 Clique de produto não chama API

No `handleSale`:

- removido envio imediato para backend;
- agora apenas:
1. resolve/cria draft local;
2. chama `queuePendingDraftAdd(...)`;
3. atualiza UI e notificação do carrinho.

### 3.3 Clique no carrinho não chama API

No `handleOpenCart`:

- passou a somente abrir carrinho e selecionar draft editável local;
- não chama mais criação/sincronização remota ao abrir carrinho.

### 3.4 Cancelar venda sem payload remoto não chama API

No `handleCancelActiveDraft`:

- se draft só local (ainda não existe no servidor) -> cancela local, limpa fila pendente, sem API.
- se draft existe no servidor, mas sem itens persistidos (`items.length === 0`) -> também cancela local sem API.
- só chama `SALE_DRAFT_CANCEL` quando há de fato dados persistidos no servidor.

### 3.5 Edição de item pendente local

`handleUpdateDraftItemQuantity` e atualização de observação foram adaptados:

- primeiro tenta atualizar/remover item na fila pendente local;
- se não for item local pendente, aí sim usa comando remoto de update/remove.

### 3.6 Flush em lote no `CONFIRMAR PAGO`

Criada função `flushPendingDraftAdds(draftId, customerType)`:

- garante que draft exista no servidor (cria com `SALE_DRAFT_CREATE` se necessário);
- envia itens pendentes um a um com `SALE_DRAFT_ADD_ITEM`, somente nessa etapa;
- limpa fila local conforme cada item é confirmado;
- usa `trackPendingState: false` para não poluir overlay principal.

### 3.7 Drafts visíveis incluem itens pendentes locais

Criado `saleDraftsWithPendingAdds`:

- faz merge entre `saleDrafts` do servidor + pendências locais;
- permite visualizar no carrinho os itens ainda não enviados;
- cria draft virtual local quando existe pendência sem draft remoto.

### 3.8 Escolha de draft editável corrigida

Ajustada `resolveEditableDraftId`:

- ignora drafts em sincronização de pagamento;
- considera drafts locais pendentes;
- evita cair em draft inválido/sincronizando.

---

## 4) Estado de sincronização discreto (canto da tela)

### 4.1 Overlay topo deixou de ser usado para operações de caixa

`isSyncIndicatorVisible` foi reduzido para hidratação inicial (`isStateHydrating`), evitando barra carregando no topo durante operação normal do operador.

### 4.2 Indicador discreto no canto

Criado estado `cornerSyncState` com `showCornerSync(...)`:

- `syncing`: processando banco
- `success`: concluído
- `error`: falha

Usado em:

1. confirmação de pagamento;
2. desfazer última venda.

### 4.3 CSS de animação discreta

No `index.css`:

- `@keyframes qb-corner-sync-pulse`
- classe `.qb-corner-sync-pulse`

---

## 5) Correções no `CONFIRMAR PAGO` (estabilidade + sem corrida de estado)

### 5.1 Snapshot de pagamento (correção crítica)

Bug visto:

- ao fechar modal/carrinho cedo, estado UI mudava e a confirmação podia falhar/impressão quebrar.

Correção:

- criado `PaymentCommitSnapshot` e `handleSavePaymentMethod(snapshot, options)`;
- `handleConfirmPaid` monta snapshot no clique e usa sempre esse snapshot, não estado mutável da UI.

### 5.2 Sequência segura de confirmação

`handleConfirmPaid` passou a executar:

1. flush dos itens pendentes;
2. finalize da forma de pagamento;
3. `SALE_DRAFT_CONFIRM_PAID`;
4. feedback de sucesso/erro no canto.

### 5.3 Validações defensivas mantidas

No finalize:

- valida carrinho vazio;
- valida total de app (`IFOOD/99/KEETA`);
- valida dinheiro recebido;
- valida divisão (`DIVIDIDO`) completa e consistente;
- valida persistência de origem/valor app no backend antes de concluir.

---

## 6) Impressão do cupom: de “esperar banco” para “gerar no front”

## 6.1 Problema original

Mesmo após ajustes, o cupom ainda podia:

1. abrir “Carregando cupom...”;
2. esperar leitura persistida;
3. falhar com “Pedido não encontrado para impressão”.

Causa principal:

- dependência da leitura de estado persistido (backend/mirror) em uma etapa sujeita a latência.

## 6.2 Solução implementada

Criado pipeline de impressão local imediata no clique de `CONFIRMAR PAGO`.

### 6.2.1 Novo módulo: `utils/receiptPrintPayload.ts`

Responsabilidades:

1. criar payload sanitizado do cupom;
2. salvar payload em localStorage (`qb_receipt_print_payload_v1:*`);
3. fallback por `window.name` para atravessar janela/aba mesmo sem localStorage;
4. consumir/remover payload;
5. limpeza de payload expirado.

### 6.2.2 Geração do payload no `App.tsx`

Função `buildReceiptPrintPayloadFromSnapshot(...)`:

- usa snapshot de pagamento + itens do draft local;
- monta linhas, totais, forma de pagamento, troco, dividido, canal app, observações;
- sem depender de retorno do banco.

### 6.2.3 Abertura imediata do cupom

No clique de `CONFIRMAR PAGO`:

1. cria payload local;
2. injeta payload na janela preparada (`setReceiptPrintPayloadOnWindow`);
3. navega imediatamente para rota de impressão com `receiptPrintId` do payload;
4. API/banco continua em background;
5. não reabre impressão no fim.

## 6.3 `PrintReceipt` com prioridade local + fallback remoto

Fluxo novo em `components/PrintReceipt.tsx`:

1. tenta `consumeReceiptPrintPayload(receiptId)` primeiro;
2. se achar payload local válido, renderiza na hora e imprime;
3. se não achar payload local, mantém fallback antigo (`loadAppState`) com retry.

Ajustes importantes:

- timeout de fallback aumentado para `15000ms`;
- payload não é removido no primeiro render (evitou bug com dev/Strict mode);
- limpeza final no `onafterprint`.

## 6.4 Problemas pequenos corrigidos na impressão

1. **Assinatura quebrada**: chamada antiga de `handleSavePaymentMethod` causava falha de confirmação/impressão.
2. **Navegação precoce incorreta**: abrir rota de print antes da persistência causava “pedido não encontrado”.
3. **Strict mode/re-render**: remoção antecipada do payload gerava fallback indevido.
4. **Falha de localStorage**: `saveReceiptPrintPayload` passou a não abortar; fallback por `window.name` mantém impressão.

---

## 7) `DESFAZER ÚLTIMA` com feedback imediato

Problema:

- primeiro clique parecia “não fazer nada”.

Correção no `handleUndoLastSale`:

1. seta `isUndoProcessing` imediatamente;
2. mostra `showCornerSync('syncing', 'Desfazendo ... no banco')`;
3. executa comando remoto;
4. mostra sucesso/erro no canto;
5. bloqueia duplo clique.

UI:

- botão muda para `Desfazendo...`;
- botão `Histórico do Dia` também desabilita durante processamento.

---

## 8) Relatório: `PEDIDOS` por pedido (não por item)

Problema:

- card `Pedidos` na aba de relatório contava `sales.length` (itens), não pedidos.
- exemplo errado: 1 pedido com 2 itens aparecia como 2 pedidos.

Correção:

- criado agrupamento por pedido:
1. se `saleDraftId` existe -> chave do pedido é `draft:{saleDraftId}`;
2. sem `saleDraftId` -> chave é `sale:{sale.id}`.
- funções:
1. `countOrders` em `SalesSummary.tsx`
2. `countSaleOrders` em `App.tsx`

Pontos ajustados:

1. card `Pedidos` na aba relatório;
2. `currentDayReport.saleCount`;
3. impressão de relatório (`Total de pedidos`/`Pedidos`);
4. inferência histórica sem vínculo explícito.

---

## 9) Checklist de replicação para o sistema SaaS (ordem recomendada)

1. Implementar fila local de itens pendentes por draft.
2. Remover envio imediato em clique de produto/carrinho.
3. Ajustar cancelamento para não chamar API quando não existe persistência remota útil.
4. Implementar flush dos pendentes apenas no `CONFIRMAR PAGO`.
5. Separar indicador de hidratação global do indicador discreto de operações.
6. Migrar confirmação para snapshot imutável de pagamento.
7. Implementar payload local de impressão (`receiptPrintPayload`) + fallback `window.name`.
8. Abrir cupom imediatamente no clique; manter sync remota em background sem reabrir cupom.
9. Corrigir `DESFAZER ÚLTIMA` com estado visual imediato.
10. Corrigir contagem de pedidos por agrupamento (`saleDraftId`/`sale.id`).

---

## 10) Regressões evitadas (o que NÃO quebrar no SaaS)

1. Não remover fallback remoto no `PrintReceipt` (necessário para segunda via/histórico).
2. Não apagar payload local cedo demais (especialmente em ambiente com Strict Mode).
3. Não voltar a usar `sales.length` para pedidos.
4. Não recolocar overlay de sync no topo durante operações normais de caixa.
5. Não chamar API em `handleSale` e `handleOpenCart`.
6. Não chamar cancel remoto quando draft ainda está só local/sem itens persistidos.

---

## 11) Testes mínimos obrigatórios no SaaS (copiar este bloco)

1. Clique em 5 produtos rapidamente:
- esperado: carrinho atualiza instantâneo, sem travar UI.

2. Abrir carrinho:
- esperado: sem chamada remota desnecessária.

3. `Cancelar Venda` com itens só locais:
- esperado: não chamar API.

4. `CONFIRMAR PAGO`:
- esperado: cupom abre na hora com dados do front;
- esperado: banco sincroniza em background;
- esperado: não abre cupom novamente após retorno do banco.

5. Falha de banco no confirmar:
- esperado: status de erro no canto;
- esperado: operador continua usando sistema.

6. `DESFAZER ÚLTIMA`:
- esperado: no primeiro clique já mostra “Desfazendo...”;
- esperado: botão bloqueia repetição;
- esperado: status final de sucesso/erro no canto.

7. Relatório -> card `Pedidos`:
- cenário: 1 pedido com 2 itens no mesmo carrinho;
- esperado: contar 1 pedido (não 2).

---

## 12) Resumo executivo para copiar no outro time

O principal foi transformar o caixa em **UI-first com sync assíncrona segura**:

1. venda local instantânea;
2. persistência remota concentrada no confirmar;
3. impressão desacoplada do banco;
4. feedback visual discreto e imediato;
5. contagem de pedidos corrigida por agrupamento real.

Esse conjunto elimina sensação de lentidão para operador sem perder consistência no backend.
