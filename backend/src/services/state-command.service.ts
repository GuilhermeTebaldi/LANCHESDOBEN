import type {
  FrontAppState,
  FrontCashRegisterExpenseDetail,
  FrontCleaningMaterial,
  FrontCleaningStockEntry,
  FrontDailySalesHistoryEntry,
  FrontIngredient,
  FrontProduct,
  FrontRecipeItem,
  FrontSaleBasePaymentMethod,
  FrontSaleCustomerType,
  FrontSaleDraft,
  FrontSaleDraftItem,
  FrontSalePayment,
  FrontSalePaymentSplitEntry,
  FrontSalePaymentSplitMode,
  FrontSalePaymentMethod,
  FrontSaleOrigin,
  FrontSale,
  FrontStockEntry,
} from '../types/frontend.js';
import type { StateCommandInput } from '../validators/state-command.validator.js';
import { HttpError } from '../utils/http-error.js';

const createId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const logStateCommandPerf = (
  commandType:
    | 'SALE_DRAFT_FINALIZE'
    | 'SALE_DRAFT_CONFIRM_PAID'
    | 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID',
  payload: Record<string, unknown>
): void => {
  // Keep perf logs explicit for terminal payment flow diagnostics in production.
  // eslint-disable-next-line no-console
  console.info('[state-command-perf]', {
    commandType,
    ...payload,
  });
};

const toTimestampIso = (value?: Date | string): string => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'Timestamp inválido para operação de estado.');
  }
  return date.toISOString();
};

const BUSINESS_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (value: number): string => value.toString().padStart(2, '0');
const toDayKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const normalizeBusinessDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!BUSINESS_DAY_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
};

const toTimestampMs = (value: Date | string | null | undefined): number | null => {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getTime();
};

const resolveSessionBusinessDate = (
  state: Pick<FrontAppState, 'sales' | 'stockEntries'>,
  fallback?: Date | string
): string => {
  let earliestMs = Number.POSITIVE_INFINITY;

  state.sales.forEach((sale) => {
    const candidateMs = toTimestampMs(sale.timestamp);
    if (candidateMs === null) return;
    if (candidateMs < earliestMs) earliestMs = candidateMs;
  });

  state.stockEntries.forEach((entry) => {
    const candidateMs = toTimestampMs(entry.timestamp);
    if (candidateMs === null) return;
    if (candidateMs < earliestMs) earliestMs = candidateMs;
  });

  if (Number.isFinite(earliestMs)) {
    return toDayKey(new Date(earliestMs));
  }

  const fallbackDate = fallback ? new Date(fallback) : new Date();
  if (Number.isNaN(fallbackDate.getTime())) return toDayKey(new Date());
  return toDayKey(fallbackDate);
};

const resolveHistoryBusinessDate = (closedAt: Date | string, businessDate?: string): string =>
  normalizeBusinessDate(businessDate) || toDayKey(new Date(toTimestampIso(closedAt)));

const aggregateRecipe = (recipe: FrontRecipeItem[] = []): Record<string, number> => {
  return recipe.reduce<Record<string, number>>((acc, item) => {
    if (!item?.ingredientId) return acc;
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return acc;
    acc[item.ingredientId] = (acc[item.ingredientId] || 0) + qty;
    return acc;
  }, {});
};

const normalizeRecipeItems = (recipe: FrontRecipeItem[] = []): FrontRecipeItem[] =>
  Object.entries(aggregateRecipe(recipe))
    .map(([ingredientId, quantity]) => ({ ingredientId, quantity: Number(quantity.toFixed(6)) }))
    .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0)
    .sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));

interface RecipeUnitConversionProfile {
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

const RECIPE_UNIT_CONVERSIONS: RecipeUnitConversionProfile[] = [
  {
    ratio: 1000,
    matches: isKgUnit,
  },
  {
    ratio: 1000,
    matches: isLiterUnit,
  },
];

const getRecipeUnitConversion = (
  ingredient: Pick<FrontIngredient, 'unit'>
): RecipeUnitConversionProfile | null => {
  const unit = normalizeUnit(ingredient.unit || '');
  if (!unit) return null;
  return RECIPE_UNIT_CONVERSIONS.find((profile) => profile.matches(unit)) || null;
};

const isLegacyBaseQuantity = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value < 1;

const toStockQuantity = (ingredient: Pick<FrontIngredient, 'unit'>, recipeQuantity: number): number => {
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

const calculateRecipeCost = (
  ingredients: FrontIngredient[],
  recipe: FrontRecipeItem[]
): { totalCost: number; missingIngredientIds: string[]; totals: Record<string, number> } => {
  const totals = aggregateRecipe(recipe);
  let totalCost = 0;
  const missingIngredientIds: string[] = [];

  Object.entries(totals).forEach(([ingredientId, quantity]) => {
    const ingredient = ingredients.find((entry) => entry.id === ingredientId);
    if (!ingredient) {
      missingIngredientIds.push(ingredientId);
      return;
    }
    const stockQuantity = toStockQuantity(ingredient, quantity);
    totalCost += ingredient.cost * stockQuantity;
  });

  return { totalCost, missingIngredientIds, totals };
};

const getAppliedStockDelta = (currentStock: number, requestedAmount: number): number => {
  if (!Number.isFinite(currentStock) || !Number.isFinite(requestedAmount) || requestedAmount === 0) {
    return 0;
  }

  const normalizedAmount = requestedAmount < 0 ? Math.max(requestedAmount, -currentStock) : requestedAmount;
  if (!Number.isFinite(normalizedAmount) || normalizedAmount === 0) {
    return 0;
  }

  return Math.max(0, currentStock + normalizedAmount) - currentStock;
};

const roundMoney = (value: number): number => Number(value.toFixed(2));
const LEGACY_COST_RATIO_MAX = 3.5;
const LEGACY_COST_RATIO_TARGET = 0.45;
const LEGACY_COST_DIVISORS = [1, 10, 100, 1000] as const;

const toNonNegativeMoney = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return roundMoney(parsed);
};

const normalizeLegacyHistoryCost = (rawCost: number, rawRevenue: number): number => {
  if (!Number.isFinite(rawCost) || rawCost <= 0) return 0;
  const cost = roundMoney(rawCost);
  if (!Number.isFinite(rawRevenue) || rawRevenue <= 0) return cost;

  const revenue = roundMoney(rawRevenue);
  const ratio = cost / revenue;
  if (ratio <= LEGACY_COST_RATIO_MAX) return cost;

  const viableCandidates = LEGACY_COST_DIVISORS
    .map((divisor) => roundMoney(cost / divisor))
    .filter((candidate) => candidate >= 0 && candidate / revenue <= LEGACY_COST_RATIO_MAX);
  if (viableCandidates.length === 0) return cost;

  return viableCandidates.reduce((best, candidate) => {
    const bestDelta = Math.abs(best / revenue - LEGACY_COST_RATIO_TARGET);
    const candidateDelta = Math.abs(candidate / revenue - LEGACY_COST_RATIO_TARGET);
    return candidateDelta < bestDelta ? candidate : best;
  }, viableCandidates[0]);
};

const cloneRecipe = (recipe: FrontRecipeItem[] | undefined): FrontRecipeItem[] | undefined =>
  recipe?.map((item) => ({
    ingredientId: item.ingredientId,
    quantity: item.quantity,
  }));

const normalizeCashExpenseDetails = (value: unknown): FrontCashRegisterExpenseDetail[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): FrontCashRegisterExpenseDetail | null => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const source = item as Record<string, unknown>;
      const amount = toNonNegativeMoney(source.amount);
      if (amount <= 0) return null;

      const timestampRaw = source.timestamp;
      const timestamp =
        timestampRaw instanceof Date || typeof timestampRaw === 'string'
          ? timestampRaw
          : toTimestampIso();
      const expenseType = source.expenseType === 'OTHER' ? 'OTHER' : 'INGREDIENT';
      const quantity = Number(source.quantity);
      const normalizedQuantity =
        Number.isFinite(quantity) && quantity > 0 ? Number(quantity.toFixed(6)) : undefined;

      return {
        entryId:
          typeof source.entryId === 'string' && source.entryId.trim()
            ? source.entryId
            : createId('cash-expense'),
        timestamp,
        amount,
        expenseType,
        ingredientId:
          typeof source.ingredientId === 'string' && source.ingredientId.trim()
            ? source.ingredientId
            : undefined,
        ingredientName:
          typeof source.ingredientName === 'string' && source.ingredientName.trim()
            ? source.ingredientName
            : undefined,
        ingredientUnit:
          typeof source.ingredientUnit === 'string' && source.ingredientUnit.trim()
            ? source.ingredientUnit
            : undefined,
        quantity: normalizedQuantity,
        purchaseDescription:
          typeof source.purchaseDescription === 'string' && source.purchaseDescription.trim()
            ? source.purchaseDescription
            : undefined,
      };
    })
    .filter((item): item is FrontCashRegisterExpenseDetail => item !== null)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
};

const isSaleBasePaymentMethod = (value: unknown): value is FrontSaleBasePaymentMethod =>
  value === 'PIX' || value === 'DEBITO' || value === 'CREDITO' || value === 'DINHEIRO';

const isSalePaymentMethod = (value: unknown): value is FrontSalePaymentMethod =>
  isSaleBasePaymentMethod(value) || value === 'DIVIDIDO';

const isSalePaymentSplitMode = (value: unknown): value is FrontSalePaymentSplitMode =>
  value === 'PEOPLE' || value === 'MIXED';

const isSaleOrigin = (value: unknown): value is FrontSaleOrigin =>
  value === 'LOCAL' || value === 'IFOOD' || value === 'APP99' || value === 'KEETA';

