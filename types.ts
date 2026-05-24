
export interface Ingredient {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number; // Preço de custo por unidade/unidade de medida
  autoReplenishEnabled?: boolean;
  autoReplenishQuantity?: number;
  imageUrl?: string;
  addonPrice?: number; // Preço cobrado por unidade/unidade de medida como adicional
  icon?: string;
}

export interface StockEntry {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  timestamp: Date;
  unitCost?: number; // custo do insumo no momento da movimentação
  source?: 'MANUAL' | 'SALE' | 'AUTO_REPLENISH';
  saleId?: string;
  paidWithCashRegister?: boolean;
  cashRegisterImpact?: number;
  purchaseDescription?: string;
}

export type CashRegisterExpenseType = 'INGREDIENT' | 'OTHER';

export interface CashRegisterExpenseDetail {
  entryId: string;
  timestamp: Date | string;
  amount: number;
  expenseType: CashRegisterExpenseType;
  ingredientId?: string;
  ingredientName?: string;
  ingredientUnit?: string;
  quantity?: number;
  purchaseDescription?: string;
}

export interface CleaningMaterial {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number;
  imageUrl?: string;
}

export interface CleaningStockEntry {
  id: string;
  materialId: string;
  materialName: string;
  quantity: number;
  timestamp: Date;
  unitCost?: number;
}

export interface RecipeItem {
  ingredientId: string;
  quantity: number;
}

export interface ComboItem {
  productId: string;
  quantity: number;
}

export type SaleStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED';
export type SaleBasePaymentMethod = 'PIX' | 'DEBITO' | 'CREDITO' | 'DINHEIRO';
export type SalePaymentMethod = SaleBasePaymentMethod | 'DIVIDIDO';
export type SalePaymentSplitMode = 'PEOPLE' | 'MIXED';
export type SaleCustomerType = 'BALCAO' | 'ENTREGA';
export type SaleOrigin = 'LOCAL' | 'IFOOD' | 'APP99' | 'KEETA';

export interface BusinessSettings {
  infiniteStockEnabled: boolean;
  ignoreStockCosts: boolean;
}

export interface SalePaymentSplitEntry {
  sequence: number;
  label: string;
  method: SaleBasePaymentMethod;
  amount: number;
  cashReceived: number | null;
  change: number | null;
}

export interface SalePayment {
  method: SalePaymentMethod | null;
  cashReceived: number | null;
  change: number | null;
  confirmedAt: Date | string | null;
  splitMode?: SalePaymentSplitMode | null;
  splitCount?: number | null;
  splitPayments?: SalePaymentSplitEntry[];
}

export interface SaleDraftItem {
  id: string;
  productId: string;
  nameSnapshot?: string;
  qty: number;
  unitPriceSnapshot?: number;
  note?: string;
  recipe: RecipeItem[];
}

export interface SaleDraft {
  id: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  items: SaleDraftItem[];
  total: number;
  customerType?: SaleCustomerType;
  saleOrigin?: SaleOrigin;
  appOrderTotal?: number | null;
  status: SaleStatus;
  payment: SalePayment;
  stockDebited: boolean;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  imageUrl: string;
  category: 'Snack' | 'Drink' | 'Side' | 'Combo';
  recipe: RecipeItem[];
  comboItems?: ComboItem[];
}

export interface Sale {
  id: string;
  productId: string;
  productName: string;
  timestamp: Date;
  total: number;
  totalCost: number; // Soma dos custos dos ingredientes no momento da venda
  recipe?: RecipeItem[]; // Guardamos a receita exata usada para o estorno ser perfeito
  stockDebited?: RecipeItem[]; // Snapshot do que foi realmente baixado no estoque
  basePrice?: number; // Preço base do produto no momento da venda
  priceAdjustment?: number; // Ajuste aplicado no preço (customizações)
  baseCost?: number; // Custo da receita base no momento da venda
  status?: SaleStatus;
  payment?: SalePayment;
  saleDraftId?: string;
  saleOrigin?: SaleOrigin;
  appOrderTotal?: number | null;
}

export interface DailySalesHistoryEntry {
  id: string;
  closedAt: Date | string;
  businessDate?: string;
  openingCash: number;
  totalRevenue: number;
  totalPurchases: number;
  totalProfit: number;
  saleCount: number;
  cashExpenses?: number;
  cashExpenseDetails?: CashRegisterExpenseDetail[];
}

export enum ViewMode {
  POS = 'POS',
  INVENTORY = 'INVENTORY',
  PRODUCT_REPORTS = 'PRODUCT_REPORTS',
  REPORTS = 'REPORTS',
  ADMIN = 'ADMIN',
  OTHERS = 'OTHERS',
}
