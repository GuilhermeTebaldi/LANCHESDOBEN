import test from 'node:test';
import assert from 'node:assert/strict';

import type { FrontAppState } from '../types/frontend.js';
import { HttpError } from '../utils/http-error.js';
import { applyStateCommand, commandTouchesArchiveState } from './state-command.service.js';

const pad2 = (value: number): string => String(value).padStart(2, '0');
const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const createBaseState = (): FrontAppState => ({
  ingredients: [
    { id: 'i-bread', name: 'Pao', unit: 'un', currentStock: 50, minStock: 10, cost: 1.5 },
    { id: 'i-meat', name: 'Carne', unit: 'un', currentStock: 40, minStock: 8, cost: 4.2 },
    { id: 'i-sauce', name: 'Molho', unit: 'g', currentStock: 200, minStock: 30, cost: 0.02 },
  ],
  products: [
    {
      id: 'p-burger',
      name: 'Burger',
      price: 20,
      imageUrl: 'https://example.com/burger.jpg',
      category: 'Snack',
      recipe: [
        { ingredientId: 'i-bread', quantity: 1 },
        { ingredientId: 'i-meat', quantity: 1 },
        { ingredientId: 'i-sauce', quantity: 20 },
      ],
    },
  ],
  sales: [],
  stockEntries: [],
  cleaningMaterials: [
    { id: 'cm-detergent', name: 'Detergente', unit: 'ml', currentStock: 3000, minStock: 500, cost: 0.01 },
  ],
  cleaningStockEntries: [],
  globalSales: [],
  globalCancelledSales: [],
  globalStockEntries: [],
  globalCleaningStockEntries: [],
});

test('applyStateCommand mutateInPlace preserves business output and avoids clone work', () => {
  const command = {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  } as const;

  const immutableInput = createBaseState();
  const immutableResult = applyStateCommand(immutableInput, command);

  const mutableInput = createBaseState();
  const mutableResult = applyStateCommand(mutableInput, command, { mutateInPlace: true });
  const getIngredientStocks = (state: FrontAppState) =>
    Object.fromEntries(state.ingredients.map((ingredient) => [ingredient.id, ingredient.currentStock]));

  assert.notEqual(immutableResult, immutableInput);
  assert.equal(mutableResult, mutableInput);
  assert.equal(mutableResult.sales.length, immutableResult.sales.length);
  assert.equal(mutableResult.stockEntries.length, immutableResult.stockEntries.length);
  assert.equal(mutableResult.globalSales.length, immutableResult.globalSales.length);
  assert.equal(mutableResult.globalStockEntries.length, immutableResult.globalStockEntries.length);
  assert.deepEqual(getIngredientStocks(mutableResult), getIngredientStocks(immutableResult));
  assert.equal(mutableResult.sales[0]?.total, immutableResult.sales[0]?.total);
  assert.equal(mutableResult.sales[0]?.totalCost, immutableResult.sales[0]?.totalCost);
  assert.equal(immutableInput.sales.length, 0);
});

test('commandTouchesArchiveState classifies hot-only commands safely', () => {
  assert.equal(commandTouchesArchiveState('SALE_DRAFT_ADD_ITEM'), false);
  assert.equal(commandTouchesArchiveState('SALE_DRAFT_FINALIZE'), false);
  assert.equal(commandTouchesArchiveState('SET_CASH_REGISTER'), false);
  assert.equal(commandTouchesArchiveState('START_BUSINESS_DAY'), false);
  assert.equal(commandTouchesArchiveState('CLEAR_ACTIVE_BUSINESS_DAY'), false);
  assert.equal(commandTouchesArchiveState('CLEAR_HISTORY'), false);

  assert.equal(commandTouchesArchiveState('SALE_REGISTER'), true);
  assert.equal(commandTouchesArchiveState('SALE_DRAFT_CONFIRM_PAID'), true);
  assert.equal(commandTouchesArchiveState('SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID'), true);
  assert.equal(commandTouchesArchiveState('SALE_EDIT_BY_ID'), true);
  assert.equal(commandTouchesArchiveState('CASH_EXPENSE'), true);
  assert.equal(commandTouchesArchiveState('CLOSE_DAY'), true);
});

test('sale register and undo keep stock and history consistent', () => {
  const base = createBaseState();
  const sold = applyStateCommand(base, {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });

  assert.equal(sold.sales.length, 1);
  assert.equal(sold.globalSales.length, 1);
  assert.equal(sold.stockEntries.length, 3);
  assert.equal(sold.globalStockEntries.length, 3);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 180);

  const undone = applyStateCommand(sold, {
    type: 'SALE_UNDO_LAST',
  });

  assert.equal(undone.sales.length, 0);
  assert.equal(undone.stockEntries.length, 0);
  assert.equal(undone.globalSales.length, 0);
  assert.equal(undone.globalCancelledSales.length, 1);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 200);
});

test('sale register is idempotent when clientSaleId is retried', () => {
  const base = createBaseState();
  const command = {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
    clientSaleId: 'sale-client-001',
  } as const;

  const first = applyStateCommand(base, command);
  const retried = applyStateCommand(first, command);

  assert.equal(retried.sales.length, 1);
  assert.equal(retried.globalSales.length, 1);
  assert.equal(retried.stockEntries.length, 3);
  assert.equal(retried.globalStockEntries.length, 3);
  assert.equal(retried.sales[0]?.id, 'sale-client-001');
  assert.equal(retried.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(retried.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(retried.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 180);
});

test('sale register in infinite stock mode skips recipe/stock costs and keeps inventory untouched', () => {
  const base = createBaseState();
  const state: FrontAppState = {
    ...base,
    products: base.products.map((product) =>
      product.id === 'p-burger' ? { ...product, recipe: [] } : product
    ),
    businessSettings: {
      infiniteStockEnabled: true,
      ignoreStockCosts: false,
    },
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });

  assert.equal(sold.sales.length, 1);
  assert.equal(sold.globalSales.length, 1);
  assert.equal(sold.stockEntries.length, 0);
  assert.equal(sold.globalStockEntries.length, 0);
  assert.equal(sold.sales[0]?.totalCost, 0);
  assert.equal(sold.sales[0]?.baseCost, 0);
  assert.deepEqual(sold.sales[0]?.stockDebited, []);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 200);
});

