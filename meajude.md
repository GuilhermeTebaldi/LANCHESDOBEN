# ME AJUDE - PORTAR AS MUDANCAS DO POS (cliente unico) PARA O POS SAAS

Data desta consolidacao: 2026-03-11

## 1) Resumo executivo (estado final)
Neste chat consolidamos um novo fluxo de pagamento para suportar:
- Pagamento dividido por pessoas (ex.: 2 pessoas, valor dividido automatico)
- Pagamento misto para 1 pessoa (ex.: parte PIX + parte dinheiro)
- Canal de venda por app (iFood / 99 / Keeta) via modal flutuante

No estado final, a tela de pagamento ficou assim:
- Metodos base continuam: PIX, Debito, Credito, Dinheiro
- Botao `Dividido` ativo/desativo (vira `Cancelar Dividido` quando em modo dividido)
- Botao `Apps` junto do `Dividido` (lado a lado)
- Sem card fixo `Canal da venda` no meio da tela
- `Apps` abre modal flutuante com iFood / 99 / Keeta
- Modal de apps fecha ao selecionar canal e tambem tem `X` no canto para fechar
- Botao `Alterar Forma` foi removido do footer
- Footer ficou: `Voltar`, `Cancelar Venda`, `Confirmar Pago`

## 2) O que foi alterado no backend (obrigatorio para funcionar sem erro 400)
Commit backend ja feito e publicado no repo deste projeto:
- `2b86788` - `feat(backend): suportar pagamento dividido no state command`

Arquivos backend impactados:
- `backend/src/services/state-command.service.ts`
- `backend/src/services/state-command.service.test.ts`
- `backend/src/types/frontend.ts`
- `backend/src/validators/state-command.validator.ts`

### 2.1) Tipos aceitos no backend
- Metodo de pagamento agora aceita: `PIX | DEBITO | CREDITO | DINHEIRO | DIVIDIDO`
- Modos de divisao: `PEOPLE | MIXED`
- Origem da venda: `LOCAL | IFOOD | APP99 | KEETA`

Referencias:
- `backend/src/types/frontend.ts:58-82`
- `backend/src/validators/state-command.validator.ts:56-68`
- `backend/src/validators/state-command.validator.ts:114-125`

### 2.2) Validacoes server-side de pagamento dividido
No `SALE_DRAFT_FINALIZE` com `paymentMethod = DIVIDIDO`:
- `splitMode` obrigatorio e valido
- `splitCount` obrigatorio e valido
- `splitPayments` obrigatorio (>= 1)
- Se `PEOPLE`, quantidade de parcelas precisa ser igual a `splitCount`
- Se `MIXED`, `splitCount` precisa ser 1 e precisa de >= 2 parcelas
- Cada parcela precisa de valor > 0
- Em parcela de dinheiro, `cashReceived` obrigatorio e >= valor da parcela
- Soma das parcelas precisa bater exatamente com total da venda

Referencias:
- `backend/src/services/state-command.service.ts:556-653`
- `backend/src/services/state-command.service.ts:669-705`
- `backend/src/services/state-command.service.ts:843-881`
- `backend/src/services/state-command.service.ts:921-954`

### 2.3) Validacoes de app sale no backend
Se origem for app (`IFOOD`, `APP99`, `KEETA`):
- `appOrderTotal` valido e > 0 e obrigatorio antes de finalizar/confirmar

Referencias:
- `backend/src/services/state-command.service.ts:854-864`
- `backend/src/services/state-command.service.ts:906-913`

## 3) O que foi alterado no frontend
Arquivos frontend impactados:
- `App.tsx`
- `types.ts`
- `data/stateCommandClient.ts`
- `components/PrintReceipt.tsx`
- `components/AdminDashboard.tsx`
- `components/SalesSummary.tsx`