const normalizeSaleOrigin = (value: unknown): FrontSaleOrigin =>
  isSaleOrigin(value) ? value : 'LOCAL';

const isAppSaleOrigin = (origin: FrontSaleOrigin): boolean =>
  origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA';

const normalizeAppOrderTotal = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return roundMoney(parsed);
};

const normalizeSplitCount = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
};

const normalizeSplitLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : null;
};

const normalizeSalePaymentSplitEntry = (
  entry: unknown,
  fallbackIndex: number
): FrontSalePaymentSplitEntry | null => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const source = entry as Partial<FrontSalePaymentSplitEntry>;
  if (!isSaleBasePaymentMethod(source.method)) return null;

  const amountRaw = Number(source.amount);
  const amount = roundMoney(amountRaw);
  if (!Number.isFinite(amountRaw) || amount <= 0) return null;

  const sequenceRaw = Number(source.sequence);
  const sequence =
    Number.isFinite(sequenceRaw) && Number.isInteger(sequenceRaw) && sequenceRaw > 0
      ? sequenceRaw
      : fallbackIndex + 1;

  const cashReceivedRaw = Number(source.cashReceived);
  const cashReceived =
    source.method === 'DINHEIRO' && Number.isFinite(cashReceivedRaw) && cashReceivedRaw >= 0
      ? roundMoney(cashReceivedRaw)
      : null;

  const changeRaw = Number(source.change);
  const change = source.method === 'DINHEIRO' && Number.isFinite(changeRaw) ? roundMoney(changeRaw) : null;
  const label = normalizeSplitLabel(source.label) || `Parcela ${fallbackIndex + 1}`;

  return {
    sequence,
    label,
    method: source.method,
    amount,
    cashReceived,
    change,
  };
};

const normalizeSalePaymentSplitEntries = (value: unknown): FrontSalePaymentSplitEntry[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeSalePaymentSplitEntry(entry, index))
    .filter((entry): entry is FrontSalePaymentSplitEntry => entry !== null)
    .sort((a, b) => a.sequence - b.sequence);
};

const allocateOrderTotalByWeight = (
  lineTotals: number[],
  targetTotal: number
): number[] => {
  if (lineTotals.length === 0) return [];

  const targetCents = Math.max(0, Math.round(targetTotal * 100));
  if (lineTotals.length === 1) {
    return [roundMoney(targetCents / 100)];
  }

  const normalizedWeights = lineTotals.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0
  );
  const totalWeight = normalizedWeights.reduce((sum, value) => sum + value, 0);

  const effectiveWeights =
    totalWeight > 0
      ? normalizedWeights
      : normalizedWeights.map(() => 1);
  const effectiveWeightTotal = effectiveWeights.reduce((sum, value) => sum + value, 0);

  const baseShares = effectiveWeights.map((weight, index) => {
    const rawShare = (targetCents * weight) / effectiveWeightTotal;
    const floorShare = Math.floor(rawShare);
    return {
      index,
      cents: floorShare,
      fraction: rawShare - floorShare,
    };
  });

  let distributed = baseShares.reduce((sum, entry) => sum + entry.cents, 0);
  let remainder = targetCents - distributed;

  if (remainder > 0) {
    const sortedByFraction = [...baseShares].sort((a, b) => {
      const diff = b.fraction - a.fraction;
      if (diff !== 0) return diff;
      return a.index - b.index;
    });
    for (let step = 0; step < remainder; step += 1) {
      sortedByFraction[step % sortedByFraction.length].cents += 1;
    }
  }

  distributed = baseShares.reduce((sum, entry) => sum + entry.cents, 0);
  remainder = targetCents - distributed;
  if (remainder !== 0) {
    baseShares[baseShares.length - 1].cents += remainder;
  }

  return baseShares
    .sort((a, b) => a.index - b.index)
    .map((entry) => roundMoney(entry.cents / 100));
};

const normalizeSalePayment = (payment: unknown): FrontSalePayment => {
  const candidate =
    payment && typeof payment === 'object' && !Array.isArray(payment)
      ? (payment as Partial<FrontSalePayment>)
      : undefined;
  const cashReceived = candidate?.cashReceived;
  const change = candidate?.change;
  const method = isSalePaymentMethod(candidate?.method) ? candidate.method : null;
  const splitMode = isSalePaymentSplitMode(candidate?.splitMode) ? candidate.splitMode : null;
  const splitCount = normalizeSplitCount(candidate?.splitCount);
  const splitPayments = normalizeSalePaymentSplitEntries(candidate?.splitPayments);
  const isDivided = method === 'DIVIDIDO';

  return {
    method,
    cashReceived: typeof cashReceived === 'number' && Number.isFinite(cashReceived) ? cashReceived : null,
    change: typeof change === 'number' && Number.isFinite(change) ? change : null,
    confirmedAt:
      candidate?.confirmedAt instanceof Date || typeof candidate?.confirmedAt === 'string'
        ? candidate.confirmedAt
        : null,
    splitMode: isDivided ? splitMode : null,
    splitCount: isDivided ? splitCount : null,
    splitPayments: isDivided ? splitPayments : [],
  };
};

const cloneSalePayment = (payment: FrontSalePayment | undefined): FrontSalePayment | undefined => {
  if (!payment) return undefined;
  return normalizeSalePayment(payment);
};

const cloneSaleDraftItem = (item: FrontSaleDraftItem): FrontSaleDraftItem => {
  const safeRecipe = Array.isArray(item?.recipe) ? item.recipe : [];
  const qty = Number(item?.qty);
  return {
    ...item,
    qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
    recipe: cloneRecipe(safeRecipe) || [],
  };
};

const cloneSaleDraft = (draft: FrontSaleDraft): FrontSaleDraft => ({
  ...draft,
  items: Array.isArray(draft?.items) ? draft.items.map(cloneSaleDraftItem) : [],
  payment: normalizeSalePayment(draft?.payment),
  saleOrigin: normalizeSaleOrigin(draft?.saleOrigin),
  appOrderTotal: normalizeAppOrderTotal(draft?.appOrderTotal),
  stockDebited: Boolean(draft?.stockDebited),
});

const cloneSale = (sale: FrontSale): FrontSale => ({
  ...sale,
  recipe: cloneRecipe(sale.recipe),
  stockDebited: cloneRecipe(sale.stockDebited),
  payment: cloneSalePayment(sale.payment),
  saleOrigin: normalizeSaleOrigin(sale?.saleOrigin),
  appOrderTotal: normalizeAppOrderTotal(sale?.appOrderTotal),
});

const cloneDailySalesHistoryEntry = (
  entry: FrontDailySalesHistoryEntry
): FrontDailySalesHistoryEntry => {
  const totalRevenue = toNonNegativeMoney(entry.totalRevenue);
  const rawTotalPurchases = Number(entry.totalPurchases);
  const rawTotalProfit = Number(entry.totalProfit);
  const fallbackTotalPurchases =
    Number.isFinite(rawTotalProfit) && rawTotalProfit <= totalRevenue
      ? Math.max(0, totalRevenue - rawTotalProfit)
      : 0;
  const totalPurchases = roundMoney(
    Number.isFinite(rawTotalPurchases) && rawTotalPurchases >= 0
      ? rawTotalPurchases
      : fallbackTotalPurchases
  );
  const normalizedPurchases = normalizeLegacyHistoryCost(totalPurchases, totalRevenue);
  const closedAt =
    entry.closedAt instanceof Date || typeof entry.closedAt === 'string'
      ? entry.closedAt
      : toTimestampIso();

  return {
    ...entry,
    closedAt,
    businessDate: resolveHistoryBusinessDate(closedAt, entry.businessDate),
    openingCash: toNonNegativeMoney(entry.openingCash),
    totalRevenue,
    totalPurchases: normalizedPurchases,
    totalProfit: roundMoney(totalRevenue - normalizedPurchases),
    saleCount: Number.isFinite(Number(entry.saleCount)) ? Math.max(0, Math.floor(Number(entry.saleCount))) : 0,
    cashExpenses: toNonNegativeMoney(entry.cashExpenses),
    cashExpenseDetails: normalizeCashExpenseDetails(entry.cashExpenseDetails),
  };
};

const ensureDailySalesHistory = (state: FrontAppState): FrontDailySalesHistoryEntry[] => {
  if (!state.dailySalesHistory) {
    state.dailySalesHistory = [];
  }
  return state.dailySalesHistory;
};

const cloneState = (state: FrontAppState): FrontAppState => ({
  ingredients: state.ingredients.map((ingredient) => ({ ...ingredient })),
  products: state.products.map((product) => ({
    ...product,
    recipe: cloneRecipe(product.recipe) || [],
    comboItems: product.comboItems?.map((item) => ({ ...item })),
  })),
  sales: state.sales.map(cloneSale),
  stockEntries: state.stockEntries.map((entry) => ({ ...entry })),
  cleaningMaterials: state.cleaningMaterials.map((material) => ({ ...material })),
  cleaningStockEntries: state.cleaningStockEntries.map((entry) => ({ ...entry })),
  globalSales: state.globalSales.map(cloneSale),
  globalCancelledSales: state.globalCancelledSales.map(cloneSale),
  globalStockEntries: state.globalStockEntries.map((entry) => ({ ...entry })),
  globalCleaningStockEntries: state.globalCleaningStockEntries.map((entry) => ({ ...entry })),
  saleDrafts: (state.saleDrafts || [])
    .filter((draft): draft is FrontSaleDraft => Boolean(draft && typeof draft === 'object'))
    .map(cloneSaleDraft),
  cashRegisterAmount: toNonNegativeMoney(state.cashRegisterAmount),
  dailySalesHistory: (state.dailySalesHistory || [])
    .filter(
      (entry): entry is FrontDailySalesHistoryEntry =>
        Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
    )
    .map(cloneDailySalesHistoryEntry),
});