test('draft add/finalize in infinite stock mode accepts missing ingredient recipe and does not debit stock', () => {
  const base = createBaseState();
  const state: FrontAppState = {
    ...base,
    products: base.products.map((product) =>
      product.id === 'p-burger'
        ? {
            ...product,
            recipe: [{ ingredientId: 'i-missing', quantity: 1 }],
          }
        : product
    ),
    businessSettings: {
      infiniteStockEnabled: true,
      ignoreStockCosts: false,
    },
  };

  const withDraft = applyStateCommand(state, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-inf-001',
  });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-inf-001',
    productId: 'p-burger',
  });
  const paid = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID',
    draftId: 'draft-inf-001',
    paymentMethod: 'PIX',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.saleDrafts?.[0]?.stockDebited, true);
  assert.equal(paid.sales.length, 1);
  assert.equal(paid.stockEntries.length, 0);
  assert.equal(paid.globalStockEntries.length, 0);
  assert.equal(paid.sales[0]?.totalCost, 0);
  assert.equal(paid.sales[0]?.baseCost, 0);
  assert.deepEqual(paid.sales[0]?.stockDebited, []);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 200);
});

test('draft flow keeps stock unchanged until payment confirmation', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-001',
    customerType: 'BALCAO',
  });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-001',
    productId: 'p-burger',
    quantity: 2,
  });
  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-001',
    paymentMethod: 'PIX',
  });

  assert.equal(pending.saleDrafts?.length, 1);
  assert.equal(pending.saleDrafts?.[0]?.status, 'PENDING_PAYMENT');
  assert.equal(pending.saleDrafts?.[0]?.total, 40);
  assert.equal(pending.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(pending.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
  assert.equal(pending.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 200);
  assert.equal(pending.sales.length, 0);
  assert.equal(pending.stockEntries.length, 0);

  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-001',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.saleDrafts?.[0]?.stockDebited, true);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 48);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 38);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 160);
  assert.equal(paid.sales.length, 1);
  assert.equal(paid.stockEntries.length, 3);
});

test('draft add item auto-creates missing draft and keeps stock untouched before payment', () => {
  const base = createBaseState();
  const withItem = applyStateCommand(base, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-fast-first-item',
    productId: 'p-burger',
    quantity: 1,
  });

  assert.equal(withItem.saleDrafts?.length, 1);
  assert.equal(withItem.saleDrafts?.[0]?.id, 'draft-fast-first-item');
  assert.equal(withItem.saleDrafts?.[0]?.status, 'DRAFT');
  assert.equal(withItem.saleDrafts?.[0]?.items.length, 1);
  assert.equal(withItem.saleDrafts?.[0]?.total, 20);
  assert.equal(withItem.sales.length, 0);
  assert.equal(withItem.stockEntries.length, 0);
  assert.equal(withItem.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(withItem.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
});

test('draft confirm paid is idempotent and does not double debit stock', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-idem' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-idem',
    productId: 'p-burger',
  });
  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-idem',
    paymentMethod: 'PIX',
  });
  const firstPaid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-idem',
  });
  const retriedPaid = applyStateCommand(firstPaid, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-idem',
  });

  assert.equal(retriedPaid.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(retriedPaid.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(retriedPaid.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 180);
  assert.equal(retriedPaid.sales.length, 1);
  assert.equal(retriedPaid.stockEntries.length, 3);
});

test('draft finalize and confirm paid command commits atomically', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-atomic' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-atomic',
    productId: 'p-burger',
    quantity: 2,
  });
  const paid = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID',
    draftId: 'draft-atomic',
    paymentMethod: 'PIX',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.saleDrafts?.[0]?.stockDebited, true);
  assert.equal(paid.sales.length, 1);
  assert.equal(paid.stockEntries.length, 3);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 48);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 38);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 160);
});

test('draft finalize is idempotent after payment and does not reopen paid draft', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-finalize-idem' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-finalize-idem',
    productId: 'p-burger',
  });
  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-finalize-idem',
    paymentMethod: 'PIX',
  });
  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-finalize-idem',
  });
  const retriedFinalize = applyStateCommand(paid, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-finalize-idem',
    paymentMethod: 'PIX',
  });

  assert.equal(retriedFinalize.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(retriedFinalize.sales.length, 1);
  assert.equal(retriedFinalize.stockEntries.length, 3);
  assert.equal(retriedFinalize.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(retriedFinalize.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(retriedFinalize.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 180);
});

test('legacy draft without payment does not crash command pipeline', () => {
  const base = createBaseState();
  const legacyState = {
    ...base,
    saleDrafts: [
      {
        id: 'legacy-draft-001',
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
        items: [],
        total: 0,
        status: 'DRAFT',
        stockDebited: false,
      },
    ],
  } as unknown as FrontAppState;

  const next = applyStateCommand(legacyState, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'legacy-draft-001',
    productId: 'p-burger',
  });

  assert.equal(next.saleDrafts?.[0]?.items.length, 1);
  assert.equal(next.saleDrafts?.[0]?.payment.method, null);
  assert.equal(next.saleDrafts?.[0]?.status, 'DRAFT');
});

test('draft cancel in DRAFT and PENDING_PAYMENT does not touch stock', () => {
  const base = createBaseState();
  const draft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-cancel-a' });
  const draftWithItem = applyStateCommand(draft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-cancel-a',
    productId: 'p-burger',
  });
  const draftCancelled = applyStateCommand(draftWithItem, {
    type: 'SALE_DRAFT_CANCEL',
    draftId: 'draft-cancel-a',
  });

  assert.equal(draftCancelled.saleDrafts?.[0]?.status, 'CANCELLED');
  assert.equal(draftCancelled.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(draftCancelled.sales.length, 0);

  const pending = applyStateCommand(draftWithItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-cancel-a',
    paymentMethod: 'DEBITO',
  });
  const pendingCancelled = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CANCEL',
    draftId: 'draft-cancel-a',
  });

  assert.equal(pendingCancelled.saleDrafts?.[0]?.status, 'CANCELLED');
  assert.equal(pendingCancelled.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(pendingCancelled.stockEntries.length, 0);
});

