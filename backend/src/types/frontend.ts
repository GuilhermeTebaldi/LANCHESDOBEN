export interface FrontIngredient {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number;
  autoReplenishEnabled?: boolean;
  autoReplenishQuantity?: number;
  imageUrl?: string;
  addonPrice?: number;
  icon?: string;
}

export interface FrontStockEntry {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  timestamp: Date | string;
  unitCost?: number;
  source?: 'MANUAL' | 'SALE' | 'AUTO_REPLENISH';
  saleId?: string;
  paidWithCashRegister?: boolean;
  cashRegisterImpact?: number;
  purchaseDescription?: string;
}

export type FrontCashRegisterExpenseType = 'INGREDIENT' | 'OTHER';

export interface FrontCashRegisterExpenseDetail {
  entryId: string;
  timestamp: Date | string;
  amount: number;
  expenseType: FrontCashRegisterExpenseType;
  ingredientId?: string;
  ingredientName?: string;
  ingredientUnit?: string;
  quantity?: number;
  purchaseDescription?: string;
}

export interface FrontCleaningMaterial {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number;
  imageUrl?: string;
}

export interface FrontCleaningStockEntry {
  id: string;
  materialId: string;
  materialName: string;
  quantity: number;
  timestamp: Date | string;
  unitCost?: number;
}

export interface FrontRecipeItem {
  ingredientId: string;
  quantity: number;
}

export interface FrontComboItem {
  productId: string;
  quantity: number;
}

export type FrontSaleStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED';
export type FrontSaleBasePaymentMethod = 'PIX' | 'DEBITO' | 'CREDITO' | 'DINHEIRO';
export type FrontSalePaymentMethod = FrontSaleBasePaymentMethod | 'DIVIDIDO';
export type FrontSalePaymentSplitMode = 'PEOPLE' | 'MIXED';
export type FrontSaleCustomerType = 'BALCAO' | 'ENTREGA';
export type FrontSaleOrigin = 'LOCAL' | 'IFOOD' | 'APP99' | 'KEETA';

export interface FrontSalePaymentSplitEntry {
  sequence: number;
  label: string;
  method: FrontSaleBasePaymentMethod;
  amount: number;
  cashReceived: number | null;
  change: number | null;
}

export interface FrontSalePayment {
  method: FrontSalePaymentMethod | null;
  cashReceived: number | null;
  change: number | null;
  confirmedAt: Date | string | null;
  splitMode?: FrontSalePaymentSplitMode | null;
  splitCount?: number | null;
  splitPayments?: FrontSalePaymentSplitEntry[];
}

export interface FrontSaleDraftItem {
  id: string;
  productId: string;
  nameSnapshot?: string;
  qty: number;
  unitPriceSnapshot?: number;
  note?: string;
  recipe: FrontRecipeItem[];
}

export interface FrontSaleDraft {
  id: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  items: FrontSaleDraftItem[];
  total: number;
  customerType?: FrontSaleCustomerType;
  saleOrigin?: FrontSaleOrigin;
  appOrderTotal?: number | null;
  status: FrontSaleStatus;
  payment: FrontSalePayment;
  stockDebited: boolean;
}

export interface FrontProduct {
  id: string;
  name: string;
  price: number;
  imageUrl: string;
  category: 'Snack' | 'Drink' | 'Side' | 'Combo';
  recipe: FrontRecipeItem[];
  comboItems?: FrontComboItem[];
}

export interface FrontSale {
  id: string;
  productId: string;
  productName: string;
  timestamp: Date | string;
  total: number;
  totalCost: number;
  recipe?: FrontRecipeItem[];
  stockDebited?: FrontRecipeItem[];
  basePrice?: number;
  priceAdjustment?: number;
  baseCost?: number;
  status?: FrontSaleStatus;
  payment?: FrontSalePayment;
  saleDraftId?: string;
  saleOrigin?: FrontSaleOrigin;
  appOrderTotal?: number | null;
}

export interface FrontDailySalesHistoryEntry {
  id: string;
  closedAt: Date | string;
  businessDate?: string;
  openingCash: number;
  totalRevenue: number;
  totalPurchases: number;
  totalProfit: number;
  saleCount: number;
  cashExpenses?: number;
  cashExpenseDetails?: FrontCashRegisterExpenseDetail[];
}

export interface FrontAppState {
  ingredients: FrontIngredient[];
  products: FrontProduct[];
  sales: FrontSale[];
  stockEntries: FrontStockEntry[];
  cleaningMaterials: FrontCleaningMaterial[];
  cleaningStockEntries: FrontCleaningStockEntry[];
  globalSales: FrontSale[];
  globalCancelledSales: FrontSale[];
  globalStockEntries: FrontStockEntry[];
  globalCleaningStockEntries: FrontCleaningStockEntry[];
  saleDrafts?: FrontSaleDraft[];
  cashRegisterAmount?: number;
  dailySalesHistory?: FrontDailySalesHistoryEntry[];
}
