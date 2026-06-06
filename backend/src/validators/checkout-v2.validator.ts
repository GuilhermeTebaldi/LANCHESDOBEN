import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(120);
const saleBasePaymentMethodSchema = z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO']);
const salePaymentMethodSchema = z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO', 'DIVIDIDO']);
const salePaymentSplitModeSchema = z.enum(['PEOPLE', 'MIXED']);
const saleOriginSchema = z.enum(['LOCAL', 'IFOOD', 'APP99', 'KEETA']);

const checkoutV2SplitPaymentSchema = z.object({
  sequence: z.coerce.number().int().positive().optional(),
  label: z.string().trim().max(80).optional(),
  method: saleBasePaymentMethodSchema,
  amount: z.coerce.number().finite().min(0),
  cashReceived: z.coerce.number().finite().min(0).optional(),
});

const checkoutV2RecipeItemSchema = z.object({
  ingredientId: idSchema,
  quantity: z.coerce.number().finite().positive(),
});

const checkoutV2ItemSchema = z.object({
  productId: idSchema,
  itemId: idSchema.optional(),
  nameSnapshot: z.string().trim().min(1).max(160).optional(),
  qty: z.coerce.number().int().positive(),
  unitPrice: z.coerce.number().finite().min(0),
  total: z.coerce.number().finite().min(0).optional(),
  recipe: z.array(checkoutV2RecipeItemSchema).optional(),
});

export const checkoutV2ConfirmSchema = z
  .object({
    draftId: idSchema,
    commandId: idSchema,
    items: z.array(checkoutV2ItemSchema).min(1).max(200),
    paymentMethod: salePaymentMethodSchema,
    total: z.coerce.number().finite().min(0),
    createdAt: z.string().datetime(),
    cashReceived: z.coerce.number().finite().min(0).optional(),
    saleOrigin: saleOriginSchema.optional(),
    appOrderTotal: z.coerce.number().finite().min(0).optional(),
    splitMode: salePaymentSplitModeSchema.optional(),
    splitCount: z.coerce.number().int().positive().optional(),
    splitPayments: z.array(checkoutV2SplitPaymentSchema).min(1).max(99).optional(),
    operatorUserId: idSchema.optional(),
    customerType: z.enum(['BALCAO', 'ENTREGA']).optional(),
    clientTimestamp: z.string().datetime().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type CheckoutV2ConfirmInput = z.infer<typeof checkoutV2ConfirmSchema>;
