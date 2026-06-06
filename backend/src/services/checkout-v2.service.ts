import { env } from '../config/env.js';
import type { RequestContext } from '../types/request-context.js';
import type { CheckoutV2ConfirmInput } from '../validators/checkout-v2.validator.js';

export type CheckoutV2DisabledResult = {
  ok: false;
  code: 'FAST_CHECKOUT_V2_DISABLED';
};

export type CheckoutV2NotImplementedResult = {
  ok: false;
  code: 'FAST_CHECKOUT_V2_NOT_IMPLEMENTED';
};

export type CheckoutV2ConfirmResult =
  | CheckoutV2DisabledResult
  | CheckoutV2NotImplementedResult;

export class CheckoutV2Service {
  async confirm(
    _input: CheckoutV2ConfirmInput,
    _context?: RequestContext
  ): Promise<CheckoutV2ConfirmResult> {
    if (!env.FAST_CHECKOUT_V2_ENABLED) {
      return {
        ok: false,
        code: 'FAST_CHECKOUT_V2_DISABLED',
      };
    }

    return {
      ok: false,
      code: 'FAST_CHECKOUT_V2_NOT_IMPLEMENTED',
    };
  }
}