test('draft cash payment computes change and blocks insufficient cash on confirm', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-cash' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-cash',
    productId: 'p-burger',
  });

  const pendingInsufficient = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-cash',
    paymentMethod: 'DINHEIRO',
    cashReceived: 10,
  });

  assert.equal(pendingInsufficient.saleDrafts?.[0]?.payment.change, -10);
  assert.throws(
    () =>
      applyStateCommand(pendingInsufficient, {
        type: 'SALE_DRAFT_CONFIRM_PAID',
        draftId: 'draft-cash',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );

  const pendingSufficient = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-cash',
    paymentMethod: 'DINHEIRO',
    cashReceived: 25,
  });
  const paid = applyStateCommand(pendingSufficient, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-cash',
  });

  assert.equal(paid.saleDrafts?.[0]?.payment.change, 5);
  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
});

test('draft divided payment by people confirms with independent methods', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-split-people' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-split-people',
    productId: 'p-burger',
    quantity: 2,
  });

  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-split-people',
    paymentMethod: 'DIVIDIDO',
    splitMode: 'PEOPLE',
    splitCount: 2,
    splitPayments: [
      { method: 'PIX', amount: 20, sequence: 1 },
      { method: 'DEBITO', amount: 20, sequence: 2 },
    ],
  });

  assert.equal(pending.saleDrafts?.[0]?.payment.method, 'DIVIDIDO');
  assert.equal(pending.saleDrafts?.[0]?.payment.splitMode, 'PEOPLE');
  assert.equal(pending.saleDrafts?.[0]?.payment.splitCount, 2);
  assert.equal(pending.saleDrafts?.[0]?.payment.splitPayments?.length, 2);

  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-split-people',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.sales.length, 1);
  assert.equal(paid.sales[0]?.payment?.method, 'DIVIDIDO');
  assert.equal(paid.sales[0]?.payment?.splitPayments?.length, 2);
});

test('draft divided mixed payment computes cash totals from partial cash parcel', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-split-mixed' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-split-mixed',
    productId: 'p-burger',
  });

  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-split-mixed',
    paymentMethod: 'DIVIDIDO',
    splitMode: 'MIXED',
    splitCount: 1,
    splitPayments: [
      { method: 'PIX', amount: 10, sequence: 1 },
      { method: 'DINHEIRO', amount: 10, cashReceived: 12, sequence: 2 },
    ],
  });

  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-split-mixed',
  });

  const draftPayment = paid.saleDrafts?.[0]?.payment;
  assert.equal(draftPayment?.method, 'DIVIDIDO');
  assert.equal(draftPayment?.cashReceived, 12);
  assert.equal(draftPayment?.change, 2);
  assert.equal(draftPayment?.splitPayments?.[1]?.change, 2);
});

test('draft divided payment rejects mismatched split totals', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-split-invalid-total' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-split-invalid-total',
    productId: 'p-burger',
  });

  assert.throws(
    () =>
      applyStateCommand(withItem, {
        type: 'SALE_DRAFT_FINALIZE',
        draftId: 'draft-split-invalid-total',
        paymentMethod: 'DIVIDIDO',
        splitMode: 'MIXED',
        splitCount: 1,
        splitPayments: [
          { method: 'PIX', amount: 6, sequence: 1 },
          { method: 'DEBITO', amount: 6, sequence: 2 },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});

test('draft divided payment confirm revalidates tampered cash parcel', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-split-tamper' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-split-tamper',
    productId: 'p-burger',
  });
  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-split-tamper',
    paymentMethod: 'DIVIDIDO',
    splitMode: 'MIXED',
    splitCount: 1,
    splitPayments: [
      { method: 'DINHEIRO', amount: 10, cashReceived: 10, sequence: 1 },
      { method: 'PIX', amount: 10, sequence: 2 },
    ],
  });

  const tampered = {
    ...pending,
    saleDrafts: pending.saleDrafts?.map((draft) =>
      draft.id === 'draft-split-tamper'
        ? {
            ...draft,
            payment: {
              ...draft.payment,
              splitPayments: (draft.payment.splitPayments || []).map((split, index) =>
                index === 0 ? { ...split, cashReceived: 5 } : split
              ),
            },
          }
        : draft
    ),
  } as FrontAppState;

  assert.throws(
    () =>
      applyStateCommand(tampered, {
        type: 'SALE_DRAFT_CONFIRM_PAID',
        draftId: 'draft-split-tamper',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test('draft app sale keeps channel metadata and applies real app amount to revenue', () => {
  const base = createBaseState();
  const withSecondProduct: FrontAppState = {
    ...base,
    products: [
      ...base.products,
      {
        id: 'p-sauce-shot',
        name: 'Molho Extra',
        price: 6,
        imageUrl: 'https://example.com/sauce.jpg',
        category: 'Side',
        recipe: [{ ingredientId: 'i-sauce', quantity: 10 }],
      },
    ],
  };

  const withDraft = applyStateCommand(withSecondProduct, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-app-001',
  });
  const withBurger = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-app-001',
    productId: 'p-burger',
  });
  const withSauce = applyStateCommand(withBurger, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-app-001',
    productId: 'p-sauce-shot',
  });
  const pending = applyStateCommand(withSauce, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-app-001',
    paymentMethod: 'PIX',
    saleOrigin: 'IFOOD',
    appOrderTotal: 30,
  });
  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-app-001',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.saleDrafts?.[0]?.saleOrigin, 'IFOOD');
  assert.equal(paid.saleDrafts?.[0]?.appOrderTotal, 30);
  assert.equal(paid.sales.length, 2);
  assert.equal(
    paid.sales.every((sale) => sale.saleOrigin === 'IFOOD'),
    true
  );
  assert.equal(
    paid.sales.every((sale) => sale.appOrderTotal === 30),
    true
  );
  assert.equal(
    Number(paid.sales.reduce((sum, sale) => sum + sale.total, 0).toFixed(2)),
    30
  );
});

test('draft app sale with KEETA keeps channel metadata and applies real app amount to revenue', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-app-keeta-001',
  });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-app-keeta-001',
    productId: 'p-burger',
  });
  const pending = applyStateCommand(withItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-app-keeta-001',
    paymentMethod: 'PIX',
    saleOrigin: 'KEETA',
    appOrderTotal: 18,
  });
  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-app-keeta-001',
  });

  assert.equal(paid.saleDrafts?.[0]?.status, 'PAID');
  assert.equal(paid.saleDrafts?.[0]?.saleOrigin, 'KEETA');
  assert.equal(paid.saleDrafts?.[0]?.appOrderTotal, 18);
  assert.equal(paid.sales.length, 1);
  assert.equal(paid.sales.every((sale) => sale.saleOrigin === 'KEETA'), true);
  assert.equal(paid.sales.every((sale) => sale.appOrderTotal === 18), true);
  assert.equal(Number(paid.sales.reduce((sum, sale) => sum + sale.total, 0).toFixed(2)), 18);
});

