# MEAJUDE - DOCUMENTACAO COMPLETA DO SISTEMA

Atualizado em: 2026-03-18
Branch: main

## 1) Objetivo deste documento

Este arquivo registra como o sistema ficou depois das melhorias de fila assincrona, anti-trava e resiliencia de carrinho/pagamento.

Foco:
- explicar o fluxo real ponta a ponta
- explicar o que e local (front) e o que e oficial (backend/banco)
- explicar como o sistema se recupera de erro
- dar guia pratico para operacao em producao

## 2) Resumo executivo (estado atual)

- O sistema agora trabalha em modelo hibrido com fila real no backend e fila de resiliencia no frontend.
- Confirmar pagamento nao depende mais de terminar tudo no mesmo request sincrono.
- Existe fila duravel no banco para comandos assincronos de estado.
- O frontend tem monitor visual de fila (cards empilhados), tentativas automaticas e botoes de recuperacao.
- O carrinho reserva estoque localmente para evitar "falso disponivel" sem depender da API em cada clique.
- A baixa oficial de estoque continua no backend somente em `PAID` (nao em `DRAFT`).
- Em erro, o sistema tenta se auto recuperar antes de exigir acao manual do operador.

## 3) Arquitetura atual (visao ampla)

### Frontend (App.tsx)

Camadas principais:
- fila local de itens pendentes de draft
- fila local de sincronizacao de pagamento
- fila local de falhas de pagamento
- monitor visual de fila no canto
- fallback para devolver pedido ao carrinho quando necessario

Persistencias locais (localStorage):
- `qb_pending_draft_adds_v1`
- `qb_pending_paid_sync_queue_v1`
- `qb_failed_paid_sync_queue_v1`

### Backend (API + Prisma)

Fila assincrona real:
- tabela: `state_command_jobs`
- worker dedicado: `state-command-queue.worker.ts`
- service de fila: `state-command-queue.service.ts`
- endpoints:
  - `POST /api/v1/state/commands/async`
  - `GET /api/v1/state/commands/jobs/:jobId`

Status de job:
- `PENDING`
- `PROCESSING`
- `RETRY`
- `COMPLETED`
- `FAILED`

## 4) Fluxo completo atual do pedido

### 4.1 Adicionar produto no carrinho

1. Operador clica no produto.
2. Front nao manda imediatamente toda carga pesada para banco.
3. Item entra em pendencia local (`pendingDraftAdds`) e aparece no carrinho.
4. Sync de background envia `SALE_DRAFT_ADD_ITEM` com controle de fila por draft.
5. Enquanto isso, a tela continua responsiva.

### 4.2 Finalizar pagamento

1. Operador clica em confirmar pagamento.
2. Front cria um `PendingPaidSyncJob` com snapshot completo do pedido.
3. Job entra na fila local de pagamento.
4. Processador da fila executa:
   - flush dos itens pendentes do draft
   - finalize da forma de pagamento
   - confirmacao de pago (`SALE_DRAFT_CONFIRM_PAID`)
5. Em backend, o comando e processado com idempotencia e versao de estado.

### 4.3 Quando a fila backend e usada

- Comando assincrono e aceito por `POST /commands/async`.
- Backend grava job em `state_command_jobs`.
- Worker faz claim, processa, atualiza status, e aplica retry quando cabivel.
- Front consulta status do job e atualiza estado local por snapshot.

## 5) Separacao oficial: local vs banco

### Local (front)

- Reserva visual de estoque em draft.
- Itens pendentes locais no carrinho.
- UI de monitor da fila de pedidos.
- Auto tentativas de reenvio em falha.

### Oficial (backend/banco)

- Estado real do pedido.
- Status final da venda.
- Baixa oficial de estoque em `PAID`.
- Auditoria e versao de estado.

## 6) Melhorias implementadas (detalhado por fase)

### Fase A - Fila assincrona real no backend

Implementado:
- tabela `state_command_jobs` com indices e constraints
- deduplicacao por `command_id`
- worker com lock, stale lock recovery e retry com backoff
- status terminal e consulta de job
- rollout conservador: fila habilitada primeiro para `SALE_DRAFT_CONFIRM_PAID`
- `SALE_DRAFT_FINALIZE` opcional via flag de ambiente

Beneficio:
- request principal desacoplado do processamento completo
- menor chance de travar front por operacao longa
- rastreabilidade de cada comando assincrono