const emptyAppState = (): FrontAppState => ({
  ingredients: [],
  products: [],
  sales: [],
  stockEntries: [],
  cleaningMaterials: [],
  cleaningStockEntries: [],
  globalSales: [],
  globalCancelledSales: [],
  globalStockEntries: [],
  globalCleaningStockEntries: [],
  saleDrafts: [],
  cashRegisterAmount: 0,
  dailySalesHistory: [],
});

const requireIngredient = (state: FrontAppState, ingredientId: string): FrontIngredient => {
  const ingredient = state.ingredients.find((entry) => entry.id === ingredientId);
  if (!ingredient) {
    throw new HttpError(404, 'Insumo não encontrado para operação.');
  }
  return ingredient;
};

const requireMaterial = (state: FrontAppState, materialId: string): FrontCleaningMaterial => {
  const material = state.cleaningMaterials.find((entry) => entry.id === materialId);
  if (!material) {
    throw new HttpError(404, 'Material de limpeza não encontrado para operação.');
  }
  return material;
};

const pushIngredientMovement = (
  state: FrontAppState,
  entry: FrontStockEntry
): void => {
  state.stockEntries.push(entry);
  state.globalStockEntries.push({ ...entry });
};

const pushCleaningMovement = (
  state: FrontAppState,
  entry: FrontCleaningStockEntry
): void => {
  state.cleaningStockEntries.push(entry);
  state.globalCleaningStockEntries.push({ ...entry });
};

const defaultSalePayment = (): FrontSalePayment => ({
  method: null,
  cashReceived: null,
  change: null,
  confirmedAt: null,
  splitMode: null,
  splitCount: null,
  splitPayments: [],
});

const ensureSaleDrafts = (state: FrontAppState): FrontSaleDraft[] => {
  if (!state.saleDrafts) {
    state.saleDrafts = [];
  }
  return state.saleDrafts;
};

const requireSaleDraft = (state: FrontAppState, draftId: string): FrontSaleDraft => {
  const drafts = ensureSaleDrafts(state);
  const draft = drafts.find((entry) => entry.id === draftId);
  if (!draft) {
    throw new HttpError(404, 'Carrinho não encontrado.');
  }
  return draft;
};

const getOrCreateSaleDraft = (state: FrontAppState, draftId: string): FrontSaleDraft => {
  const drafts = ensureSaleDrafts(state);
  const existing = drafts.find((entry) => entry.id === draftId);
  if (existing) return existing;

  applySaleDraftCreate(state, {
    type: 'SALE_DRAFT_CREATE',
    draftId,
  });

  return requireSaleDraft(state, draftId);
};

const ensureDraftStatus = (
  draft: FrontSaleDraft,
  allowed: FrontSaleDraft['status'][],
  message: string
): void => {
  if (!allowed.includes(draft.status)) {
    throw new HttpError(409, message, { draftId: draft.id, status: draft.status });
  }
};

const normalizeOptionalNote = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeDraftTotal = (draft: FrontSaleDraft): number =>
  roundMoney(
    draft.items.reduce((sum, item) => {
      const unitPrice = item.unitPriceSnapshot ?? 0;
      return sum + unitPrice * item.qty;
    }, 0)
  );

const normalizePaymentChange = (
  method: FrontSalePaymentMethod,
  total: number,
  cashReceived: number | null
): number | null => {
  if (method !== 'DINHEIRO') return null;
  if (cashReceived === null) return null;
  return roundMoney(cashReceived - total);
};

const sameRecipe = (left: FrontRecipeItem[], right: FrontRecipeItem[]): boolean => {
  const normalizedLeft = normalizeRecipeItems(left);
  const normalizedRight = normalizeRecipeItems(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((item, index) => {
    const target = normalizedRight[index];
    if (!target) return false;
    return item.ingredientId === target.ingredientId && item.quantity === target.quantity;
  });
};

const scaleRecipe = (recipe: FrontRecipeItem[], quantity: number): FrontRecipeItem[] =>
  normalizeRecipeItems(
    recipe.map((item) => ({
      ingredientId: item.ingredientId,
      quantity: item.quantity * quantity,
    }))
  );

interface NormalizedSplitPaymentPlan {
  splitMode: FrontSalePaymentSplitMode;
  splitCount: number;
  splitPayments: FrontSalePaymentSplitEntry[];
  totalCashReceived: number | null;
  totalCashChange: number | null;
}

const buildSplitPaymentPlan = (input: {
  splitMode: unknown;
  splitCount: unknown;
  splitPayments: unknown;
  amountDue: number;
}): NormalizedSplitPaymentPlan => {
  const splitMode = isSalePaymentSplitMode(input.splitMode) ? input.splitMode : null;
  if (!splitMode) {
    throw new HttpError(422, 'Modo de pagamento dividido inválido.');
  }

  const splitCount = normalizeSplitCount(input.splitCount);
  if (!splitCount) {
    throw new HttpError(422, 'Quantidade de pessoas/parcelas inválida para pagamento dividido.');
  }

  const splitPayments = normalizeSalePaymentSplitEntries(input.splitPayments);
  if (splitPayments.length === 0) {
    throw new HttpError(422, 'Informe ao menos uma parcela para pagamento dividido.');
  }

  if (splitMode === 'PEOPLE' && splitPayments.length !== splitCount) {
    throw new HttpError(422, 'No modo por pessoas, a quantidade de parcelas deve ser igual ao total de pessoas.', {
      splitCount,
      splitPayments: splitPayments.length,
    });
  }

  if (splitMode === 'MIXED') {
    if (splitCount !== 1) {
      throw new HttpError(422, 'No modo misto, splitCount deve ser 1.');
    }
    if (splitPayments.length < 2) {
      throw new HttpError(422, 'No modo misto, informe pelo menos duas parcelas de pagamento.');
    }
  }

  let totalAmount = 0;
  let totalCashReceived = 0;
  let totalCashChange = 0;
  let hasCashPayment = false;

  const normalizedPayments = splitPayments.map((entry, index) => {
    const amount = roundMoney(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new HttpError(422, `Valor inválido na parcela ${index + 1}.`);
    }

    let cashReceived: number | null = null;
    let change: number | null = null;

    if (entry.method === 'DINHEIRO') {
      if (entry.cashReceived === null || !Number.isFinite(entry.cashReceived)) {
        throw new HttpError(422, `Informe o valor recebido em dinheiro na parcela ${index + 1}.`);
      }
      cashReceived = roundMoney(entry.cashReceived);
      if (cashReceived + Number.EPSILON < amount) {
        throw new HttpError(409, `Valor em dinheiro insuficiente na parcela ${index + 1}.`, {
          splitIndex: index + 1,
          amount,
          cashReceived,
        });
      }
      change = roundMoney(cashReceived - amount);
      hasCashPayment = true;
      totalCashReceived += cashReceived;
      totalCashChange += change;
    }

    totalAmount += amount;

    return {
      sequence: index + 1,
      label: normalizeSplitLabel(entry.label) || (splitMode === 'PEOPLE' ? `Pessoa ${index + 1}` : `Parcela ${index + 1}`),
      method: entry.method,
      amount,
      cashReceived,
      change,
    };
  });

  const expectedCents = Math.round(roundMoney(input.amountDue) * 100);
  const totalCents = Math.round(roundMoney(totalAmount) * 100);
  if (totalCents !== expectedCents) {
    throw new HttpError(422, 'A soma das parcelas não corresponde ao valor total da venda.', {
      totalAmount: roundMoney(totalAmount),
      amountDue: roundMoney(input.amountDue),
    });
  }

  return {
    splitMode,
    splitCount,
    splitPayments: normalizedPayments,
    totalCashReceived: hasCashPayment ? roundMoney(totalCashReceived) : null,
    totalCashChange: hasCashPayment ? roundMoney(totalCashChange) : null,
  };
};

const updateDraftPayment = (
  draft: FrontSaleDraft,
  input: {
    method: FrontSalePaymentMethod;
    cashReceivedInput?: number;
    splitMode?: FrontSalePaymentSplitMode;
    splitCount?: number;
    splitPayments?: unknown;
    amountDue: number;
  }
): void => {
  const { method, cashReceivedInput, splitMode, splitCount, splitPayments, amountDue } = input;
  const previousConfirmedAt = draft.payment.confirmedAt ?? null;

  if (method === 'DIVIDIDO') {
    const splitPlan = buildSplitPaymentPlan({
      splitMode,
      splitCount,
      splitPayments,
      amountDue,
    });

    draft.payment = {
      method,
      cashReceived: splitPlan.totalCashReceived,
      change: splitPlan.totalCashChange,
      confirmedAt: previousConfirmedAt,
      splitMode: splitPlan.splitMode,
      splitCount: splitPlan.splitCount,
      splitPayments: splitPlan.splitPayments,
    };
    return;
  }

  const cashReceived =
    method === 'DINHEIRO'
      ? cashReceivedInput !== undefined
        ? cashReceivedInput
        : draft.payment.method === 'DINHEIRO'
          ? draft.payment.cashReceived
          : null
      : null;

  draft.payment = {
    method,
    cashReceived,
    change: normalizePaymentChange(method, amountDue, cashReceived),
    confirmedAt: previousConfirmedAt,
    splitMode: null,
    splitCount: null,
    splitPayments: [],
  };
};

const applySaleDraftCreate = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_CREATE' }>
) => {
  const drafts = ensureSaleDrafts(state);
  const existing = drafts.find((entry) => entry.id === command.draftId);
  if (existing) {
    existing.saleOrigin = normalizeSaleOrigin(existing.saleOrigin);
    existing.appOrderTotal = normalizeAppOrderTotal(existing.appOrderTotal);
    if (command.customerType) {
      existing.customerType = command.customerType;
      existing.updatedAt = toTimestampIso();
    }
    return;
  }

  const timestamp = toTimestampIso();
  drafts.push({
    id: command.draftId,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [],
    total: 0,
    customerType: command.customerType,
    saleOrigin: 'LOCAL',
    appOrderTotal: null,
    status: 'DRAFT',
    payment: defaultSalePayment(),
    stockDebited: false,
  });
};

