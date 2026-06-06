import assert from 'node:assert/strict';
import test from 'node:test';

import { env } from '../config/env.js';
import { checkoutV2Router } from '../routes/checkout-v2.routes.js';
import {
  CheckoutV2ConfirmationRecord,
  CheckoutV2ConfirmationStore,
  CheckoutV2Service,
  ReserveCheckoutV2ConfirmationInput,
} from './checkout-v2.service.js';
import { checkoutV2ConfirmSchema } from '../validators/checkout-v2.validator.js';
import { HttpError } from '../utils/http-error.js';

const buildValidPayload = (overrides: Record<string, unknown> = {}) => ({
  draftId: 'draft-fast-checkout-v2-test',
  commandId: 'cmd-fast-checkout-v2-test',
  items: [
    {
      productId: 'product-fast-checkout-v2-test',
      itemId: 'item-fast-checkout-v2-test',
      nameSnapshot: 'X Burger',
      qty: 1,
      unitPrice: 20,
      total: 20,
      recipe: [
        {
          ingredientId: 'ingredient-fast-checkout-v2-test',
          quantity: 1,
        },
      ],
    },
  ],
  paymentMethod: 'PIX',
  total: 20,
  createdAt: new Date('2026-06-06T10:00:00.000Z').toISOString(),
  saleOrigin: 'LOCAL',
  ...overrides,
});

class MemoryCheckoutV2ConfirmationStore implements CheckoutV2ConfirmationStore {
  private readonly rows = new Map<string, CheckoutV2ConfirmationRecord>();
  createCalls = 0;
  saleCreateCalls = 0;
  appStateWriteCalls = 0;

  async create(input: ReserveCheckoutV2ConfirmationInput): Promise<CheckoutV2ConfirmationRecord> {
    this.createCalls += 1;
    const now = new Date('2026-06-06T10:00:00.000Z');
    const row: CheckoutV2ConfirmationRecord = {
      id: `confirmation-${this.createCalls}`,
      draftId: input.draftId,
      commandId: input.commandId,
      saleId: null,
      status: 'RESERVED',
      payloadHash: input.payloadHash,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async findByDraftId(draftId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return [...this.rows.values()].find((row) => row.draftId === draftId) || null;
  }

  async findByCommandId(commandId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return [...this.rows.values()].find((row) => row.commandId === commandId) || null;
  }

  async markFailed(id: string, errorCode: string): Promise<CheckoutV2ConfirmationRecord> {
    const row = this.rows.get(id);
    assert.ok(row);
    const next = {
      ...row,
      status: 'FAILED' as const,
      errorCode,
      updatedAt: new Date('2026-06-06T10:01:00.000Z'),
    };
    this.rows.set(id, next);
    return next;
  }

  async markConfirmed(id: string, saleId: string): Promise<CheckoutV2ConfirmationRecord> {
    const row = this.rows.get(id);
    assert.ok(row);
    const next = {
      ...row,
      status: 'CONFIRMED' as const,
      saleId,
      errorCode: null,
      updatedAt: new Date('2026-06-06T10:02:00.000Z'),
    };
    this.rows.set(id, next);
    return next;
  }
}

const parsePayload = (payload: ReturnType<typeof buildValidPayload>) =>
  checkoutV2ConfirmSchema.parse(payload);

const withFastCheckoutFlag = async <T>(
  enabled: boolean,
  run: () => Promise<T>
): Promise<T> => {
  const previous = env.FAST_CHECKOUT_V2_ENABLED;
  env.FAST_CHECKOUT_V2_ENABLED = enabled;
  try {
    return await run();
  } finally {
    env.FAST_CHECKOUT_V2_ENABLED = previous;
  }
};

test('checkout v2 route is registered for confirm endpoint', () => {
  const hasRoute = checkoutV2Router.stack.some((layer) => {
    const route = layer.route as { path?: string; methods?: Record<string, boolean> } | undefined;
    return route?.path === '/v2/confirm' && route.methods?.post === true;
  });

  assert.equal(hasRoute, true);
});

test('checkout v2 service blocks while feature flag is disabled without reserving', async () => {
  await withFastCheckoutFlag(false, async () => {
    const store = new MemoryCheckoutV2ConfirmationStore();
    const input = parsePayload(buildValidPayload());
    const result = await new CheckoutV2Service(store).confirm(input);

    assert.deepEqual(result, {
      ok: false,
      code: 'FAST_CHECKOUT_V2_DISABLED',
    });
    assert.equal(store.createCalls, 0);
  });
});

test('checkout v2 creates reservation with flag enabled but does not create sale or app_state writes', async () => {
  await withFastCheckoutFlag(true, async () => {
    const store = new MemoryCheckoutV2ConfirmationStore();
    const input = parsePayload(buildValidPayload());
    const result = await new CheckoutV2Service(store).confirm(input);

    assert.deepEqual(result, {
      ok: false,
      code: 'FAST_CHECKOUT_V2_RESERVED_NOT_IMPLEMENTED',
      confirmationId: 'confirmation-1',
    });
    assert.equal(store.createCalls, 1);
    assert.equal(store.saleCreateCalls, 0);
    assert.equal(store.appStateWriteCalls, 0);
  });
});

test('checkout v2 reuses reservation with same draftId and payload hash', async () => {
  await withFastCheckoutFlag(true, async () => {
    const store = new MemoryCheckoutV2ConfirmationStore();
    const service = new CheckoutV2Service(store);
    const input = parsePayload(buildValidPayload());

    const first = await service.confirm(input);
    const second = await service.confirm(input);

    assert.equal(first.code, 'FAST_CHECKOUT_V2_RESERVED_NOT_IMPLEMENTED');
    assert.deepEqual(second, first);
    assert.equal(store.createCalls, 1);
  });
});

test('checkout v2 rejects same draftId with different payload hash', async () => {
  await withFastCheckoutFlag(true, async () => {
    const store = new MemoryCheckoutV2ConfirmationStore();
    const service = new CheckoutV2Service(store);
    const input = parsePayload(buildValidPayload());
    const changed = parsePayload(buildValidPayload({ total: 21 }));

    await service.confirm(input);
    await assert.rejects(
      () => service.confirm(changed),
      (error) =>
        error instanceof HttpError &&
        error.statusCode === 409 &&
        (error.details as { code?: unknown }).code === 'CHECKOUT_V2_IDEMPOTENCY_CONFLICT'
    );
    assert.equal(store.createCalls, 1);
  });
});

test('checkout v2 reuses reservation by commandId when draft matches', async () => {
  await withFastCheckoutFlag(true, async () => {
    const store = new MemoryCheckoutV2ConfirmationStore();
    const service = new CheckoutV2Service(store);
    const input = parsePayload(buildValidPayload());
    const firstReservation = await service.reserveConfirmation(input);

    assert.equal(firstReservation.id, 'confirmation-1');
    const byCommand = await service.findByCommandId(input.commandId);
    assert.equal(byCommand?.id, firstReservation.id);
    const secondReservation = await service.reserveConfirmation(input);
    assert.equal(secondReservation.id, firstReservation.id);
    assert.equal(store.createCalls, 1);
  });
});

test('checkout v2 schema rejects invalid payload before service execution', () => {
  const parsed = checkoutV2ConfirmSchema.safeParse({
    draftId: '',
    commandId: 'cmd-invalid',
    items: [],
    paymentMethod: 'PIX',
    total: 0,
    createdAt: 'not-a-date',
  });

  assert.equal(parsed.success, false);
});