test('draft app sale blocks invalid app amount on finalize', () => {
  const base = createBaseState();
  const withDraft = applyStateCommand(base, { type: 'SALE_DRAFT_CREATE', draftId: 'draft-app-err' });
  const withItem = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-app-err',
    productId: 'p-burger',
  });

  assert.throws(
    () =>
      applyStateCommand(withItem, {
        type: 'SALE_DRAFT_FINALIZE',
        draftId: 'draft-app-err',
        paymentMethod: 'PIX',
        saleOrigin: 'APP99',
        appOrderTotal: 0,
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});

test('multiple open drafts can coexist while one is pending payment', () => {
  const base = createBaseState();
  const draftDelivery = applyStateCommand(base, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-entrega',
    customerType: 'ENTREGA',
  });
  const draftDeliveryItem = applyStateCommand(draftDelivery, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-entrega',
    productId: 'p-burger',
  });
  const pendingDelivery = applyStateCommand(draftDeliveryItem, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-entrega',
    paymentMethod: 'PIX',
  });

  const withCounterDraft = applyStateCommand(pendingDelivery, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-balcao',
    customerType: 'BALCAO',
  });
  const withCounterItem = applyStateCommand(withCounterDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-balcao',
    productId: 'p-burger',
  });

  assert.equal(withCounterItem.saleDrafts?.length, 2);
  assert.equal(
    withCounterItem.saleDrafts?.find((entry) => entry.id === 'draft-entrega')?.status,
    'PENDING_PAYMENT'
  );
  assert.equal(withCounterItem.saleDrafts?.find((entry) => entry.id === 'draft-balcao')?.status, 'DRAFT');
});

test('undo last sale reverts all paid items from the same cart draft', () => {
  const base = createBaseState();
  const withExtraProduct: FrontAppState = {
    ...base,
    products: [
      ...base.products,
      {
        id: 'p-sauce-shot',
        name: 'Molho Extra',
        price: 6,
        imageUrl: 'https://example.com/sauce.jpg',
        category: 'Side',
        recipe: [{ ingredientId: 'i-sauce', quantity: 10 }],
      },
    ],
  };

  const withDraft = applyStateCommand(withExtraProduct, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-undo-group',
  });
  const withBurger = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-undo-group',
    productId: 'p-burger',
  });
  const withSauce = applyStateCommand(withBurger, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-undo-group',
    productId: 'p-sauce-shot',
  });
  const pending = applyStateCommand(withSauce, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-undo-group',
    paymentMethod: 'PIX',
  });
  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-undo-group',
  });

  assert.equal(paid.sales.length, 2);
  assert.equal(new Set(paid.sales.map((sale) => sale.saleDraftId)).size, 1);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(paid.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 170);

  const undone = applyStateCommand(paid, {
    type: 'SALE_UNDO_LAST',
  });

  assert.equal(undone.sales.length, 0);
  assert.equal(undone.globalSales.length, 0);
  assert.equal(undone.stockEntries.length, 0);
  assert.equal(undone.globalCancelledSales.length, 2);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 40);
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 200);
});

test('sale register treats kg recipe quantity as grams for stock and cost', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 40 },
    ],
    products: [
      {
        id: 'p-bacon-burger',
        name: 'Bacon Burger',
        price: 25,
        imageUrl: 'https://example.com/bacon-burger.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 30 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-bacon-burger',
  });

  const bacon = sold.ingredients.find((entry) => entry.id === 'i-bacon');
  assert.ok(bacon);
  assert.equal(Number((bacon.currentStock).toFixed(3)), 7.97);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 1.2);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(3)), -0.03);
});

test('sale register with 20g from 8kg leaves 7.98kg and computes cost correctly', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 40 },
    ],
    products: [
      {
        id: 'p-bacon-light',
        name: 'Bacon Light',
        price: 25,
        imageUrl: 'https://example.com/bacon-light.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 20 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-bacon-light',
  });

  const bacon = sold.ingredients.find((entry) => entry.id === 'i-bacon');
  assert.ok(bacon);
  assert.equal(Number((bacon.currentStock).toFixed(2)), 7.98);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.8);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -0.02);
});

test('sale register converts legacy unit label "Quilo (kg)" as kg to grams', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'Quilo (kg)', currentStock: 8, minStock: 1, cost: 40 },
    ],
    products: [
      {
        id: 'p-bacon-legacy-label',
        name: 'Bacon Legacy Label',
        price: 25,
        imageUrl: 'https://example.com/bacon-legacy-label.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 10 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-bacon-legacy-label',
  });

  const bacon = sold.ingredients.find((entry) => entry.id === 'i-bacon');
  assert.ok(bacon);
  assert.equal(Number((bacon.currentStock).toFixed(2)), 7.99);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -0.01);
});

test('sale register treats liter recipe quantity as milliliters for stock and cost', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-syrup', name: 'Xarope', unit: 'l', currentStock: 4, minStock: 1, cost: 12 },
    ],
    products: [
      {
        id: 'p-soda',
        name: 'Refrigerante Especial',
        price: 14,
        imageUrl: 'https://example.com/soda.jpg',
        category: 'Drink',
        recipe: [{ ingredientId: 'i-syrup', quantity: 150 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-soda',
  });

  const syrup = sold.ingredients.find((entry) => entry.id === 'i-syrup');
  assert.ok(syrup);
  assert.equal(Number((syrup.currentStock).toFixed(2)), 3.85);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 1.8);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -0.15);
});

test('manual stock move accepts decimal amounts for kg without truncation', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 40 },
    ],
    products: [],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const moved = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-bacon',
    amount: -0.02,
  });

  const bacon = moved.ingredients.find((entry) => entry.id === 'i-bacon');
  assert.ok(bacon);
  assert.equal(Number((bacon.currentStock).toFixed(2)), 7.98);
  assert.equal(Number((moved.stockEntries[0]?.quantity || 0).toFixed(2)), -0.02);
});