const applySaleDraftSetCustomerType = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_SET_CUSTOMER_TYPE' }>
) => {
  const draft = requireSaleDraft(state, command.draftId);
  ensureDraftStatus(draft, ['DRAFT', 'PENDING_PAYMENT'], 'Não é possível alterar o tipo desta venda.');
  draft.customerType = command.customerType;
  draft.updatedAt = toTimestampIso();
};

const applySaleDraftAddItem = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_ADD_ITEM' }>
) => {
  const draft = getOrCreateSaleDraft(state, command.draftId);
  ensureDraftStatus(draft, ['DRAFT'], 'Carrinho já foi finalizado para pagamento.');

  const product = state.products.find((entry) => entry.id === command.productId);
  if (!product) {
    throw new HttpError(404, 'Produto não encontrado para adicionar ao carrinho.');
  }

  const quantity = command.quantity ?? 1;
  const normalizedRecipe = normalizeRecipeItems(command.recipeOverride || product.recipe);
  if (normalizedRecipe.length === 0) {
    throw new HttpError(422, 'Receita inválida para item do carrinho.');
  }

  const recipeCost = calculateRecipeCost(state.ingredients, normalizedRecipe);
  if (recipeCost.missingIngredientIds.length > 0) {
    throw new HttpError(422, 'Receita com insumos ausentes para o carrinho.', {
      missingIngredientIds: recipeCost.missingIngredientIds,
    });
  }

  const unitPriceSnapshot = command.priceOverride ?? product.price;
  const note = normalizeOptionalNote(command.note);

  const mergeableItem = draft.items.find(
    (item) =>
      item.productId === product.id &&
      (item.unitPriceSnapshot ?? product.price) === unitPriceSnapshot &&
      normalizeOptionalNote(item.note) === note &&
      sameRecipe(item.recipe, normalizedRecipe)
  );

  if (mergeableItem) {
    mergeableItem.qty += quantity;
  } else {
    draft.items.push({
      id: createId('sdi'),
      productId: product.id,
      nameSnapshot: product.name,
      qty: quantity,
      unitPriceSnapshot,
      note,
      recipe: normalizedRecipe,
    });
  }

  draft.total = normalizeDraftTotal(draft);
  draft.updatedAt = toTimestampIso();
};

const applySaleDraftUpdateItem = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_UPDATE_ITEM' }>
) => {
  const draft = requireSaleDraft(state, command.draftId);
  ensureDraftStatus(draft, ['DRAFT'], 'Itens só podem ser alterados com o carrinho em DRAFT.');
  const item = draft.items.find((entry) => entry.id === command.itemId);
  if (!item) {
    throw new HttpError(404, 'Item do carrinho não encontrado.');
  }

  if (command.quantity !== undefined) {
    item.qty = command.quantity;
  }
  if (command.note !== undefined) {
    item.note = normalizeOptionalNote(command.note);
  }

  draft.total = normalizeDraftTotal(draft);
  draft.updatedAt = toTimestampIso();
};

const applySaleDraftRemoveItem = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_REMOVE_ITEM' }>
) => {
  const draft = requireSaleDraft(state, command.draftId);
  ensureDraftStatus(draft, ['DRAFT'], 'Itens só podem ser removidos com o carrinho em DRAFT.');
  const before = draft.items.length;
  draft.items = draft.items.filter((entry) => entry.id !== command.itemId);
  if (draft.items.length === before) {
    throw new HttpError(404, 'Item do carrinho não encontrado para remoção.');
  }

  draft.total = normalizeDraftTotal(draft);
  draft.updatedAt = toTimestampIso();
};

const applySaleDraftFinalize = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_FINALIZE' }>
) => {
  const startedAt = Date.now();
  const draft = requireSaleDraft(state, command.draftId);
  if (draft.status === 'PAID') {
    logStateCommandPerf('SALE_DRAFT_FINALIZE', {
      draftId: command.draftId,
      status: 'already_paid_noop',
      totalMs: Date.now() - startedAt,
    });
    return;
  }
  ensureDraftStatus(draft, ['DRAFT', 'PENDING_PAYMENT'], 'Não é possível finalizar esta venda.');
  if (draft.items.length === 0) {
    throw new HttpError(422, 'O carrinho está vazio.');
  }

  draft.total = normalizeDraftTotal(draft);
  const saleOrigin = normalizeSaleOrigin(command.saleOrigin ?? draft.saleOrigin);
  let appOrderTotal: number | null = null;

  if (isAppSaleOrigin(saleOrigin)) {
    appOrderTotal = normalizeAppOrderTotal(
      command.appOrderTotal ?? draft.appOrderTotal ?? draft.total
    );
    if (appOrderTotal === null) {
      throw new HttpError(422, 'Informe o valor real da venda no app antes de finalizar.');
    }
  }

  draft.saleOrigin = saleOrigin;
  draft.appOrderTotal = appOrderTotal;
  updateDraftPayment(
    draft,
    {
      method: command.paymentMethod,
      cashReceivedInput: command.cashReceived,
      splitMode: command.splitMode,
      splitCount: command.splitCount,
      splitPayments: command.splitPayments,
      amountDue: draft.appOrderTotal ?? draft.total,
    }
  );
  draft.status = 'PENDING_PAYMENT';
  draft.updatedAt = toTimestampIso();
  logStateCommandPerf('SALE_DRAFT_FINALIZE', {
    draftId: command.draftId,
    itemsCount: draft.items.length,
    saleOrigin,
    paymentMethod: command.paymentMethod,
    totalMs: Date.now() - startedAt,
  });
};

const applySaleDraftFinalizeAndConfirmPaid = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID' }>
) => {
  const startedAt = Date.now();

  applySaleDraftFinalize(state, {
    type: 'SALE_DRAFT_FINALIZE',
    draftId: command.draftId,
    paymentMethod: command.paymentMethod,
    cashReceived: command.cashReceived,
    saleOrigin: command.saleOrigin,
    appOrderTotal: command.appOrderTotal,
    splitMode: command.splitMode,
    splitCount: command.splitCount,
    splitPayments: command.splitPayments,
    commandId: command.commandId,
  });

  applySaleDraftConfirmPaid(state, {
    type: 'SALE_DRAFT_CONFIRM_PAID',
    draftId: command.draftId,
    commandId: command.commandId,
  });

  logStateCommandPerf('SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID', {
    draftId: command.draftId,
    paymentMethod: command.paymentMethod,
    totalMs: Date.now() - startedAt,
  });
};

