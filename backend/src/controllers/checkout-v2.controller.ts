import type { Request, Response } from 'express';

import { CheckoutV2Service } from '../services/checkout-v2.service.js';
import { checkoutV2ConfirmSchema } from '../validators/checkout-v2.validator.js';

const checkoutV2Service = new CheckoutV2Service();

export const checkoutV2Controller = {
  confirm: async (req: Request, res: Response) => {
    const payload = checkoutV2ConfirmSchema.parse(req.body);
    const result = await checkoutV2Service.confirm(payload, req.context);

    if (result.code === 'FAST_CHECKOUT_V2_DISABLED') {
      res.status(423).json(result);
      return;
    }

    res.status(501).json(result);
  },
};