test('sale register with unit "un" debits one unit and applies exact unit cost', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-box', name: 'Caixa 25cm', unit: 'un', currentStock: 150, minStock: 10, cost: 0.99 },
    ],
    products: [
      {
        id: 'p-box',
        name: 'Produto Caixa',
        price: 10,
        imageUrl: 'https://example.com/box.jpg',
        category: 'Side',
        recipe: [{ ingredientId: 'i-box', quantity: 1 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-box',
  });

  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-box')?.currentStock, 149);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.99);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -1);
});

test('sale undo by id restores only selected sale and keeps other sales intact', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-box', name: 'Caixa 25cm', unit: 'un', currentStock: 100, minStock: 10, cost: 1 },
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 10 },
    ],
    products: [
      {
        id: 'p-box',
        name: 'Produto Caixa',
        price: 12,
        imageUrl: 'https://example.com/box.jpg',
        category: 'Side',
        recipe: [{ ingredientId: 'i-box', quantity: 1 }],
      },
      {
        id: 'p-bacon-10g',
        name: 'Bacon 10g',
        price: 16,
        imageUrl: 'https://example.com/bacon.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 10 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const first = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-box',
    clientSaleId: 'sale-box-001',
  });
  const second = applyStateCommand(first, {
    type: 'SALE_REGISTER',
    productId: 'p-bacon-10g',
    clientSaleId: 'sale-bacon-001',
  });

  const undone = applyStateCommand(second, {
    type: 'SALE_UNDO_BY_ID',
    saleId: 'sale-box-001',
  });

  assert.equal(undone.sales.length, 1);
  assert.equal(undone.sales[0]?.id, 'sale-bacon-001');
  assert.equal(undone.globalSales.length, 1);
  assert.equal(undone.globalSales[0]?.id, 'sale-bacon-001');
  assert.equal(undone.globalCancelledSales.length, 1);
  assert.equal(undone.globalCancelledSales[0]?.id, 'sale-box-001');
  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-box')?.currentStock, 100);
  assert.equal(Number((undone.ingredients.find((entry) => entry.id === 'i-bacon')?.currentStock || 0).toFixed(3)), 7.99);
  assert.equal(
    undone.stockEntries.some((entry) => entry.saleId === 'sale-box-001'),
    false
  );
  assert.equal(
    undone.stockEntries.some((entry) => entry.saleId === 'sale-bacon-001'),
    true
  );
});

test('sale undo by id returns 404 when sale does not exist in session history', () => {
  const state = createBaseState();

  assert.throws(
    () =>
      applyStateCommand(state, {
        type: 'SALE_UNDO_BY_ID',
        saleId: 'sale-missing',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
});

test('sale edit by id updates paid order payment and total without touching stock', () => {
  const base = createBaseState();
  const withExtraProduct: FrontAppState = {
    ...base,
    products: [
      ...base.products,
      {
        id: 'p-sauce-shot',
        name: 'Molho Extra',
        price: 6,
        imageUrl: 'https://example.com/sauce.jpg',
        category: 'Side',
        recipe: [{ ingredientId: 'i-sauce', quantity: 10 }],
      },
    ],
  };

  const withDraft = applyStateCommand(withExtraProduct, {
    type: 'SALE_DRAFT_CREATE',
    draftId: 'draft-edit-order',
  });
  const withBurger = applyStateCommand(withDraft, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-edit-order',
    productId: 'p-burger',
  });
  const withSauce = applyStateCommand(withBurger, {
    type: 'SALE_DRAFT_ADD_ITEM',
    draftId: 'draft-edit-order',
    productId: 'p-sauce-shot',
  });
  const pending = applyStateCommand(withSauce, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: 'draft-edit-order',
    paymentMethod: 'PIX',
  });
  const paid = applyStateCommand(pending, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: 'draft-edit-order',
  });

  const targetSaleId = paid.sales[0]?.id;
  assert.ok(targetSaleId);

  const edited = applyStateCommand(paid, {
    type: 'SALE_EDIT_BY_ID',
    saleId: targetSaleId as string,
    paymentMethod: 'DINHEIRO',
    cashReceived: 30,
    orderTotal: 24,
  });

  assert.equal(edited.sales.length, 2);
  assert.equal(edited.globalSales.length, 2);
  assert.equal(edited.stockEntries.length, paid.stockEntries.length);
  assert.equal(edited.globalStockEntries.length, paid.globalStockEntries.length);
  assert.equal(edited.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(edited.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
  assert.equal(edited.ingredients.find((entry) => entry.id === 'i-sauce')?.currentStock, 170);
  assert.equal(
    Number(edited.sales.reduce((sum, sale) => sum + sale.total, 0).toFixed(2)),
    24
  );
  assert.equal(
    Number(edited.globalSales.reduce((sum, sale) => sum + sale.total, 0).toFixed(2)),
    24
  );
  assert.equal(
    edited.sales.every(
      (sale) => sale.payment?.method === 'DINHEIRO' && sale.payment?.cashReceived === 30 && sale.payment?.change === 6
    ),
    true
  );

  const editedDraft = edited.saleDrafts?.find((draft) => draft.id === 'draft-edit-order');
  assert.ok(editedDraft);
  assert.equal(editedDraft?.status, 'PAID');
  assert.equal(editedDraft?.total, 24);
  assert.equal(editedDraft?.payment.method, 'DINHEIRO');
  assert.equal(editedDraft?.payment.cashReceived, 30);
  assert.equal(editedDraft?.payment.change, 6);
  assert.equal(
    Number(
      (editedDraft?.items || []).reduce((sum, item) => {
        const unitPrice = Number(item.unitPriceSnapshot) || 0;
        return sum + unitPrice * item.qty;
      }, 0).toFixed(2)
    ),
    24
  );
});

test('sale edit by id requires cash amount when switching payment to dinheiro', () => {
  const sold = applyStateCommand(createBaseState(), {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });
  const saleId = sold.sales[0]?.id;
  assert.ok(saleId);

  assert.throws(
    () =>
      applyStateCommand(sold, {
        type: 'SALE_EDIT_BY_ID',
        saleId: saleId as string,
        paymentMethod: 'DINHEIRO',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 422);
      return true;
    }
  );
});

test('sale register with unit "g" keeps gram arithmetic for stock and cost', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-salt', name: 'Sal', unit: 'g', currentStock: 1000, minStock: 100, cost: 0.01 },
    ],
    products: [
      {
        id: 'p-salted',
        name: 'Produto Salgado',
        price: 15,
        imageUrl: 'https://example.com/salted.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-salt', quantity: 30 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-salted',
  });

  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-salt')?.currentStock, 970);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.30);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -30);
});