const applySaleDraftConfirmPaid = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_CONFIRM_PAID' }>
) => {
  const startedAt = Date.now();
  const validationStartedAt = Date.now();
  const draft = requireSaleDraft(state, command.draftId);

  if (draft.status === 'PAID' || draft.stockDebited) {
    return;
  }

  if (draft.status === 'CANCELLED') {
    throw new HttpError(409, 'Venda cancelada não pode ser confirmada como paga.');
  }

  if (draft.status !== 'PENDING_PAYMENT') {
    throw new HttpError(409, 'Venda ainda não foi finalizada para pagamento.');
  }

  if (draft.items.length === 0) {
    throw new HttpError(422, 'O carrinho está vazio.');
  }

  draft.total = normalizeDraftTotal(draft);
  const saleOrigin = normalizeSaleOrigin(draft.saleOrigin);
  draft.saleOrigin = saleOrigin;
  draft.appOrderTotal = isAppSaleOrigin(saleOrigin)
    ? normalizeAppOrderTotal(draft.appOrderTotal ?? draft.total)
    : null;
  if (isAppSaleOrigin(saleOrigin) && draft.appOrderTotal === null) {
    throw new HttpError(422, 'Informe o valor real da venda no app antes de confirmar.');
  }
  const amountDue = draft.appOrderTotal ?? draft.total;

  const paymentMethod = draft.payment.method;
  if (!paymentMethod) {
    throw new HttpError(422, 'Forma de pagamento não selecionada.');
  }

  if (paymentMethod === 'DIVIDIDO') {
    const splitPlan = buildSplitPaymentPlan({
      splitMode: draft.payment.splitMode,
      splitCount: draft.payment.splitCount,
      splitPayments: draft.payment.splitPayments,
      amountDue,
    });
    draft.payment.splitMode = splitPlan.splitMode;
    draft.payment.splitCount = splitPlan.splitCount;
    draft.payment.splitPayments = splitPlan.splitPayments;
    draft.payment.cashReceived = splitPlan.totalCashReceived;
    draft.payment.change = splitPlan.totalCashChange;
  } else if (paymentMethod === 'DINHEIRO') {
    const cashReceived = draft.payment.cashReceived;
    if (cashReceived === null || !Number.isFinite(cashReceived)) {
      throw new HttpError(422, 'Informe o valor recebido em dinheiro antes de confirmar.');
    }
    if (cashReceived + Number.EPSILON < amountDue) {
      throw new HttpError(409, 'Valor em dinheiro insuficiente para confirmar pagamento.', {
        total: amountDue,
        cashReceived,
      });
    }
    draft.payment.change = roundMoney(cashReceived - amountDue);
    draft.payment.splitMode = null;
    draft.payment.splitCount = null;
    draft.payment.splitPayments = [];
  } else {
    draft.payment.cashReceived = null;
    draft.payment.change = null;
    draft.payment.splitMode = null;
    draft.payment.splitCount = null;
    draft.payment.splitPayments = [];
  }
  const validationMs = Date.now() - validationStartedAt;

  type PlannedDraftSale = {
    saleId: string;
    productId: string;
    productName: string;
    saleRecipe: FrontRecipeItem[];
    stockTotals: Record<string, number>;
    total: number;
    totalCost: number;
    basePrice: number;
    priceAdjustment: number;
    baseCost?: number;
  };

  const plannedSales: PlannedDraftSale[] = [];
  const consumptionByIngredient = new Map<string, number>();
  const planningStartedAt = Date.now();

  draft.items.forEach((item) => {
    const quantity = Math.max(1, item.qty);
    const saleRecipe = scaleRecipe(item.recipe, quantity);
    const saleCost = calculateRecipeCost(state.ingredients, saleRecipe);
    if (saleCost.missingIngredientIds.length > 0) {
      throw new HttpError(422, 'Receita com insumos ausentes ao confirmar pagamento.', {
        missingIngredientIds: saleCost.missingIngredientIds,
      });
    }

    const product = state.products.find((entry) => entry.id === item.productId);
    const unitBasePrice = product?.price ?? item.unitPriceSnapshot ?? 0;
    const unitFinalPrice = item.unitPriceSnapshot ?? unitBasePrice;
    const total = roundMoney(unitFinalPrice * quantity);
    const basePrice = roundMoney(unitBasePrice * quantity);
    const baseCostInfo = product ? calculateRecipeCost(state.ingredients, scaleRecipe(product.recipe, quantity)) : null;
    const baseCost =
      baseCostInfo && baseCostInfo.missingIngredientIds.length === 0
        ? roundMoney(baseCostInfo.totalCost)
        : undefined;

    Object.entries(saleCost.totals).forEach(([ingredientId, recipeQuantity]) => {
      const ingredient = requireIngredient(state, ingredientId);
      const stockQuantity = toStockQuantity(ingredient, recipeQuantity);
      const current = consumptionByIngredient.get(ingredientId) || 0;
      consumptionByIngredient.set(ingredientId, current + stockQuantity);
    });

    plannedSales.push({
      saleId: `${draft.id}-${item.id}`,
      productId: item.productId,
      productName: item.nameSnapshot || product?.name || item.productId,
      saleRecipe,
      stockTotals: saleCost.totals,
      total,
      totalCost: roundMoney(saleCost.totalCost),
      basePrice,
      priceAdjustment: roundMoney(total - basePrice),
      baseCost,
    });
  });
  const planningMs = Date.now() - planningStartedAt;

  const stockCheckStartedAt = Date.now();
  for (const [ingredientId, neededStock] of consumptionByIngredient.entries()) {
    const ingredient = requireIngredient(state, ingredientId);
    if (ingredient.currentStock + Number.EPSILON < neededStock) {
      throw new HttpError(409, `Estoque insuficiente para ${ingredient.name}.`, {
        ingredientId,
        required: neededStock,
        available: ingredient.currentStock,
      });
    }
  }
  const stockCheckMs = Date.now() - stockCheckStartedAt;

  if (draft.appOrderTotal !== null) {
    const allocatedTotals = allocateOrderTotalByWeight(
      plannedSales.map((plan) => plan.total),
      draft.appOrderTotal
    );

    plannedSales.forEach((plan, index) => {
      const nextTotal = allocatedTotals[index] ?? 0;
      plan.total = nextTotal;
      plan.priceAdjustment = roundMoney(nextTotal - plan.basePrice);
    });
  }

  const timestamp = toTimestampIso();
  const paymentSnapshot: FrontSalePayment = {
    method: draft.payment.method,
    cashReceived: draft.payment.cashReceived,
    change: draft.payment.change,
    confirmedAt: timestamp,
    splitMode: draft.payment.splitMode ?? null,
    splitCount: draft.payment.splitCount ?? null,
    splitPayments: (draft.payment.splitPayments || []).map((entry) => ({ ...entry })),
  };

  const mutationStartedAt = Date.now();
  plannedSales.forEach((plan) => {
    Object.entries(plan.stockTotals).forEach(([ingredientId, recipeQuantity]) => {
      const ingredient = requireIngredient(state, ingredientId);
      const stockQuantity = toStockQuantity(ingredient, recipeQuantity);

      state.ingredients = state.ingredients.map((entry) =>
        entry.id === ingredientId
          ? { ...entry, currentStock: Math.max(0, entry.currentStock - stockQuantity) }
          : entry
      );

      const updatedIngredient = requireIngredient(state, ingredientId);
      const entry: FrontStockEntry = {
        id: `st-sale-${plan.saleId}-${ingredientId}`,
        ingredientId,
        ingredientName: updatedIngredient.name,
        quantity: -stockQuantity,
        unitCost: updatedIngredient.cost,
        timestamp,
        source: 'SALE',
        saleId: plan.saleId,
      };
      pushIngredientMovement(state, entry);
    });

    const paidSale: FrontSale = {
      id: plan.saleId,
      productId: plan.productId,
      productName: plan.productName,
      timestamp,
      total: plan.total,
      totalCost: plan.totalCost,
      recipe: plan.saleRecipe,
      stockDebited: plan.saleRecipe,
      basePrice: plan.basePrice,
      priceAdjustment: plan.priceAdjustment,
      baseCost: plan.baseCost,
      status: 'PAID',
      payment: cloneSalePayment(paymentSnapshot),
      saleDraftId: draft.id,
      saleOrigin,
      appOrderTotal: draft.appOrderTotal,
    };
    state.sales.push(paidSale);
    state.globalSales.push(cloneSale(paidSale));
  });

  draft.status = 'PAID';
  draft.stockDebited = true;
  draft.payment.confirmedAt = timestamp;
  draft.updatedAt = timestamp;
  const mutationMs = Date.now() - mutationStartedAt;
  logStateCommandPerf('SALE_DRAFT_CONFIRM_PAID', {
    draftId: command.draftId,
    itemsCount: draft.items.length,
    plannedSales: plannedSales.length,
    ingredientsTouched: consumptionByIngredient.size,
    saleOrigin,
    paymentMethod,
    validationMs,
    planningMs,
    stockCheckMs,
    mutationMs,
    totalMs: Date.now() - startedAt,
  });
};

const applySaleDraftCancel = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_DRAFT_CANCEL' }>
) => {
  const draft = requireSaleDraft(state, command.draftId);
  if (draft.status === 'PAID') {
    throw new HttpError(409, 'Venda já paga não pode ser cancelada.');
  }
  if (draft.status === 'CANCELLED') {
    return;
  }

  draft.status = 'CANCELLED';
  draft.updatedAt = toTimestampIso();
};

const applySaleRegister = (state: FrontAppState, command: Extract<StateCommandInput, { type: 'SALE_REGISTER' }>) => {
  if (command.clientSaleId) {
    const alreadyRegistered =
      state.sales.some((sale) => sale.id === command.clientSaleId) ||
      state.globalSales.some((sale) => sale.id === command.clientSaleId);
    if (alreadyRegistered) {
      return;
    }
  }

  const product = state.products.find((entry) => entry.id === command.productId);
  if (!product) {
    throw new HttpError(404, 'Produto não encontrado para venda.');
  }

  const recipeToUse = normalizeRecipeItems(command.recipeOverride || product.recipe);

  const { totalCost, missingIngredientIds, totals } = calculateRecipeCost(state.ingredients, recipeToUse);
  if (Object.keys(totals).length === 0) {
    throw new HttpError(422, 'Receita inválida. Verifique os ingredientes.');
  }
  if (missingIngredientIds.length > 0) {
    throw new HttpError(422, 'Receita com insumos ausentes.', { missingIngredientIds });
  }

  for (const [ingredientId, requiredRecipeQuantity] of Object.entries(totals)) {
    const ingredient = requireIngredient(state, ingredientId);
    const requiredStockQuantity = toStockQuantity(ingredient, requiredRecipeQuantity);
    if (ingredient.currentStock + Number.EPSILON < requiredStockQuantity) {
      throw new HttpError(409, `Estoque insuficiente para ${ingredient.name}.`, {
        ingredientId,
        required: requiredStockQuantity,
        available: ingredient.currentStock,
      });
    }
  }

  const timestamp = toTimestampIso();
  const saleId = command.clientSaleId || createId('s');
  const finalPrice = command.priceOverride !== undefined ? command.priceOverride : product.price;
  const baseCostInfo = calculateRecipeCost(state.ingredients, product.recipe);
  const baseCost = baseCostInfo.missingIngredientIds.length > 0 ? undefined : baseCostInfo.totalCost;
  const stockDebited = Object.entries(totals).map(([ingredientId, quantity]) => ({
    ingredientId,
    quantity,
  }));

  const newSale: FrontSale = {
    id: saleId,
    productId: product.id,
    productName: product.name,
    timestamp,
    total: finalPrice,
    totalCost,
    recipe: recipeToUse,
    stockDebited,
    basePrice: product.price,
    priceAdjustment: finalPrice - product.price,
    baseCost,
    status: 'PAID',
    saleOrigin: 'LOCAL',
    appOrderTotal: null,
  };

  Object.entries(totals).forEach(([ingredientId, quantity]) => {
    const ingredient = requireIngredient(state, ingredientId);
    const stockQuantity = toStockQuantity(ingredient, quantity);
    state.ingredients = state.ingredients.map((ingredient) =>
      ingredient.id === ingredientId
        ? { ...ingredient, currentStock: Math.max(0, ingredient.currentStock - stockQuantity) }
        : ingredient
    );

    const updatedIngredient = requireIngredient(state, ingredientId);
    const entry: FrontStockEntry = {
      id: `st-sale-${saleId}-${ingredientId}`,
      ingredientId,
      ingredientName: updatedIngredient.name,
      quantity: -stockQuantity,
      unitCost: updatedIngredient.cost,
      timestamp,
      source: 'SALE',
      saleId,
    };
    pushIngredientMovement(state, entry);
  });

  state.sales.push(newSale);
  state.globalSales.push({ ...newSale });
};