### Fase B - Fila de pagamento no frontend + anti-stall

Implementado:
- fila local de pagamento pendente
- processamento em loop seguro com timers
- fallback sync quando endpoint async nao suportado
- refresh de snapshot apos terminal status
- fila de falhas separada da fila ativa

Beneficio:
- operacao continua mesmo com lentidao/intermitencia
- pedido nao bloqueia todo resto da fila

### Fase C - Monitor visual de fila + retry por card

Implementado:
- painel "Fila de Pedidos" no canto
- cards por pedido com status e erro resumido
- botao `Tentar de Novo` por card
- feedback de retry/sucesso/erro no canto

Beneficio:
- operador ve exatamente o que esta pendente/falhou
- acao pontual sem perder contexto

### Fase D - Alerta de estoque em falha

Implementado:
- parser de mensagem de erro para detectar falta de estoque/insumo
- notificacao dedicada de alerta de estoque

Beneficio:
- erro fica claro para operacao e suporte

### Fase E - Reserva local de estoque no carrinho

Implementado:
- calculo de estoque reservado por itens em drafts abertos
- disponibilidade dos cards usa estoque efetivo local
- bloqueio de incremento (`+`) quando nao ha saldo local
- alerta imediato ao tentar adicionar sem estoque

Beneficio:
- evita vender acima do possivel enquanto ainda nao sincronizou tudo no backend
- reduz surpresa de erro tardio no pagamento

### Fase F - Auto recuperacao para erro "carrinho vazio"

Implementado:
- deteccao especifica de `HTTP 422: O carrinho esta vazio`
- reconstrucao automatica do draft a partir do snapshot do job
- regeneracao de commandIds de finalize/confirm
- reexecucao automatica com limite seguro

Beneficio:
- reduz erro falso de fila quando draft server ficou sem itens temporariamente

### Fase G - Auto click "Tentar de Novo" (2x) + resolucao manual assistida

Implementado:
- cada card em falha tenta automaticamente ate 2 vezes
- indicador visual de auto tentativa no card
- apos esgotar tentativas automaticas, aparece `Resolver no Carrinho`
- botao manual continua disponivel

Beneficio:
- menos trabalho manual no caixa
- evita deixar o operador preso em tentativa repetitiva

### Fase H - Limpeza de itens locais pendentes no carrinho

Problema tratado:
- item podia voltar como pendente local (nao vinculado ao banco), logo "Limpar do Banco" nao aparecia.

Implementado:
- botao novo `Limpar Pendentes`
- remove apenas itens locais pendentes daquele draft
- mantem separado do `Limpar do Banco`

Beneficio:
- operador consegue limpar "item fantasma local" sem afetar itens ja sincronizados

### Fase I - Serializacao segura ao mover pendencias para recovery

Problema tratado:
- em confirmacao de pagamento, podia haver corrida entre flush em background e a transferencia `visible -> recovery`, reintroduzindo itens pendentes no carrinho.

Implementado:
- transferencia para `recovery` agora usa a mesma fila por draft usada no flush (`pendingDraftFlushQueueRef`), garantindo ordem e evitando snapshot stale.
- `handleConfirmPaid` agenda essa transferencia na mesma fila antes de iniciar o processamento do job de pagamento.

Beneficio:
- elimina retorno indevido de itens para o carrinho por condicao de corrida local, sem alterar o fluxo principal de fila e auto-recuperacao.

### Fase J - Robo de auto-reenqueue para draft que voltou do banco

Problema tratado:
- em alguns cenarios, draft retornava como `PENDING_PAYMENT` fora da fila local e reaparecia para operacao.

Implementado:
- watchdog que detecta draft `PENDING_PAYMENT` com itens, fora de `pending`/`failed`/`syncing` e sem venda persistida.
- robo monta snapshot do proprio draft e reenfileira automaticamente para confirmar no banco.
- ao reenfileirar, dispara processamento imediato da fila e registra evento no monitor.

Beneficio:
- quando um pedido volta do banco em estado pendente, ele entra de novo na fila de forma automatica, rapida e sem acao manual.

### Fase K - Filtro global de periodo no ADMIN

Problema tratado:
- os paineis do ADMIN exibiam historico total por padrao, sem um recorte temporal global no topo.

