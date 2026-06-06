import assert from 'node:assert/strict';
import test from 'node:test';

import { env } from '../config/env.js';
import { checkoutV2Router } from '../routes/checkout-v2.routes.js';
import { CheckoutV2Service } from './checkout-v2.service.js';
import { checkoutV2ConfirmSchema } from '../validators/checkout-v2.validator.js';

const buildValidPayload = () => ({
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
});

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

test('checkout v2 service blocks while feature flag is disabled', async () => {
  await withFastCheckoutFlag(false, async () => {
    const input = checkoutV2ConfirmSchema.parse(buildValidPayload());
    const result = await new CheckoutV2Service().confirm(input);

    assert.deepEqual(result, {
      ok: false,
      code: 'FAST_CHECKOUT_V2_DISABLED',
    });
  });
});

test('checkout v2 service remains not implemented when feature flag is enabled', async () => {
  await withFastCheckoutFlag(true, async () => {
    const input = checkoutV2ConfirmSchema.parse(buildValidPayload());
    const result = await new CheckoutV2Service().confirm(input);

    assert.deepEqual(result, {
      ok: false,
      code: 'FAST_CHECKOUT_V2_NOT_IMPLEMENTED',
    });
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