const applySaleEditById = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SALE_EDIT_BY_ID' }>
) => {
  const saleIndex = state.sales.map((sale) => sale.id).lastIndexOf(command.saleId);
  if (saleIndex < 0) {
    throw new HttpError(404, 'Venda não encontrada para edição.');
  }

  const targetSale = state.sales[saleIndex];
  if (targetSale.status && targetSale.status !== 'PAID') {
    throw new HttpError(409, 'Apenas vendas pagas podem ser editadas.', {
      saleId: targetSale.id,
      status: targetSale.status,
    });
  }

  const targetDraftId = typeof targetSale.saleDraftId === 'string' ? targetSale.saleDraftId.trim() : '';
  const targetSales =
    targetDraftId.length > 0
      ? state.sales.filter((sale) => {
          const saleDraftId = typeof sale.saleDraftId === 'string' ? sale.saleDraftId.trim() : '';
          return saleDraftId === targetDraftId;
        })
      : [targetSale];

  if (targetSales.length === 0) {
    throw new HttpError(404, 'Pedido não encontrado para edição.');
  }

  const currentOrderTotal = roundMoney(
    targetSales.reduce((sum, sale) => sum + (Number.isFinite(Number(sale.total)) ? Number(sale.total) : 0), 0)
  );
  const orderTotalOverride = command.orderTotal;
  const hasOrderTotalOverride = orderTotalOverride !== undefined;
  const orderTotal = hasOrderTotalOverride ? roundMoney(orderTotalOverride) : currentOrderTotal;
  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    throw new HttpError(422, 'Valor total inválido para edição da venda.', {
      orderTotal: command.orderTotal,
    });
  }

  const currentPayment = normalizeSalePayment(targetSale.payment);
  const confirmedAt = currentPayment.confirmedAt ?? targetSale.timestamp ?? toTimestampIso();

  let paymentSnapshot: FrontSalePayment;
  if (command.paymentMethod === 'DIVIDIDO') {
    const splitPlan = buildSplitPaymentPlan({
      splitMode: command.splitMode ?? currentPayment.splitMode,
      splitCount: command.splitCount ?? currentPayment.splitCount,
      splitPayments: command.splitPayments ?? currentPayment.splitPayments,
      amountDue: orderTotal,
    });

    paymentSnapshot = {
      method: 'DIVIDIDO',
      cashReceived: splitPlan.totalCashReceived,
      change: splitPlan.totalCashChange,
      confirmedAt,
      splitMode: splitPlan.splitMode,
      splitCount: splitPlan.splitCount,
      splitPayments: splitPlan.splitPayments,
    };
  } else if (command.paymentMethod === 'DINHEIRO') {
    const resolvedCashRaw =
      command.cashReceived !== undefined
        ? command.cashReceived
        : currentPayment.method === 'DINHEIRO'
          ? currentPayment.cashReceived
          : null;
    if (resolvedCashRaw === null || !Number.isFinite(resolvedCashRaw)) {
      throw new HttpError(422, 'Informe o valor recebido em dinheiro para editar esta venda.');
    }
    const resolvedCash = roundMoney(resolvedCashRaw);
    if (resolvedCash + Number.EPSILON < orderTotal) {
      throw new HttpError(409, 'Valor em dinheiro insuficiente para editar esta venda.', {
        total: orderTotal,
        cashReceived: resolvedCash,
      });
    }

    paymentSnapshot = {
      method: 'DINHEIRO',
      cashReceived: resolvedCash,
      change: roundMoney(resolvedCash - orderTotal),
      confirmedAt,
      splitMode: null,
      splitCount: null,
      splitPayments: [],
    };
  } else {
    paymentSnapshot = {
      method: command.paymentMethod,
      cashReceived: null,
      change: null,
      confirmedAt,
      splitMode: null,
      splitCount: null,
      splitPayments: [],
    };
  }

  const lineTotals = hasOrderTotalOverride
    ? allocateOrderTotalByWeight(
        targetSales.map((sale) => {
          const value = Number(sale.total);
          return Number.isFinite(value) && value > 0 ? value : 0;
        }),
        orderTotal
      )
    : targetSales.map((sale) => roundMoney(Number(sale.total) || 0));
  const orderSaleIds = new Set(targetSales.map((sale) => sale.id));
  const totalBySaleId = new Map<string, number>();
  targetSales.forEach((sale, index) => {
    totalBySaleId.set(sale.id, lineTotals[index] ?? 0);
  });

  const applyEdit = (sale: FrontSale): FrontSale => {
    if (!orderSaleIds.has(sale.id)) return sale;
    const nextTotal = totalBySaleId.get(sale.id) ?? roundMoney(Number(sale.total) || 0);
    const basePrice = Number(sale.basePrice);
    const nextPriceAdjustment =
      hasOrderTotalOverride && Number.isFinite(basePrice)
        ? roundMoney(nextTotal - basePrice)
        : sale.priceAdjustment;
    const normalizedOrigin = normalizeSaleOrigin(sale.saleOrigin);
    const nextAppOrderTotal = isAppSaleOrigin(normalizedOrigin)
      ? hasOrderTotalOverride
        ? orderTotal
        : normalizeAppOrderTotal(sale.appOrderTotal ?? orderTotal)
      : sale.appOrderTotal ?? null;

    return {
      ...sale,
      status: 'PAID',
      total: nextTotal,
      priceAdjustment: nextPriceAdjustment,
      payment: cloneSalePayment(paymentSnapshot),
      appOrderTotal: nextAppOrderTotal,
    };
  };

  if (targetDraftId.length > 0) {
    const editedDraft = (state.saleDrafts || []).find((draft) => draft.id === targetDraftId);
    if (editedDraft) {
      const draftOrigin = normalizeSaleOrigin(editedDraft.saleOrigin ?? targetSale.saleOrigin);
      const draftAppOrderTotal = isAppSaleOrigin(draftOrigin)
        ? hasOrderTotalOverride
          ? orderTotal
          : normalizeAppOrderTotal(
              editedDraft.appOrderTotal ?? targetSale.appOrderTotal ?? orderTotal
            )
        : null;

      editedDraft.saleOrigin = draftOrigin;
      editedDraft.total = orderTotal;
      editedDraft.appOrderTotal = draftAppOrderTotal;
      editedDraft.payment = normalizeSalePayment(paymentSnapshot);
      editedDraft.status = 'PAID';
      editedDraft.stockDebited = true;
      editedDraft.updatedAt = toTimestampIso();

      if (hasOrderTotalOverride) {
        editedDraft.items = editedDraft.items.map((item) => {
          const lineSaleId = `${editedDraft.id}-${item.id}`;
          const lineTotal = totalBySaleId.get(lineSaleId);
          if (lineTotal === undefined) return item;
          const qty = Number.isFinite(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1;
          return {
            ...item,
            unitPriceSnapshot: roundMoney(lineTotal / qty),
          };
        });
      }
    }
  }

  state.sales = state.sales.map(applyEdit);
  state.globalSales = state.globalSales.map(applyEdit);
};

const applyUndoSaleById = (state: FrontAppState, saleId: string) => {
  const saleIndex = state.sales.map((sale) => sale.id).lastIndexOf(saleId);
  if (saleIndex < 0) {
    throw new HttpError(404, 'Venda não encontrada para desfazer.');
  }

  const targetSale = state.sales[saleIndex];
  const recipeToRestore = targetSale.stockDebited || targetSale.recipe;
  const totals = recipeToRestore ? aggregateRecipe(recipeToRestore) : {};
  const saleMovementTotals = state.stockEntries.reduce<Record<string, number>>((acc, entry) => {
    if (entry.saleId !== targetSale.id || entry.source !== 'SALE') {
      return acc;
    }
    acc[entry.ingredientId] = (acc[entry.ingredientId] || 0) + Math.max(0, -entry.quantity);
    return acc;
  }, {});
  const autoReplenishmentTotals = state.stockEntries.reduce<Record<string, number>>((acc, entry) => {
    if (entry.saleId !== targetSale.id || entry.source !== 'AUTO_REPLENISH') {
      return acc;
    }
    acc[entry.ingredientId] = (acc[entry.ingredientId] || 0) + entry.quantity;
    return acc;
  }, {});

  if (
    Object.keys(totals).length > 0 ||
    Object.keys(saleMovementTotals).length > 0 ||
    Object.keys(autoReplenishmentTotals).length > 0
  ) {
    state.ingredients = state.ingredients.map((ingredient) => {
      const restoredRecipeQuantity = totals[ingredient.id] || 0;
      const restoredStockQuantity =
        saleMovementTotals[ingredient.id] ??
        toStockQuantity(ingredient, restoredRecipeQuantity);
      const autoReplenished = autoReplenishmentTotals[ingredient.id] || 0;
      if (restoredStockQuantity === 0 && autoReplenished === 0) return ingredient;
      return {
        ...ingredient,
        currentStock: Math.max(0, ingredient.currentStock + restoredStockQuantity - autoReplenished),
      };
    });
  }

  state.sales = state.sales.filter((_sale, index) => index !== saleIndex);
  state.stockEntries = state.stockEntries.filter((entry) => entry.saleId !== targetSale.id);
  state.globalStockEntries = state.globalStockEntries.filter((entry) => entry.saleId !== targetSale.id);

  const globalIndex = state.globalSales.map((sale) => sale.id).lastIndexOf(targetSale.id);
  if (globalIndex >= 0) {
    state.globalSales = state.globalSales.filter((_sale, index) => index !== globalIndex);
  }
  state.globalCancelledSales.push({ ...targetSale });
};