Implementado:
- novo filtro global no topo do ADMIN com modos: `Todos`, `Dia`, `Mes`, `Ano`, `Intervalo`.
- o filtro aplica o mesmo intervalo para as fontes usadas em `geral`, `analise`, `vendas`, `estornos`, `estoque` e `materiais`.
- `dailySalesHistory` tambem passa pelo mesmo recorte para manter os graficos coerentes com o periodo ativo.
- guardas adicionais para evitar estados invalidos quando o recorte muda (ex.: selecao de mes/dia em `arquivos` e ano selecionado em abas com chip de ano).

Beneficio:
- leitura operacional mais rapida por periodo (dia, mes, ano ou faixa), sem alterar a estrutura existente dos cards e tabelas.

## 7) Como o sistema evita duplicidade de baixa de estoque

Regra oficial:
- `DRAFT` nao faz baixa oficial no backend.
- `PAID` faz baixa oficial no backend.

Protecoes:
- backend checa `draft.status === PAID` ou `draft.stockDebited` e retorna sem debitar de novo.
- `SALE_DRAFT_CONFIRM_PAID` e idempotente.
- commandId e deduplicacao de job ajudam a evitar processamento repetido indevido.

## 8) Comportamento de falha (o que acontece na pratica)

### Falha temporaria (rede/lentidao/backend 5xx)

- entra em retry com backoff
- job permanece em fila sem travar interface

### Falha nao retryable

- vai para fila de falhas
- card mostra erro
- agora tenta auto retry 2x
- se nao resolver: fica com acao manual (`Resolver no Carrinho`)

### Erro "carrinho vazio" (422)

- sistema tenta reconstruir draft do snapshot
- reenfileira automaticamente
- se ainda falhar e esgotar: operador resolve no carrinho

## 9) Operacao recomendada para o caixa

### Fluxo normal

1. Adicionar itens normalmente.
2. Confirmar pagamento.
3. Se houver fila, aguardar status do card.

### Se um card falhar

1. Aguardar auto tentativas (max 2).
2. Se resolver, nao precisa fazer nada.
3. Se nao resolver, usar `Resolver no Carrinho`.
4. No carrinho:
   - usar `Limpar do Banco` para itens ja sincronizados no servidor
   - usar `Limpar Pendentes` para itens locais ainda nao enviados
5. Ajustar e confirmar novamente.

## 10) Variaveis de ambiente relevantes

### Estado/transacao

- `APP_STATE_TX_MAX_WAIT_MS`
- `APP_STATE_TX_TIMEOUT_MS`

### Fila backend

- `STATE_COMMAND_QUEUE_WORKER_ENABLED`
- `STATE_COMMAND_QUEUE_ENABLE_FINALIZE`
- `STATE_COMMAND_QUEUE_POLL_INTERVAL_MS`
- `STATE_COMMAND_QUEUE_BATCH_SIZE`
- `STATE_COMMAND_QUEUE_STALE_LOCK_MS`
- `STATE_COMMAND_QUEUE_MAX_ATTEMPTS`
- `STATE_COMMAND_QUEUE_RETRY_BASE_MS`
- `STATE_COMMAND_QUEUE_RETRY_MAX_MS`

## 11) Validacao executada neste ciclo

Comandos executados repetidamente apos mudancas:

- `npm run build:sistema`
- `npm --prefix backend run build`
- `DATABASE_URL=\"file:./prisma/dev.db\" npm --prefix backend test`

Resultado:
- build frontend OK
- build backend OK
- testes backend OK (63/63)

## 12) Referencia de entregas (commits)

- `0264392` feat: fila assincrona duravel + anti-stall cart sync
- `099ccf9` feat: limpar itens do banco no carrinho + flag de finalize async
- `cd0fa28` feat: monitor de fila no canto + retry cards + alerta estoque
- `59e168f` feat: reserva local de estoque no carrinho
- `dd59a39` fix: auto recover para erro de draft vazio
- `1b31727` feat: auto retry 2x em falhas + limpar pendentes locais

## 13) Limites conhecidos e proximo passo seguro

Limites:
- O monitor de fila frontend depende de localStorage da maquina atual.
- Se limpar storage/local do navegador manualmente, perde historico local de filas front.
- Build front ainda mostra warning de chunk grande (nao quebra, mas pode ser otimizado depois).

Proximo passo seguro:
- deploy canario noturno
- monitorar cards de fila por 1 noite
- revisar logs de erro e ajustar thresholds de retry se necessario