test('sale register with 10g from ingredient in kg applies fractional kg cost correctly', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 1 },
    ],
    products: [
      {
        id: 'p-bacon-10g',
        name: 'Bacon 10g',
        price: 14,
        imageUrl: 'https://example.com/bacon-10g.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 10 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-bacon-10g',
  });

  assert.equal(Number((sold.ingredients.find((entry) => entry.id === 'i-bacon')?.currentStock || 0).toFixed(3)), 7.99);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.01);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(3)), -0.01);
});

test('sale register with 300ml from ingredient in l applies liter conversion and cost correctly', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-syrup', name: 'Xarope', unit: 'l', currentStock: 8, minStock: 1, cost: 1 },
    ],
    products: [
      {
        id: 'p-syrup-300ml',
        name: 'Xarope 300ml',
        price: 12,
        imageUrl: 'https://example.com/syrup-300ml.jpg',
        category: 'Drink',
        recipe: [{ ingredientId: 'i-syrup', quantity: 300 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-syrup-300ml',
  });

  assert.equal(Number((sold.ingredients.find((entry) => entry.id === 'i-syrup')?.currentStock || 0).toFixed(3)), 7.7);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.30);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(3)), -0.3);
});

test('sale register with unit "ml" uses direct ml arithmetic without conversion', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-essence', name: 'Essencia', unit: 'ml', currentStock: 1000, minStock: 100, cost: 0.01 },
    ],
    products: [
      {
        id: 'p-essence',
        name: 'Essencia Drink',
        price: 9,
        imageUrl: 'https://example.com/essence.jpg',
        category: 'Drink',
        recipe: [{ ingredientId: 'i-essence', quantity: 50 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-essence',
  });

  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-essence')?.currentStock, 950);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 0.50);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -50);
});

test('sale register with custom unit keeps direct quantity arithmetic', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-cheese-slice', name: 'Queijo', unit: 'fatias', currentStock: 120, minStock: 20, cost: 0.4 },
    ],
    products: [
      {
        id: 'p-cheese',
        name: 'Cheese Burger',
        price: 18,
        imageUrl: 'https://example.com/cheese.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-cheese-slice', quantity: 3 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-cheese',
  });

  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-cheese-slice')?.currentStock, 117);
  assert.equal(Number((sold.sales[0]?.totalCost || 0).toFixed(2)), 1.20);
  assert.equal(Number((sold.stockEntries[0]?.quantity || 0).toFixed(2)), -3);
});

test('sale register blocks when requested grams exceed available kg stock', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 8, minStock: 1, cost: 20 },
    ],
    products: [
      {
        id: 'p-bacon-over',
        name: 'Bacon Over',
        price: 30,
        imageUrl: 'https://example.com/bacon-over.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 9000 }],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  assert.throws(
    () =>
      applyStateCommand(state, {
        type: 'SALE_REGISTER',
        productId: 'p-bacon-over',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test('sale register with price override keeps discount and stock/cost consistency', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bread', name: 'Pao', unit: 'un', currentStock: 50, minStock: 10, cost: 1.5 },
      { id: 'i-meat', name: 'Carne', unit: 'un', currentStock: 40, minStock: 8, cost: 4.2 },
    ],
    products: [
      {
        id: 'p-burger-discount',
        name: 'Burger Desconto',
        price: 20,
        imageUrl: 'https://example.com/burger-discount.jpg',
        category: 'Snack',
        recipe: [
          { ingredientId: 'i-bread', quantity: 1 },
          { ingredientId: 'i-meat', quantity: 1 },
        ],
      },
    ],
    sales: [],
    stockEntries: [],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [],
    globalCancelledSales: [],
    globalStockEntries: [],
    globalCleaningStockEntries: [],
  };

  const sold = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-burger-discount',
    priceOverride: 18,
  });

  const sale = sold.sales[0];
  assert.ok(sale);
  assert.equal(sale.total, 18);
  assert.equal(sale.basePrice, 20);
  assert.equal(sale.priceAdjustment, -2);
  assert.equal(Number((sale.totalCost || 0).toFixed(2)), 5.7);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 49);
  assert.equal(sold.ingredients.find((entry) => entry.id === 'i-meat')?.currentStock, 39);
});

test('undo last sale restores legacy kg stock using recorded stock entries', () => {
  const state: FrontAppState = {
    ingredients: [
      { id: 'i-bacon', name: 'Bacon', unit: 'kg', currentStock: 7, minStock: 1, cost: 40 },
    ],
    products: [
      {
        id: 'p-bacon-burger',
        name: 'Bacon Burger',
        price: 25,
        imageUrl: 'https://example.com/bacon-burger.jpg',
        category: 'Snack',
        recipe: [{ ingredientId: 'i-bacon', quantity: 1 }],
      },
    ],
    sales: [
      {
        id: 'legacy-sale-kg',
        productId: 'p-bacon-burger',
        productName: 'Bacon Burger',
        timestamp: new Date().toISOString(),
        total: 25,
        totalCost: 40,
        recipe: [{ ingredientId: 'i-bacon', quantity: 1 }],
        stockDebited: [{ ingredientId: 'i-bacon', quantity: 1 }],
      },
    ],
    stockEntries: [
      {
        id: 'st-sale-legacy-sale-kg-i-bacon',
        ingredientId: 'i-bacon',
        ingredientName: 'Bacon',
        quantity: -1,
        unitCost: 40,
        timestamp: new Date().toISOString(),
        source: 'SALE',
        saleId: 'legacy-sale-kg',
      },
    ],
    cleaningMaterials: [],
    cleaningStockEntries: [],
    globalSales: [
      {
        id: 'legacy-sale-kg',
        productId: 'p-bacon-burger',
        productName: 'Bacon Burger',
        timestamp: new Date().toISOString(),
        total: 25,
        totalCost: 40,
        recipe: [{ ingredientId: 'i-bacon', quantity: 1 }],
        stockDebited: [{ ingredientId: 'i-bacon', quantity: 1 }],
      },
    ],
    globalCancelledSales: [],
    globalStockEntries: [
      {
        id: 'st-sale-legacy-sale-kg-i-bacon',
        ingredientId: 'i-bacon',
        ingredientName: 'Bacon',
        quantity: -1,
        unitCost: 40,
        timestamp: new Date().toISOString(),
        source: 'SALE',
        saleId: 'legacy-sale-kg',
      },
    ],
    globalCleaningStockEntries: [],
  };

  const undone = applyStateCommand(state, {
    type: 'SALE_UNDO_LAST',
  });

  assert.equal(undone.ingredients.find((entry) => entry.id === 'i-bacon')?.currentStock, 8);
  assert.equal(undone.sales.length, 0);
  assert.equal(undone.stockEntries.length, 0);
});