## 3.1) Tipos e contrato de comando no frontend
### `types.ts`
- Criado `SaleBasePaymentMethod`
- `SalePaymentMethod` agora inclui `DIVIDIDO`
- Criado `SalePaymentSplitMode` (`PEOPLE | MIXED`)
- Criado `SalePaymentSplitEntry`
- `SalePayment` agora suporta `splitMode`, `splitCount`, `splitPayments`

Referencia:
- `types.ts:59-83`

### `data/stateCommandClient.ts`
`SALE_DRAFT_FINALIZE` agora envia opcionalmente:
- `splitMode`
- `splitCount`
- `splitPayments[]` (sequence, label, method, amount, cashReceived)

Referencia:
- `data/stateCommandClient.ts:82-97`

## 3.2) UI final de pagamento (`App.tsx`)
### A) Divisao de pagamento
- Botao `Dividido` abre modal para informar quantidade de pessoas
- Se quantidade > 1 => modo `PEOPLE` (valor auto dividido)
- Se quantidade = 1 => modo `MIXED` (operador informa parcelas por metodo)
- Em dinheiro, exige valor recebido por parcela
- Mostra troco/faltante por parcela em dinheiro
- Permite `Voltar`, `Reiniciar`, `Proximo/Concluir` dentro da area de detalhe
- So confirma venda quando plano dividido esta completo

Referencias:
- `App.tsx:1430-1544`
- `App.tsx:1553-1618`
- `App.tsx:2234-2265`
- `App.tsx:2955-3045`
- `App.tsx:3151-3190`

### B) Legibilidade do modo por pessoas
Texto melhorado no bloco da pessoa atual:
- `Pessoa X de Y`
- `Valor desta pessoa: R$ ...` com destaque visual

Referencia:
- `App.tsx:2963-2972`

### C) Apps no lugar correto (sem card fixo no meio)
Fluxo final:
- Card fixo `Canal da venda` foi removido da tela principal
- Botao `Apps` foi adicionado junto com `Dividido`
- `Dividido` e `Apps` estao lado a lado
- `Apps` abre modal flutuante
- Modal tem botoes iFood / 99 / Keeta
- Selecionou canal -> aplica e fecha modal
- Modal tambem fecha no `X` (canto superior) e ao clicar fora

Referencias:
- `App.tsx:2885-2915`
- `App.tsx:3084-3148`

### D) Correcao de estado no cancelar dividido
Bug corrigido:
- Ao abrir `Dividido` e cancelar, nao fica mais preso em `Cancelar Dividido`
- Agora volta para o metodo anterior (PIX, Debito, Credito, Dinheiro)

Referencias:
- `App.tsx:595-596`
- `App.tsx:1338-1346`
- `App.tsx:2889-2892`
- `App.tsx:3173-3176`

### E) Footer final
- Botao `Alterar Forma` removido
- Footer final: `Voltar`, `Cancelar Venda`, `Confirmar Pago`

Referencia:
- `App.tsx:3055-3080`

## 3.3) Impressao e relatorios
### `PrintReceipt.tsx`
- Agora imprime detalhes de parcelas quando pagamento e `DIVIDIDO`
- Exibe metodo por parcela, valor, recebido e troco/faltante quando for dinheiro

Referencias:
- `components/PrintReceipt.tsx` (blocos de `paymentSplits` e renderizacao de divisao)

### `AdminDashboard.tsx`
- Incluido label e badge para `DIVIDIDO`

Referencia:
- `components/AdminDashboard.tsx:38-47`

### `SalesSummary.tsx`
- Incluido `DIVIDIDO` no resumo e ordem de metodos

Referencia:
- `components/SalesSummary.tsx` (PaymentMethodSummaryKey, labels e acumulacao)

## 4) Autenticacoes e protecoes (estado final)
Voce pediu "todas as autenticacoes". Aqui esta o mapa completo.

## 4.1) Frontend - gate de acesso ao sistema
No `App.tsx`, antes de liberar o sistema:
- Verifica `ADMIN_GATE_KEY` em `sessionStorage` e `localStorage`
- Se nao existir em ambos, redireciona para raiz do site
- Mantem `AdminSessionBarrier` com token local + backup em session
- Heartbeat de reforco a cada 15s e em focus/pageshow/visibility