const applyUndoLastSale = (state: FrontAppState) => {
  if (state.sales.length === 0) {
    throw new HttpError(404, 'Nenhuma venda para desfazer.');
  }

  const lastSale = state.sales[state.sales.length - 1];
  const draftId = lastSale.saleDraftId;
  if (!draftId) {
    applyUndoSaleById(state, lastSale.id);
    return;
  }

  const draftSaleIds = state.sales
    .filter((sale) => sale.saleDraftId === draftId)
    .map((sale) => sale.id);

  if (draftSaleIds.length <= 1) {
    applyUndoSaleById(state, lastSale.id);
    return;
  }

  draftSaleIds
    .slice()
    .reverse()
    .forEach((saleId) => {
      applyUndoSaleById(state, saleId);
    });
};

const applyIngredientStockMove = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'INGREDIENT_STOCK_MOVE' }>
) => {
  const ingredient = requireIngredient(state, command.ingredientId);
  const appliedAmount = getAppliedStockDelta(ingredient.currentStock, command.amount);
  if (appliedAmount === 0) {
    throw new HttpError(409, 'Estoque insuficiente para baixa.', {
      ingredientId: command.ingredientId,
      requested: Math.abs(command.amount),
      available: ingredient.currentStock,
    });
  }

  const timestamp = toTimestampIso();
  state.ingredients = state.ingredients.map((entry) =>
    entry.id === command.ingredientId
      ? { ...entry, currentStock: Math.max(0, entry.currentStock + appliedAmount) }
      : entry
  );

  const updatedIngredient = requireIngredient(state, command.ingredientId);
  const shouldDebitCashRegister = appliedAmount > 0 && command.useCashRegister === true;
  let cashRegisterImpact = 0;
  const purchaseDescription =
    shouldDebitCashRegister && command.purchaseDescription
      ? normalizeOptionalNote(command.purchaseDescription)
      : undefined;

  if (shouldDebitCashRegister) {
    const purchaseCost = roundMoney(appliedAmount * updatedIngredient.cost);
    const availableCash = toNonNegativeMoney(state.cashRegisterAmount);
    if (purchaseCost > availableCash + Number.EPSILON) {
      throw new HttpError(409, 'Caixa insuficiente para registrar compra de insumo.', {
        availableCash,
        purchaseCost,
        ingredientId: command.ingredientId,
      });
    }
    state.cashRegisterAmount = roundMoney(availableCash - purchaseCost);
    cashRegisterImpact = roundMoney(-purchaseCost);
  }

  const entry: FrontStockEntry = {
    id: createId('st'),
    ingredientId: command.ingredientId,
    ingredientName: updatedIngredient.name,
    quantity: appliedAmount,
    unitCost: updatedIngredient.cost,
    timestamp,
    source: 'MANUAL',
    paidWithCashRegister: shouldDebitCashRegister,
    cashRegisterImpact: cashRegisterImpact === 0 ? undefined : cashRegisterImpact,
    purchaseDescription,
  };
  pushIngredientMovement(state, entry);
};

const applyCashExpense = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'CASH_EXPENSE' }>
) => {
  const amount = roundMoney(command.amount);
  if (amount <= 0) {
    throw new HttpError(409, 'Valor inválido para saída do caixa.');
  }

  const availableCash = toNonNegativeMoney(state.cashRegisterAmount);
  if (amount > availableCash + Number.EPSILON) {
    throw new HttpError(409, 'Caixa insuficiente para registrar saída.', {
      availableCash,
      amount,
    });
  }

  const purchaseDescription = normalizeOptionalNote(command.purchaseDescription);
  if (!purchaseDescription) {
    throw new HttpError(409, 'Descrição da saída é obrigatória.');
  }

  state.cashRegisterAmount = roundMoney(availableCash - amount);

  const entry: FrontStockEntry = {
    id: createId('st'),
    ingredientId: 'cash-expense',
    ingredientName: 'OUTROS',
    quantity: 0,
    timestamp: toTimestampIso(),
    source: 'MANUAL',
    paidWithCashRegister: true,
    cashRegisterImpact: roundMoney(-amount),
    purchaseDescription,
  };
  pushIngredientMovement(state, entry);
};

const applyCashExpenseRevert = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'CASH_EXPENSE_REVERT' }>
) => {
  const targetEntry = state.stockEntries.find((entry) => entry.id === command.entryId);
  if (!targetEntry) {
    throw new HttpError(404, 'Retirada do caixa não encontrada para reversão.');
  }

  const impact = Number(targetEntry.cashRegisterImpact);
  if (!Number.isFinite(impact) || impact >= 0) {
    throw new HttpError(409, 'Movimentação informada não é uma retirada paga com caixa.');
  }

  if (targetEntry.ingredientId !== 'cash-expense' && targetEntry.quantity > 0) {
    const ingredient = state.ingredients.find((entry) => entry.id === targetEntry.ingredientId);
    if (ingredient) {
      if (ingredient.currentStock + Number.EPSILON < targetEntry.quantity) {
        throw new HttpError(409, 'Estoque insuficiente para reverter esta compra do caixa.', {
          ingredientId: ingredient.id,
          available: ingredient.currentStock,
          required: targetEntry.quantity,
        });
      }

      state.ingredients = state.ingredients.map((entry) =>
        entry.id === ingredient.id
          ? { ...entry, currentStock: Math.max(0, entry.currentStock - targetEntry.quantity) }
          : entry
      );
    }
  }

  const refundAmount = roundMoney(Math.abs(impact));
  const availableCash = toNonNegativeMoney(state.cashRegisterAmount);
  state.cashRegisterAmount = roundMoney(availableCash + refundAmount);

  state.stockEntries = state.stockEntries.filter((entry) => entry.id !== command.entryId);
  state.globalStockEntries = state.globalStockEntries.filter((entry) => entry.id !== command.entryId);
};

const applyCleaningStockMove = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'CLEANING_STOCK_MOVE' }>
) => {
  const material = requireMaterial(state, command.materialId);
  const appliedAmount = getAppliedStockDelta(material.currentStock, command.amount);
  if (appliedAmount === 0) {
    throw new HttpError(409, 'Estoque de material insuficiente para baixa.', {
      materialId: command.materialId,
      requested: Math.abs(command.amount),
      available: material.currentStock,
    });
  }

  const timestamp = toTimestampIso();
  state.cleaningMaterials = state.cleaningMaterials.map((entry) =>
    entry.id === command.materialId
      ? { ...entry, currentStock: Math.max(0, entry.currentStock + appliedAmount) }
      : entry
  );

  const updatedMaterial = requireMaterial(state, command.materialId);
  const entry: FrontCleaningStockEntry = {
    id: createId('cst'),
    materialId: command.materialId,
    materialName: updatedMaterial.name,
    quantity: appliedAmount,
    unitCost: updatedMaterial.cost,
    timestamp,
  };
  pushCleaningMovement(state, entry);
};

const applySetCashRegister = (
  state: FrontAppState,
  command: Extract<StateCommandInput, { type: 'SET_CASH_REGISTER' }>
) => {
  state.cashRegisterAmount = toNonNegativeMoney(command.amount);
};

const applyCloseDay = (state: FrontAppState) => {
  const totalRevenue = roundMoney(
    state.sales.reduce((sum, sale) => sum + (Number.isFinite(sale.total) ? sale.total : 0), 0)
  );
  const totalPurchases = roundMoney(
    state.sales.reduce((sum, sale) => sum + (Number.isFinite(sale.totalCost) ? sale.totalCost : 0), 0)
  );
  const ingredientUnitById = new Map(
    state.ingredients.map((ingredient): [string, string] => [ingredient.id, ingredient.unit])
  );
  const cashExpenseDetails: FrontCashRegisterExpenseDetail[] = state.stockEntries
    .filter((entry) => {
      const impact = Number(entry.cashRegisterImpact);
      return Number.isFinite(impact) && impact < 0;
    })
    .map((entry): FrontCashRegisterExpenseDetail => {
      const impact = Number(entry.cashRegisterImpact);
      const amount = roundMoney(Math.abs(impact));
      const isOtherExpense = entry.ingredientId === 'cash-expense' || Number(entry.quantity) === 0;
      const expenseType: FrontCashRegisterExpenseDetail['expenseType'] = isOtherExpense
        ? 'OTHER'
        : 'INGREDIENT';
      const quantity = Number(entry.quantity);
      const ingredientUnit = entry.ingredientId
        ? ingredientUnitById.get(entry.ingredientId)
        : undefined;
      return {
        entryId: entry.id,
        timestamp: entry.timestamp,
        amount,
        expenseType,
        ingredientId: isOtherExpense ? undefined : entry.ingredientId,
        ingredientName: isOtherExpense ? undefined : entry.ingredientName,
        ingredientUnit: isOtherExpense ? undefined : ingredientUnit,
        quantity:
          !isOtherExpense && Number.isFinite(quantity) && quantity > 0
            ? Number(quantity.toFixed(6))
            : undefined,
        purchaseDescription: entry.purchaseDescription,
      };
    })
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const cashExpenses = roundMoney(
    state.stockEntries.reduce((sum, entry) => {
      const impact = Number(entry.cashRegisterImpact);
      if (!Number.isFinite(impact) || impact >= 0) return sum;
      return sum + Math.abs(impact);
    }, 0)
  );
  const openingCash = toNonNegativeMoney(state.cashRegisterAmount);
  const closedAt = toTimestampIso();
  const report: FrontDailySalesHistoryEntry = {
    id: createId('day'),
    closedAt,
    businessDate: resolveSessionBusinessDate(state, closedAt),
    openingCash,
    totalRevenue,
    totalPurchases,
    totalProfit: roundMoney(totalRevenue - totalPurchases),
    saleCount: state.sales.length,
    cashExpenses,
    cashExpenseDetails,
  };

  const history = ensureDailySalesHistory(state);
  history.push(report);
  state.dailySalesHistory = history;
  state.sales = [];
  state.stockEntries = [];
  state.saleDrafts = [];
  state.cashRegisterAmount = 0;
};