test('deleting ingredient updates products recipes without touching unrelated data', () => {
  const base = createBaseState();
  const next = applyStateCommand(base, {
    type: 'INGREDIENT_DELETE',
    ingredientId: 'i-sauce',
  });

  assert.equal(next.ingredients.some((entry) => entry.id === 'i-sauce'), false);
  assert.equal(next.products.length, 1);
  assert.deepEqual(next.products[0].recipe.map((entry) => entry.ingredientId), ['i-bread', 'i-meat']);
});

test('product create normalizes duplicated recipe items by ingredient', () => {
  const base = createBaseState();
  const next = applyStateCommand(base, {
    type: 'PRODUCT_CREATE',
    product: {
      id: 'p-dup-recipe',
      name: 'Produto Duplicado',
      price: 10,
      imageUrl: 'https://example.com/p-dup-recipe.jpg',
      category: 'Snack',
      recipe: [
        { ingredientId: 'i-sauce', quantity: 10 },
        { ingredientId: 'i-sauce', quantity: 5 },
        { ingredientId: 'i-bread', quantity: 1 },
      ],
    },
  });

  const created = next.products.find((entry) => entry.id === 'p-dup-recipe');
  assert.ok(created);
  assert.equal(created.recipe.length, 2);
  assert.equal(created.recipe.find((item) => item.ingredientId === 'i-sauce')?.quantity, 15);
  assert.equal(created.recipe.find((item) => item.ingredientId === 'i-bread')?.quantity, 1);
});

test('set cash register stores sanitized amount in state', () => {
  const base = createBaseState();
  const next = applyStateCommand(base, {
    type: 'SET_CASH_REGISTER',
    amount: 157.9,
  });

  assert.equal(next.cashRegisterAmount, 157.9);
  assert.equal(base.cashRegisterAmount, undefined);
});

test('ingredient stock move can debit purchase from cash register', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 50,
  });

  const next = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-bread',
    amount: 2,
    useCashRegister: true,
    purchaseDescription: 'Compra de pão da manhã',
  });

  assert.equal(next.cashRegisterAmount, 47);
  assert.equal(next.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 52);
  assert.equal(next.stockEntries.length, 1);
  assert.equal(next.stockEntries[0]?.paidWithCashRegister, true);
  assert.equal(next.stockEntries[0]?.cashRegisterImpact, -3);
  assert.equal(next.stockEntries[0]?.purchaseDescription, 'Compra de pão da manhã');
});

test('ingredient stock move with cash register blocks when cash is insufficient', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 1,
  });

  assert.throws(
    () =>
      applyStateCommand(state, {
        type: 'INGREDIENT_STOCK_MOVE',
        ingredientId: 'i-bread',
        amount: 2,
        useCashRegister: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test('cash expense can debit cash register without stock move', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 30,
  });

  const next = applyStateCommand(state, {
    type: 'CASH_EXPENSE',
    amount: 7.5,
    purchaseDescription: 'Compra de gás',
  });

  assert.equal(next.cashRegisterAmount, 22.5);
  assert.equal(next.stockEntries.length, 1);
  assert.equal(next.stockEntries[0]?.ingredientName, 'OUTROS');
  assert.equal(next.stockEntries[0]?.quantity, 0);
  assert.equal(next.stockEntries[0]?.cashRegisterImpact, -7.5);
  assert.equal(next.stockEntries[0]?.purchaseDescription, 'Compra de gás');
});

test('cash expense blocks when cash register is insufficient', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 2,
  });

  assert.throws(
    () =>
      applyStateCommand(state, {
        type: 'CASH_EXPENSE',
        amount: 3,
        purchaseDescription: 'Compra extra',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test('cash expense revert restores cash and removes withdrawal entry', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 30,
  });
  state = applyStateCommand(state, {
    type: 'CASH_EXPENSE',
    amount: 7.5,
    purchaseDescription: 'Compra de gás',
  });

  const entryId = state.stockEntries[0]?.id;
  assert.ok(entryId);

  const next = applyStateCommand(state, {
    type: 'CASH_EXPENSE_REVERT',
    entryId,
  });

  assert.equal(next.cashRegisterAmount, 30);
  assert.equal(next.stockEntries.length, 0);
  assert.equal(next.globalStockEntries.length, 0);
});

test('cash expense revert also rolls back ingredient stock purchase paid with cash register', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 50,
  });
  state = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-bread',
    amount: 2,
    useCashRegister: true,
    purchaseDescription: 'Compra de pão',
  });

  const entryId = state.stockEntries[0]?.id;
  assert.ok(entryId);

  const next = applyStateCommand(state, {
    type: 'CASH_EXPENSE_REVERT',
    entryId,
  });

  assert.equal(next.cashRegisterAmount, 50);
  assert.equal(next.ingredients.find((entry) => entry.id === 'i-bread')?.currentStock, 50);
  assert.equal(next.stockEntries.length, 0);
});

test('cash expense revert blocks when ingredient stock is no longer available to rollback', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 50,
  });
  state = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-bread',
    amount: 2,
    useCashRegister: true,
    purchaseDescription: 'Compra de pão',
  });
  state = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-bread',
    amount: -52,
  });

  const entryId = state.stockEntries.find((entry) => Number(entry.cashRegisterImpact) < 0)?.id;
  assert.ok(entryId);

  assert.throws(
    () =>
      applyStateCommand(state, {
        type: 'CASH_EXPENSE_REVERT',
        entryId,
      }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      return true;
    }
  );
});

