import { z } from 'zod';

const idSchema = z.string().trim().min(1).max(200);
const quantitySchema = z.coerce.number().finite();
const positiveQuantitySchema = quantitySchema.gt(0);
const snapshotImageUrlSchema = z.string().trim().max(200_000);

const recipeItemSchema = z.object({
  ingredientId: idSchema,
  quantity: positiveQuantitySchema,
});

const comboItemSchema = z.object({
  productId: idSchema,
  quantity: z.coerce.number().int().positive(),
});

const ingredientSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(50),
  currentStock: z.coerce.number().finite().min(0),
  minStock: z.coerce.number().finite().min(0),
  cost: z.coerce.number().finite().min(0),
  autoReplenishEnabled: z.boolean().optional(),
  autoReplenishQuantity: z.coerce.number().finite().min(0).optional(),
  imageUrl: snapshotImageUrlSchema.optional(),
  addonPrice: z.coerce.number().finite().min(0).optional(),
  icon: z.string().trim().max(200).optional(),
});

const productSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  price: z.coerce.number().finite().min(0),
  imageUrl: snapshotImageUrlSchema.min(1),
  category: z.enum(['Snack', 'Drink', 'Side', 'Combo']),
  recipe: z.array(recipeItemSchema).min(1),
  comboItems: z.array(comboItemSchema).optional(),
});

const cleaningMaterialSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().min(1).max(50),
  currentStock: z.coerce.number().finite().min(0),
  minStock: z.coerce.number().finite().min(0),
  cost: z.coerce.number().finite().min(0),
  imageUrl: snapshotImageUrlSchema.optional(),
});

const baseCommandSchema = z.object({
  commandId: idSchema.optional(),
});

const saleBasePaymentMethodSchema = z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO']);
const salePaymentMethodSchema = z.enum(['PIX', 'DEBITO', 'CREDITO', 'DINHEIRO', 'DIVIDIDO']);
const salePaymentSplitModeSchema = z.enum(['PEOPLE', 'MIXED']);
const saleCustomerTypeSchema = z.enum(['BALCAO', 'ENTREGA']);
const saleOriginSchema = z.enum(['LOCAL', 'IFOOD', 'APP99', 'KEETA']);

const salePaymentSplitItemSchema = z.object({
  sequence: z.coerce.number().int().positive().optional(),
  label: z.string().trim().min(1).max(80).optional(),
  method: saleBasePaymentMethodSchema,
  amount: z.coerce.number().finite().positive(),
  cashReceived: z.coerce.number().finite().min(0).optional(),
});

const saleRegisterCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_REGISTER'),
  productId: idSchema,
  recipeOverride: z.array(recipeItemSchema).min(1).optional(),
  priceOverride: z.coerce.number().finite().min(0).optional(),
  clientSaleId: idSchema.optional(),
});

const saleDraftCreateCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_CREATE'),
  draftId: idSchema,
  customerType: saleCustomerTypeSchema.optional(),
});

const saleDraftSetCustomerTypeCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_SET_CUSTOMER_TYPE'),
  draftId: idSchema,
  customerType: saleCustomerTypeSchema.optional(),
});

const saleDraftAddItemCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_ADD_ITEM'),
  draftId: idSchema,
  productId: idSchema,
  quantity: z.coerce.number().int().positive().optional(),
  recipeOverride: z.array(recipeItemSchema).min(1).optional(),
  priceOverride: z.coerce.number().finite().min(0).optional(),
  note: z.string().trim().max(2000).optional(),
});

const saleDraftUpdateItemCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_UPDATE_ITEM'),
  draftId: idSchema,
  itemId: idSchema,
  quantity: z.coerce.number().int().positive().optional(),
  note: z.string().trim().max(2000).optional(),
});

const saleDraftRemoveItemCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_REMOVE_ITEM'),
  draftId: idSchema,
  itemId: idSchema,
});

const saleDraftFinalizeCommandSchema = baseCommandSchema
  .extend({
    type: z.literal('SALE_DRAFT_FINALIZE'),
    draftId: idSchema,
    paymentMethod: salePaymentMethodSchema,
    cashReceived: z.coerce.number().finite().min(0).optional(),
    saleOrigin: saleOriginSchema.optional(),
    appOrderTotal: z.coerce.number().finite().positive().optional(),
    splitMode: salePaymentSplitModeSchema.optional(),
    splitCount: z.coerce.number().int().min(1).max(99).optional(),
    splitPayments: z.array(salePaymentSplitItemSchema).min(1).max(99).optional(),
  });

const saleDraftFinalizeAndConfirmPaidCommandSchema = baseCommandSchema
  .extend({
    type: z.literal('SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID'),
    draftId: idSchema,
    paymentMethod: salePaymentMethodSchema,
    cashReceived: z.coerce.number().finite().min(0).optional(),
    saleOrigin: saleOriginSchema.optional(),
    appOrderTotal: z.coerce.number().finite().positive().optional(),
    splitMode: salePaymentSplitModeSchema.optional(),
    splitCount: z.coerce.number().int().min(1).max(99).optional(),
    splitPayments: z.array(salePaymentSplitItemSchema).min(1).max(99).optional(),
  });

const saleDraftConfirmPaidCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_CONFIRM_PAID'),
  draftId: idSchema,
});

const saleDraftCancelCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_DRAFT_CANCEL'),
  draftId: idSchema,
});

const setBusinessSettingsCommandSchema = baseCommandSchema.extend({
  type: z.literal('SET_BUSINESS_SETTINGS'),
  infiniteStockEnabled: z.boolean(),
  ignoreStockCosts: z.boolean().optional(),
});

const saleUndoCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_UNDO_LAST'),
});

const saleUndoByIdCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_UNDO_BY_ID'),
  saleId: idSchema,
});

const saleEditByIdCommandSchema = baseCommandSchema.extend({
  type: z.literal('SALE_EDIT_BY_ID'),
  saleId: idSchema,
  paymentMethod: salePaymentMethodSchema,
  cashReceived: z.coerce.number().finite().min(0).optional(),
  orderTotal: z.coerce.number().finite().positive().optional(),
  splitMode: salePaymentSplitModeSchema.optional(),
  splitCount: z.coerce.number().int().min(1).max(99).optional(),
  splitPayments: z.array(salePaymentSplitItemSchema).min(1).max(99).optional(),
});

const ingredientStockMoveCommandSchema = baseCommandSchema.extend({
  type: z.literal('INGREDIENT_STOCK_MOVE'),
  ingredientId: idSchema,
  amount: quantitySchema.refine((value) => value !== 0, 'amount não pode ser zero'),
  useCashRegister: z.boolean().optional(),
  purchaseDescription: z.string().trim().max(200).optional(),
});

const cashExpenseCommandSchema = baseCommandSchema.extend({
  type: z.literal('CASH_EXPENSE'),
  amount: z.coerce.number().finite().positive(),
  purchaseDescription: z.string().trim().min(1).max(200),
});

const cashExpenseRevertCommandSchema = baseCommandSchema.extend({
  type: z.literal('CASH_EXPENSE_REVERT'),
  entryId: idSchema,
});

const ingredientCreateCommandSchema = baseCommandSchema.extend({
  type: z.literal('INGREDIENT_CREATE'),
  ingredient: ingredientSchema,
});

const ingredientUpdateCommandSchema = baseCommandSchema.extend({
  type: z.literal('INGREDIENT_UPDATE'),
  ingredient: ingredientSchema,
});

const ingredientDeleteCommandSchema = baseCommandSchema.extend({
  type: z.literal('INGREDIENT_DELETE'),
  ingredientId: idSchema,
});

const productCreateCommandSchema = baseCommandSchema.extend({
  type: z.literal('PRODUCT_CREATE'),
  product: productSchema,
});

const productUpdateCommandSchema = baseCommandSchema.extend({
  type: z.literal('PRODUCT_UPDATE'),
  product: productSchema,
});

const productDeleteCommandSchema = baseCommandSchema.extend({
  type: z.literal('PRODUCT_DELETE'),
  productId: idSchema,
});

const cleaningMaterialCreateCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEANING_MATERIAL_CREATE'),
  material: cleaningMaterialSchema,
});

const cleaningMaterialUpdateCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEANING_MATERIAL_UPDATE'),
  material: cleaningMaterialSchema,
});

const cleaningMaterialDeleteCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEANING_MATERIAL_DELETE'),
  materialId: idSchema,
});

const cleaningStockMoveCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEANING_STOCK_MOVE'),
  materialId: idSchema,
  amount: quantitySchema.refine((value) => value !== 0, 'amount não pode ser zero'),
});

const setCashRegisterCommandSchema = baseCommandSchema.extend({
  type: z.literal('SET_CASH_REGISTER'),
  amount: z.coerce.number().finite().min(0),
});

const closeDayCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLOSE_DAY'),
});

const clearHistoryCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEAR_HISTORY'),
});

const factoryResetCommandSchema = baseCommandSchema.extend({
  type: z.literal('FACTORY_RESET'),
});

const clearOperationalDataCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEAR_OPERATIONAL_DATA'),
});

const clearOnlyStockCommandSchema = baseCommandSchema.extend({
  type: z.literal('CLEAR_ONLY_STOCK'),
});

const deleteArchiveSalesCommandSchema = baseCommandSchema.extend({
  type: z.literal('DELETE_ARCHIVE_SALES'),
  saleIds: z.array(idSchema).min(1),
});

export const stateCommandSchema = z.discriminatedUnion('type', [
  saleRegisterCommandSchema,
  saleDraftCreateCommandSchema,
  saleDraftSetCustomerTypeCommandSchema,
  saleDraftAddItemCommandSchema,
  saleDraftUpdateItemCommandSchema,
  saleDraftRemoveItemCommandSchema,
  saleDraftFinalizeCommandSchema,
  saleDraftFinalizeAndConfirmPaidCommandSchema,
  saleDraftConfirmPaidCommandSchema,
  saleDraftCancelCommandSchema,
  setBusinessSettingsCommandSchema,
  saleUndoCommandSchema,
  saleUndoByIdCommandSchema,
  saleEditByIdCommandSchema,
  ingredientStockMoveCommandSchema,
  cashExpenseCommandSchema,
  cashExpenseRevertCommandSchema,
  ingredientCreateCommandSchema,
  ingredientUpdateCommandSchema,
  ingredientDeleteCommandSchema,
  productCreateCommandSchema,
  productUpdateCommandSchema,
  productDeleteCommandSchema,
  cleaningMaterialCreateCommandSchema,
  cleaningMaterialUpdateCommandSchema,
  cleaningMaterialDeleteCommandSchema,
  cleaningStockMoveCommandSchema,
  setCashRegisterCommandSchema,
  closeDayCommandSchema,
  clearHistoryCommandSchema,
  factoryResetCommandSchema,
  clearOperationalDataCommandSchema,
  clearOnlyStockCommandSchema,
  deleteArchiveSalesCommandSchema,
]);

export type StateCommandInput = z.infer<typeof stateCommandSchema>;