const ensureUniqueId = (
  state: FrontAppState,
  field: 'ingredient' | 'product' | 'material',
  id: string
) => {
  if (field === 'ingredient' && state.ingredients.some((entry) => entry.id === id)) {
    throw new HttpError(409, `Já existe um insumo com id ${id}.`);
  }
  if (field === 'product' && state.products.some((entry) => entry.id === id)) {
    throw new HttpError(409, `Já existe um produto com id ${id}.`);
  }
  if (field === 'material' && state.cleaningMaterials.some((entry) => entry.id === id)) {
    throw new HttpError(409, `Já existe um material com id ${id}.`);
  }
};

export const applyStateCommand = (
  currentState: FrontAppState,
  command: StateCommandInput,
  options?: { mutateInPlace?: boolean }
): FrontAppState => {
  const state = options?.mutateInPlace ? currentState : cloneState(currentState);

  switch (command.type) {
    case 'SALE_REGISTER':
      applySaleRegister(state, command);
      return state;
    case 'SALE_DRAFT_CREATE':
      applySaleDraftCreate(state, command);
      return state;
    case 'SALE_DRAFT_SET_CUSTOMER_TYPE':
      applySaleDraftSetCustomerType(state, command);
      return state;
    case 'SALE_DRAFT_ADD_ITEM':
      applySaleDraftAddItem(state, command);
      return state;
    case 'SALE_DRAFT_UPDATE_ITEM':
      applySaleDraftUpdateItem(state, command);
      return state;
    case 'SALE_DRAFT_REMOVE_ITEM':
      applySaleDraftRemoveItem(state, command);
      return state;
    case 'SALE_DRAFT_FINALIZE':
      applySaleDraftFinalize(state, command);
      return state;
    case 'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID':
      applySaleDraftFinalizeAndConfirmPaid(state, command);
      return state;
    case 'SALE_DRAFT_CONFIRM_PAID':
      applySaleDraftConfirmPaid(state, command);
      return state;
    case 'SALE_DRAFT_CANCEL':
      applySaleDraftCancel(state, command);
      return state;
    case 'SALE_UNDO_LAST':
      applyUndoLastSale(state);
      return state;
    case 'SALE_UNDO_BY_ID':
      applyUndoSaleById(state, command.saleId);
      return state;
    case 'SALE_EDIT_BY_ID':
      applySaleEditById(state, command);
      return state;
    case 'INGREDIENT_STOCK_MOVE':
      applyIngredientStockMove(state, command);
      return state;
    case 'CASH_EXPENSE':
      applyCashExpense(state, command);
      return state;
    case 'CASH_EXPENSE_REVERT':
      applyCashExpenseRevert(state, command);
      return state;
    case 'INGREDIENT_CREATE':
      ensureUniqueId(state, 'ingredient', command.ingredient.id);
      state.ingredients.push({ ...command.ingredient });
      return state;
    case 'INGREDIENT_UPDATE':
      if (!state.ingredients.some((entry) => entry.id === command.ingredient.id)) {
        throw new HttpError(404, 'Insumo não encontrado para atualização.');
      }
      state.ingredients = state.ingredients.map((entry) =>
        entry.id === command.ingredient.id ? { ...command.ingredient } : entry
      );
      return state;
    case 'INGREDIENT_DELETE':
      if (!state.ingredients.some((entry) => entry.id === command.ingredientId)) {
        throw new HttpError(404, 'Insumo não encontrado para remoção.');
      }
      state.ingredients = state.ingredients.filter((entry) => entry.id !== command.ingredientId);
      state.products = state.products.map((product) => ({
        ...product,
        recipe: product.recipe.filter((item) => item.ingredientId !== command.ingredientId),
      }));
      return state;
    case 'PRODUCT_CREATE':
      ensureUniqueId(state, 'product', command.product.id);
      state.products.push({
        ...command.product,
        recipe: normalizeRecipeItems(command.product.recipe),
        comboItems: command.product.comboItems?.map((item) => ({ ...item })),
      });
      return state;
    case 'PRODUCT_UPDATE':
      if (!state.products.some((entry) => entry.id === command.product.id)) {
        throw new HttpError(404, 'Produto não encontrado para atualização.');
      }
      state.products = state.products.map((entry) =>
        entry.id === command.product.id
          ? {
              ...command.product,
              recipe: normalizeRecipeItems(command.product.recipe),
              comboItems: command.product.comboItems?.map((item) => ({ ...item })),
            }
          : entry
      );
      return state;
    case 'PRODUCT_DELETE':
      if (!state.products.some((entry) => entry.id === command.productId)) {
        throw new HttpError(404, 'Produto não encontrado para remoção.');
      }
      state.products = state.products.filter((entry) => entry.id !== command.productId);
      return state;
    case 'CLEANING_MATERIAL_CREATE':
      ensureUniqueId(state, 'material', command.material.id);
      state.cleaningMaterials.push({ ...command.material });
      return state;
    case 'CLEANING_MATERIAL_UPDATE':
      if (!state.cleaningMaterials.some((entry) => entry.id === command.material.id)) {
        throw new HttpError(404, 'Material de limpeza não encontrado para atualização.');
      }
      state.cleaningMaterials = state.cleaningMaterials.map((entry) =>
        entry.id === command.material.id ? { ...command.material } : entry
      );
      return state;
    case 'CLEANING_MATERIAL_DELETE':
      if (!state.cleaningMaterials.some((entry) => entry.id === command.materialId)) {
        throw new HttpError(404, 'Material de limpeza não encontrado para remoção.');
      }
      state.cleaningMaterials = state.cleaningMaterials.filter(
        (entry) => entry.id !== command.materialId
      );
      return state;
    case 'CLEANING_STOCK_MOVE':
      applyCleaningStockMove(state, command);
      return state;
    case 'SET_CASH_REGISTER':
      applySetCashRegister(state, command);
      return state;
    case 'CLOSE_DAY':
      applyCloseDay(state);
      return state;
    case 'CLEAR_HISTORY':
      state.sales = [];
      state.stockEntries = [];
      state.saleDrafts = [];
      state.cashRegisterAmount = 0;
      return state;
    case 'FACTORY_RESET':
      return emptyAppState();
    case 'CLEAR_OPERATIONAL_DATA':
      state.sales = [];
      state.stockEntries = [];
      state.cleaningStockEntries = [];
      state.globalSales = [];
      state.globalCancelledSales = [];
      state.globalStockEntries = [];
      state.globalCleaningStockEntries = [];
      state.saleDrafts = [];
      state.cashRegisterAmount = 0;
      state.dailySalesHistory = [];
      return state;
    case 'CLEAR_ONLY_STOCK':
      state.ingredients = state.ingredients.map((ingredient) => ({ ...ingredient, currentStock: 0 }));
      state.cleaningMaterials = state.cleaningMaterials.map((material) => ({
        ...material,
        currentStock: 0,
      }));
      return state;
    case 'DELETE_ARCHIVE_SALES': {
      const ids = new Set(command.saleIds);
      state.globalSales = state.globalSales.filter((sale) => !ids.has(sale.id));
      return state;
    }
    default: {
      const exhaustiveCheck: never = command;
      throw new HttpError(400, `Comando de estado não suportado: ${String(exhaustiveCheck)}`);
    }
  }
};

const ARCHIVE_MUTATING_COMMAND_TYPES = new Set<StateCommandInput['type']>([
  'SALE_REGISTER',
  'SALE_DRAFT_CONFIRM_PAID',
  'SALE_DRAFT_FINALIZE_AND_CONFIRM_PAID',
  'SALE_UNDO_LAST',
  'SALE_UNDO_BY_ID',
  'SALE_EDIT_BY_ID',
  'INGREDIENT_STOCK_MOVE',
  'CASH_EXPENSE',
  'CASH_EXPENSE_REVERT',
  'CLEANING_STOCK_MOVE',
  'CLOSE_DAY',
  'FACTORY_RESET',
  'CLEAR_OPERATIONAL_DATA',
  'DELETE_ARCHIVE_SALES',
]);

export const commandTouchesArchiveState = (
  commandType: StateCommandInput['type']
): boolean => ARCHIVE_MUTATING_COMMAND_TYPES.has(commandType);
