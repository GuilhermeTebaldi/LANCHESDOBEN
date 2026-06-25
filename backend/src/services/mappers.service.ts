import {
  ProductCategory,
  SaleStatus,
  StockDirection,
  type CleaningMaterial,
  type Ingredient,
  type Product,
  type ProductIngredient,
  type Refund,
  type Sale,
  type SaleItem,
  type SaleItemIngredient,
  type StockMovement,
} from '@prisma/client';

import type {
  FrontCleaningMaterial,
  FrontCleaningStockEntry,
  FrontIngredient,
  FrontProduct,
  FrontRecipeItem,
  FrontSale,
  FrontStockEntry,
} from '../types/frontend.js';
import { roundMoney, roundQuantity, toNumber } from '../utils/decimal.js';

const categoryMap: Record<ProductCategory, FrontProduct['category']> = {
  SNACK: 'Snack',
  DRINK: 'Drink',
  SIDE: 'Side',
};

export const toFrontIngredient = (row: Ingredient): FrontIngredient => ({
  id: row.id,
  name: row.name,
  unit: row.unit,
  currentStock: roundQuantity(toNumber(row.currentStock)),
  minStock: roundQuantity(toNumber(row.minStock)),
  cost: roundMoney(toNumber(row.cost)),
  imageUrl: row.imageUrl || undefined,
  addonPrice: row.addonPrice ? roundMoney(toNumber(row.addonPrice)) : undefined,
});

export const toFrontCleaningMaterial = (row: CleaningMaterial): FrontCleaningMaterial => ({
  id: row.id,
  name: row.name,
  unit: row.unit,
  currentStock: roundQuantity(toNumber(row.currentStock)),
  minStock: roundQuantity(toNumber(row.minStock)),
  cost: roundMoney(toNumber(row.cost)),
  imageUrl: row.imageUrl || undefined,
});

export const toFrontRecipe = (rows: Pick<ProductIngredient, 'ingredientId' | 'quantity'>[]): FrontRecipeItem[] => {
  return rows
    .map((item) => ({
      ingredientId: item.ingredientId,
      quantity: roundQuantity(toNumber(item.quantity)),
    }))
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
};

export const toFrontProduct = (
  row: Product & { recipeItems: Pick<ProductIngredient, 'ingredientId' | 'quantity'>[] }
): FrontProduct => ({
  id: row.id,
  name: row.name,
  price: roundMoney(toNumber(row.price)),
  imageUrl: row.imageUrl,
  category: categoryMap[row.category],
  recipe: toFrontRecipe(row.recipeItems),
});

const toFrontSaleRecipe = (
  saleItems: Array<{
    ingredients: Pick<SaleItemIngredient, 'ingredientId' | 'quantity'>[];
  }>
): FrontRecipeItem[] => {
  const totals = new Map<string, number>();

  saleItems.forEach((item) => {
    item.ingredients.forEach((ingredient) => {
      if (!ingredient.ingredientId) return;

      const current = totals.get(ingredient.ingredientId) || 0;
      totals.set(
        ingredient.ingredientId,
        roundQuantity(current + toNumber(ingredient.quantity))
      );
    });
  });

  return [...totals.entries()].map(([ingredientId, quantity]) => ({
    ingredientId,
    quantity,
  }));
};

export const toFrontSale = (
  sale: Sale & {
    items: Array<
      SaleItem & {
        ingredients: Pick<SaleItemIngredient, 'ingredientId' | 'quantity'>[];
      }
    >;
    refunds?: Array<Pick<Refund, 'totalCostReversed'>>;
  }
): FrontSale => {
  const firstItem = sale.items[0];
  const isMultiItem = sale.items.length > 1;
  const totalUnits = sale.items.reduce((sum, item) => sum + item.quantity, 0);
  const recipe = toFrontSaleRecipe(sale.items);
  const refundedCost = sale.refunds
    ? roundQuantity(
        sale.refunds.reduce(
          (sum, refund) => roundQuantity(sum + toNumber(refund.totalCostReversed)),
          0
        )
      )
    : 0;

  const totalCostNet = roundMoney(Math.max(0, toNumber(sale.totalCost) - refundedCost));
  const displayTotal =
    sale.status === SaleStatus.REFUNDED
      ? roundMoney(toNumber(sale.totalRefunded) || toNumber(sale.totalGross))
      : roundMoney(toNumber(sale.totalNet));

  return {
    id: sale.id,
    productId: isMultiItem ? '' : firstItem?.productId || '',
    productName: isMultiItem
      ? `Pedido (${totalUnits} itens)`
      : firstItem?.productNameSnapshot || 'Venda sem item',
    quantity: totalUnits,
    timestamp: sale.createdAt,
    total: displayTotal,
    totalCost: totalCostNet,
    recipe,
    basePrice: !isMultiItem && firstItem?.baseUnitPrice
      ? roundMoney(toNumber(firstItem.baseUnitPrice))
      : undefined,
    priceAdjustment: !isMultiItem && firstItem?.priceAdjustment
      ? roundMoney(toNumber(firstItem.priceAdjustment))
      : undefined,
    baseCost: !isMultiItem && firstItem?.baseUnitCost
      ? roundMoney(toNumber(firstItem.baseUnitCost))
      : undefined,
  };
};

export const toFrontIngredientEntry = (
  movement: StockMovement & {
    ingredient: { id: string; name: string } | null;
  }
): FrontStockEntry => {
  const source: FrontStockEntry['source'] =
    movement.reason === 'SALE'
      ? 'SALE'
      : movement.reason === 'SYSTEM'
        ? 'AUTO_REPLENISH'
        : 'MANUAL';

  return {
    id: movement.id,
    ingredientId: movement.ingredient?.id || movement.ingredientId || '',
    ingredientName: movement.ingredient?.name || 'Insumo removido',
    quantity:
      movement.direction === StockDirection.OUT
        ? -roundQuantity(toNumber(movement.quantity))
        : roundQuantity(toNumber(movement.quantity)),
    timestamp: movement.createdAt,
    unitCost: roundMoney(toNumber(movement.unitCost)),
    source,
    saleId: movement.saleId || undefined,
  };
};

export const toFrontCleaningEntry = (
  movement: StockMovement & {
    cleaningMaterial: { id: string; name: string } | null;
  }
): FrontCleaningStockEntry => ({
  id: movement.id,
  materialId: movement.cleaningMaterial?.id || movement.cleaningMaterialId || '',
  materialName: movement.cleaningMaterial?.name || 'Material removido',
  quantity:
    movement.direction === StockDirection.OUT
      ? -roundQuantity(toNumber(movement.quantity))
      : roundQuantity(toNumber(movement.quantity)),
  timestamp: movement.createdAt,
  unitCost: roundMoney(toNumber(movement.unitCost)),
});