Referencias:
- `App.tsx:42-44`
- `App.tsx:204-269`
- `App.tsx:619-697`

## 4.2) Backend state API - autenticacao de escrita
Rotas de estado:
- `HEAD /api/v1/state`
- `GET /api/v1/state`
- `POST /api/v1/state/commands`

Leitura (`HEAD/GET`) usa `stateReadAuth` (Bearer opcional).
Escrita (`PUT/DELETE/POST commands`) usa `stateWriteAuth`:
- Aceita `Authorization: Bearer <jwt>` OU
- Aceita `X-State-Token` (jwt de escrita de estado)
- Exige `If-Match` com versao atual

Referencias:
- `backend/src/routes/state.routes.ts:9-13`
- `backend/src/middlewares/state-auth.middleware.ts:14-46`
- `backend/src/controllers/state.controller.ts:13-23`
- `backend/src/controllers/state.controller.ts:78-90`

## 4.3) Frontend state client - handshake de token/versao
O frontend usa fluxo seguro de concorrencia otimista:
- Faz HEAD/GET para obter `X-State-Version` + `X-State-Token`
- Envia comandos com `If-Match` e `X-State-Token`
- Se receber 401/412/428, invalida contexto e tenta 1 vez de novo

Referencias:
- `data/stateCommandClient.ts:418-445`
- `data/stateCommandClient.ts:469-503`

## 5) Testes executados durante este chat
Executados varias vezes, sempre com sucesso:
- `npm run build:sistema` -> OK
- `npm --prefix backend test` -> 60/60 OK
- `npm --prefix backend run lint` -> OK

Teste de producao investigado anteriormente:
- `POST /api/v1/state/commands` com `paymentMethod: DIVIDIDO` dava 400 quando backend antigo ainda nao estava atualizado.
- Causa raiz: enum antigo sem `DIVIDIDO`.
- Solucao: deploy backend com commit `2b86788`.

## 6) Checklist de portabilidade para a pasta SaaS
Ordem recomendada para evitar quebra:

1. Backend primeiro (obrigatorio)
- Portar:
  - `backend/src/types/frontend.ts`
  - `backend/src/validators/state-command.validator.ts`
  - `backend/src/services/state-command.service.ts`
  - `backend/src/services/state-command.service.test.ts`
- Rodar:
  - `npm --prefix backend test`
  - `npm --prefix backend run lint`

2. Frontend contrato/tipos
- Portar:
  - `types.ts`
  - `data/stateCommandClient.ts`

3. Frontend UI e fluxo
- Portar:
  - `App.tsx`
  - `components/PrintReceipt.tsx`
  - `components/AdminDashboard.tsx`
  - `components/SalesSummary.tsx`

4. Build e smoke tests
- `npm run build:sistema`
- Fluxos manuais minimos:
  - PIX simples
  - Dinheiro com troco
  - Dividido PEOPLE (2 pessoas)
  - Dividido MIXED (1 pessoa, 2 parcelas)
  - Apps (iFood/99/Keeta) com fechamento do modal
  - Confirmar pagamento e imprimir comprovante

## 7) Riscos e observacoes para o SaaS
- Se backend SaaS nao receber as mudancas de enum/validacao, vai repetir erro 400 em `SALE_DRAFT_FINALIZE` com `DIVIDIDO`.
- Em infraestrutura SaaS com multiplos tenants, garantir que auth/contexto de estado nao misture versoes entre tenants.
- O fluxo atual ainda usa `Proximo/Concluir` dentro do card de detalhe da divisao (nao no botao verde do footer).

## 8) Estado atual de commit neste workspace
- Backend dividido: commitado em `2b86788`.
- Frontend: ha alteracoes locais ainda nao commitadas (incluindo `App.tsx` e componentes).

Se quiser, no proximo passo eu gero um plano de cherry-pick/patch exatamente na ordem para aplicar no seu repositorio SaaS sem regressao.
