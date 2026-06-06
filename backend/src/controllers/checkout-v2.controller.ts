import type { Request, Response } from 'express';

import { CheckoutV2Service } from '../services/checkout-v2.service.js';
import { HttpError, isHttpError } from '../utils/http-error.js';
import { checkoutV2ConfirmSchema } from '../validators/checkout-v2.validator.js';

const checkoutV2Service = new CheckoutV2Service();

export const checkoutV2Controller = {
  confirm: async (req: Request, res: Response) => {
    const payload = checkoutV2ConfirmSchema.parse(req.body);
    let result;
    try {
      result = await checkoutV2Service.confirm(payload, req.context);
    } catch (error) {
      if (
        isHttpError(error) &&
        error.statusCode === 409 &&
        typeof (error.details as { code?: unknown } | undefined)?.code === 'string'
      ) {
        res.status(409).json(error.details);
        return;
      }
      throw error;
    }

    if (result.code === 'FAST_CHECKOUT_V2_DISABLED') {
      res.status(423).json(result);
      return;
    }

    if (result.code === 'FAST_CHECKOUT_V2_RESERVED_NOT_IMPLEMENTED') {
      res.status(202).json(result);
      return;
    }

    throw new HttpError(500, 'Resposta inesperada do checkout v2.');
  },
};