test('close day snapshots report in history and resets session sales state', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'SET_CASH_REGISTER',
    amount: 100,
  });
  state = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });
  state = applyStateCommand(state, {
    type: 'INGREDIENT_STOCK_MOVE',
    ingredientId: 'i-sauce',
    amount: 10,
    useCashRegister: true,
  });

  const closed = applyStateCommand(state, {
    type: 'CLOSE_DAY',
  });

  assert.equal(closed.sales.length, 0);
  assert.equal(closed.stockEntries.length, 0);
  assert.equal(closed.saleDrafts?.length || 0, 0);
  assert.equal(closed.cashRegisterAmount, 0);
  assert.equal(closed.globalSales.length, 1);
  assert.equal(closed.dailySalesHistory?.length, 1);
  assert.equal(closed.dailySalesHistory?.[0]?.openingCash, 99.8);
  assert.equal(closed.dailySalesHistory?.[0]?.saleCount, 1);
  assert.equal(closed.dailySalesHistory?.[0]?.totalRevenue, 20);
  assert.equal(closed.dailySalesHistory?.[0]?.totalPurchases, 6.1);
  assert.equal(closed.dailySalesHistory?.[0]?.totalProfit, 13.9);
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenses, 0.2);
  assert.match(closed.dailySalesHistory?.[0]?.businessDate || '', /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.length, 1);
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.[0]?.expenseType, 'INGREDIENT');
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.[0]?.ingredientName, 'Molho');
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.[0]?.ingredientUnit, 'g');
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.[0]?.quantity, 10);
  assert.equal(closed.dailySalesHistory?.[0]?.cashExpenseDetails?.[0]?.amount, 0.2);
});

test('start business day anchors close report businessDate and resets after close', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'START_BUSINESS_DAY',
    businessDate: '2026-03-10',
  });
  state = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });

  const closed = applyStateCommand(state, {
    type: 'CLOSE_DAY',
  });

  assert.equal(closed.dailySalesHistory?.length, 1);
  assert.equal(closed.dailySalesHistory?.[0]?.businessDate, '2026-03-10');
  assert.equal(closed.activeBusinessDate, null);
});

test('start business day reuses previous businessDate when reopening within 90 minutes', () => {
  const closedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const state: FrontAppState = {
    ...createBaseState(),
    dailySalesHistory: [
      {
        id: 'day-reopen-window',
        closedAt,
        businessDate: '2026-03-10',
        openingCash: 0,
        totalRevenue: 0,
        totalPurchases: 0,
        totalProfit: 0,
        saleCount: 0,
        cashExpenses: 0,
        cashExpenseDetails: [],
      },
    ],
  };

  const started = applyStateCommand(state, {
    type: 'START_BUSINESS_DAY',
  });

  assert.equal(started.activeBusinessDate, '2026-03-10');
});

test('start business day opens calendar day when last close is older than 90 minutes', () => {
  const closedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const state: FrontAppState = {
    ...createBaseState(),
    dailySalesHistory: [
      {
        id: 'day-reopen-expired',
        closedAt,
        businessDate: '2026-03-10',
        openingCash: 0,
        totalRevenue: 0,
        totalPurchases: 0,
        totalProfit: 0,
        saleCount: 0,
        cashExpenses: 0,
        cashExpenseDetails: [],
      },
    ],
  };

  const started = applyStateCommand(state, {
    type: 'START_BUSINESS_DAY',
  });

  assert.equal(started.activeBusinessDate, toDayKey(new Date()));
});

test('clear active business day removes only the start-day marker', () => {
  let state = createBaseState();
  state = applyStateCommand(state, {
    type: 'START_BUSINESS_DAY',
    businessDate: '2026-03-11',
  });
  state = applyStateCommand(state, {
    type: 'SALE_REGISTER',
    productId: 'p-burger',
  });

  const cleared = applyStateCommand(state, {
    type: 'CLEAR_ACTIVE_BUSINESS_DAY',
  });

  assert.equal(cleared.activeBusinessDate, null);
  assert.equal(cleared.sales.length, 1);
  assert.equal(cleared.globalSales.length, 1);
});

test('stress: repeated mixed operations never produce negative stocks', () => {
  let state = createBaseState();

  let seed = 42;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let index = 0; index < 3000; index += 1) {
    const choice = Math.floor(random() * 5);

    const command =
      choice === 0
        ? ({
            type: 'SALE_REGISTER',
            productId: 'p-burger',
          } as const)
        : choice === 1
          ? ({
              type: 'SALE_UNDO_LAST',
            } as const)
          : choice === 2
            ? ({
                type: 'INGREDIENT_STOCK_MOVE',
                ingredientId: random() > 0.5 ? 'i-bread' : 'i-meat',
                amount: random() > 0.6 ? 1 : -1,
              } as const)
            : choice === 3
              ? ({
                  type: 'CLEANING_STOCK_MOVE',
                  materialId: 'cm-detergent',
                  amount: random() > 0.5 ? 200 : -200,
                } as const)
              : ({
                  type: 'CLEAR_HISTORY',
                } as const);

    try {
      state = applyStateCommand(state, command);
    } catch (error) {
      if (error instanceof HttpError && (error.statusCode === 404 || error.statusCode === 409)) {
        continue;
      }
      throw error;
    }

    state.ingredients.forEach((ingredient) => {
      assert.ok(ingredient.currentStock >= 0, `negative ingredient stock: ${ingredient.id}`);
    });
    state.cleaningMaterials.forEach((material) => {
      assert.ok(material.currentStock >= 0, `negative cleaning stock: ${material.id}`);
    });
  }
});

test('delete archive by ids only removes requested sales', () => {
  let state = createBaseState();
  state = applyStateCommand(state, { type: 'SALE_REGISTER', productId: 'p-burger' });
  state = applyStateCommand(state, { type: 'SALE_REGISTER', productId: 'p-burger' });
  const targetId = state.globalSales[0]?.id;
  assert.ok(targetId);

  const next = applyStateCommand(state, {
    type: 'DELETE_ARCHIVE_SALES',
    saleIds: [targetId as string],
  });

  assert.equal(next.globalSales.some((sale) => sale.id === targetId), false);
  assert.equal(next.sales.length, state.sales.length);
});
