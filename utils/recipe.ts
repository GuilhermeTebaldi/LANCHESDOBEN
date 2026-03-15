import { ComboItem, Ingredient, Product, RecipeItem } from '../types';

// Aggregates recipe quantities per ingredient to keep stock debits consistent.
export const aggregateRecipe = (recipe: RecipeItem[] = []): Record<string, number> => {
  const totals: Record<string, number> = {};

  recipe.forEach((item) => {
    if (!item?.ingredientId) return;
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return;
    totals[item.ingredientId] = (totals[item.ingredientId] || 0) + qty;
  });

  return totals;
};

interface RecipeUnitConversionProfile {
  stockUnitLabel: string;
  recipeUnitLabel: string;
  ratio: number;
  matches: (unit: string) => boolean;
}

const normalizeUnit = (value: string): string => value.trim().toLowerCase();

const hasToken = (unit: string, token: string): boolean =>
  new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(unit);

const isKgUnit = (unit: string): boolean =>
  hasToken(unit, 'kg') || unit.includes('quilo') || unit.includes('kilogram');

const isMlUnit = (unit: string): boolean =>
  hasToken(unit, 'ml') || unit.includes('mililit');

const isLiterUnit = (unit: string): boolean =>
  !isMlUnit(unit) &&
  (hasToken(unit, 'l') ||
    hasToken(unit, 'lt') ||
    hasToken(unit, 'lts') ||
    unit.includes('litro'));

const isGramUnit = (unit: string): boolean =>
  !isKgUnit(unit) && (hasToken(unit, 'g') || unit.includes('gram'));

const RECIPE_UNIT_CONVERSIONS: RecipeUnitConversionProfile[] = [
  {
    stockUnitLabel: 'kg',
    recipeUnitLabel: 'g',
    ratio: 1000,
    matches: isKgUnit,
  },
  {
    stockUnitLabel: 'l',
    recipeUnitLabel: 'ml',
    ratio: 1000,
    matches: isLiterUnit,
  },
];

const getRecipeUnitConversion = (
  ingredient: Pick<Ingredient, 'unit'>
): RecipeUnitConversionProfile | null => {
  const unit = normalizeUnit(ingredient.unit || '');
  if (!unit) return null;
  return RECIPE_UNIT_CONVERSIONS.find((profile) => profile.matches(unit)) || null;
};

const isLegacyBaseQuantity = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value < 1;

export const allowsFractionalStockUnit = (unitValue: string): boolean => {
  const unit = normalizeUnit(unitValue || '');
  if (!unit) return false;
  if (isGramUnit(unit) || isMlUnit(unit)) return true;
  return RECIPE_UNIT_CONVERSIONS.some((profile) => profile.matches(unit));
};

export const allowsFractionalStockInput = (ingredient: Pick<Ingredient, 'unit'>): boolean => {
  return allowsFractionalStockUnit(ingredient.unit || '');
};

export const normalizeStockQuantityByUnit = (unitValue: string, quantity: number): number => {
  const parsed = Number(quantity);
  if (!Number.isFinite(parsed)) return 0;

  const safeQuantity = Math.max(0, parsed);
  if (allowsFractionalStockUnit(unitValue)) {
    return Number(safeQuantity.toFixed(6));
  }
  return Math.trunc(safeQuantity);
};

export const normalizeStockMovementByUnit = (unitValue: string, amount: number): number => {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;

  if (allowsFractionalStockUnit(unitValue)) {
    return Number(parsed.toFixed(6));
  }

  const magnitude = Math.trunc(Math.abs(parsed));
  if (magnitude <= 0) return 0;
  return parsed < 0 ? -magnitude : magnitude;
};

export const getStockInputUnitLabel = (ingredient: Pick<Ingredient, 'unit'>): string => {
  const conversion = getRecipeUnitConversion(ingredient);
  if (conversion) return conversion.recipeUnitLabel;
  return ingredient.unit;
};

export const getStockQuantityFromInputQuantity = (
  ingredient: Pick<Ingredient, 'unit'>,
  inputQuantity: number
): number => {
  if (!Number.isFinite(inputQuantity) || inputQuantity <= 0) return 0;
  const conversion = getRecipeUnitConversion(ingredient);
  if (!conversion) return inputQuantity;
  // For stock manual moves, converted units are always typed in display unit (g/ml).
  return inputQuantity / conversion.ratio;
};

export const getStockInputStep = (ingredient: Pick<Ingredient, 'unit'>): number => {
  const conversion = getRecipeUnitConversion(ingredient);
  if (conversion) {
    return 1;
  }
  const unit = normalizeUnit(ingredient.unit || '');
  if (isGramUnit(unit) || isMlUnit(unit)) {
    return 1;
  }
  return 1;
};

export const getStockQuantityFromRecipeQuantity = (
  ingredient: Pick<Ingredient, 'unit'>,
  recipeQuantity: number
): number => {
  if (!Number.isFinite(recipeQuantity) || recipeQuantity <= 0) return 0;
  const conversion = getRecipeUnitConversion(ingredient);
  if (!conversion) return recipeQuantity;

  // Legacy compatibility:
  // - quantities < 1 keep historical stock-unit behavior (kg/l)
  // - quantities >= 1 are interpreted in recipe unit (g/ml)
  if (isLegacyBaseQuantity(recipeQuantity)) {
    return recipeQuantity;
  }

  return recipeQuantity / conversion.ratio;
};

export const getRecipeQuantityUnitLabel = (
  ingredient: Pick<Ingredient, 'unit'>,
  recipeQuantity?: number
): string => {
  const conversion = getRecipeUnitConversion(ingredient);
  if (!conversion) return ingredient.unit;

  if (typeof recipeQuantity === 'number' && isLegacyBaseQuantity(recipeQuantity)) {
    return conversion.stockUnitLabel;
  }
  return conversion.recipeUnitLabel;
};

export const getRecipeAdjustmentStep = (
  ingredient: Pick<Ingredient, 'unit'>,
  currentQuantity: number
): number => {
  const conversion = getRecipeUnitConversion(ingredient);
  if (!conversion) return 1;

  // Keep legacy fractional recipes editable with smallest stock increment.
  if (isLegacyBaseQuantity(currentQuantity)) {
    return Number((1 / conversion.ratio).toFixed(6));
  }

  // Default editing in display unit (g/ml).
  return 1;
};

export const normalizeRecipeQuantity = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(6));
};

export const normalizeRecipeItems = (recipe: RecipeItem[] = []): RecipeItem[] => {
  const totals = aggregateRecipe(recipe);
  return Object.entries(totals)
    .map(([ingredientId, quantity]) => ({
      ingredientId,
      quantity: normalizeRecipeQuantity(quantity),
    }))
    .filter((item) => item.quantity > 0)
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
};

const formatTrimmed = (value: number, precision = 3): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(precision).replace(/\.?0+$/, '');

export const formatStockQuantityByUnit = (unitValue: string, quantity: number): string => {
  if (!Number.isFinite(quantity)) return '0';
  const unit = normalizeUnit(unitValue || '');
  if (!allowsFractionalStockUnit(unit)) {
    return String(Math.trunc(quantity));
  }
  if (isKgUnit(unit) || isLiterUnit(unit)) {
    return quantity.toFixed(3);
  }
  return formatTrimmed(quantity, 3);
};

export const formatIngredientStockQuantity = (
  ingredient: Pick<Ingredient, 'unit'>,
  quantity: number
): string => formatStockQuantityByUnit(ingredient.unit, quantity);

export const calculateRecipeCost = (
  ingredients: Ingredient[],
  recipe: RecipeItem[] = []
): { totalCost: number; missingIngredientIds: string[]; totals: Record<string, number> } => {
  const totals = aggregateRecipe(recipe);
  let totalCost = 0;
  const missingIngredientIds: string[] = [];

  Object.entries(totals).forEach(([ingredientId, quantity]) => {
    const ing = ingredients.find((i) => i.id === ingredientId);
    if (!ing) {
      missingIngredientIds.push(ingredientId);
      return;
    }
    const stockQuantity = getStockQuantityFromRecipeQuantity(ing, quantity);
    totalCost += ing.cost * stockQuantity;
  });

  return { totalCost, missingIngredientIds, totals };
};

export interface RecipeStockIssue {
  ingredientId: string;
  ingredientName: string;
  required: number;
  available: number;
  unit: string;
}

export const getRecipeStockIssues = (
  ingredients: Ingredient[],
  totals: Record<string, number>
): RecipeStockIssue[] => {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  return Object.entries(totals)
    .map(([ingredientId, requiredRecipeQuantity]) => {
      const ingredient = ingredientById.get(ingredientId);
      if (!ingredient) return null;

      const available = Number(ingredient.currentStock);
      const required = getStockQuantityFromRecipeQuantity(ingredient, requiredRecipeQuantity);
      if (available + Number.EPSILON >= required) return null;

      return {
        ingredientId,
        ingredientName: ingredient.name,
        required,
        available,
        unit: ingredient.unit,
      };
    })
    .filter((issue): issue is RecipeStockIssue => issue !== null);
};

export const buildRecipeFromComboItems = (
  products: Pick<Product, 'id' | 'recipe'>[],
  comboItems: ComboItem[] = []
): RecipeItem[] => {
  const productsById = new Map(products.map((product) => [product.id, product]));
  const totals: Record<string, number> = {};

  comboItems.forEach((item) => {
    const comboQty = Number(item.quantity);
    if (!Number.isFinite(comboQty) || comboQty <= 0) return;

    const sourceProduct = productsById.get(item.productId);
    if (!sourceProduct) return;

    const sourceTotals = aggregateRecipe(sourceProduct.recipe);
    Object.entries(sourceTotals).forEach(([ingredientId, quantity]) => {
      totals[ingredientId] = (totals[ingredientId] || 0) + quantity * comboQty;
    });
  });

  return Object.entries(totals)
    .map(([ingredientId, quantity]) => ({ ingredientId, quantity }))
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
};
