import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Prisma, ProductCategory } from '@prisma/client';

import { prisma } from '../db/prisma.js';

type LegacyIngredient = {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number;
  addonPrice?: number;
  imageUrl?: string;
};

type LegacyRecipeItem = {
  ingredientId: string;
  quantity: number;
};

type LegacyProduct = {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  category: string;
  recipe: LegacyRecipeItem[];
};

export type CatalogIngredientRow = {
  id: string;
  externalId: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  cost: number;
  addonPrice: number | null;
  imageUrl: string | null;
};

export type CatalogProductRow = {
  id: string;
  externalId: string;
  name: string;
  price: number;
  imageUrl: string;
  category: ProductCategory;
};

export type CatalogRecipeRow = {
  ingredientId: string;
  quantity: number;
};

export type CatalogSyncStore = {
  readAppState(): Promise<unknown | null>;
  findIngredient(identity: { id?: string; externalId: string }): Promise<{ id: string } | null>;
  saveIngredient(row: CatalogIngredientRow, existingId: string | null): Promise<{ id: string }>;
  findProduct(identity: { id?: string; externalId: string }): Promise<{ id: string } | null>;
  saveProduct(row: CatalogProductRow, existingId: string | null): Promise<{ id: string }>;
  listProductRecipe(productId: string): Promise<CatalogRecipeRow[]>;
  replaceProductRecipe(productId: string, recipe: CatalogRecipeRow[]): Promise<void>;
};

export type CatalogSyncOptions = {
  enabled: boolean;
  dryRun: boolean;
};

export type CatalogSyncReport = {
  blocked: boolean;
  dryRun: boolean;
  ingredients: {
    created: string[];
    updated: string[];
    skippedInvalid: Array<{ id: string; reason: string }>;
  };
  products: {
    created: string[];
    updated: string[];
    skippedCombo: string[];
    skippedInvalid: Array<{ id: string; reason: string }>;
    skippedMissingIngredient: Array<{ id: string; missingIngredientIds: string[] }>;
  };
  recipes: {
    created: Array<{ productId: string; ingredientId: string; quantity: number }>;
    removed: Array<{ productId: string; ingredientId: string }>;
  };
  writes: {
    ingredients: number;
    products: number;
    recipesReplaced: number;
  };
};

const PRODUCT_PLACEHOLDER_IMAGE_URL = 'https://example.com/xburger-product-placeholder.png';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const emptyReport = (options: CatalogSyncOptions): CatalogSyncReport => ({
  blocked: !options.enabled,
  dryRun: options.dryRun,
  ingredients: {
    created: [],
    updated: [],
    skippedInvalid: [],
  },
  products: {
    created: [],
    updated: [],
    skippedCombo: [],
    skippedInvalid: [],
    skippedMissingIngredient: [],
  },
  recipes: {
    created: [],
    removed: [],
  },
  writes: {
    ingredients: 0,
    products: 0,
    recipesReplaced: 0,
  },
});

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const buildAppStateExternalId = (legacyId: string): string => {
  const direct = `app-state:${legacyId}`;
  if (direct.length <= 80) {
    return direct;
  }
  return `app-state:${createHash('sha256').update(legacyId).digest('hex')}`;
};

const isValidHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const toFiniteNumber = (value: unknown): number | null => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeLegacyIngredients = (state: unknown): LegacyIngredient[] => {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return [];
  }

  const ingredients = (state as { ingredients?: unknown }).ingredients;
  if (!Array.isArray(ingredients)) {
    return [];
  }

  return ingredients.flatMap((entry): LegacyIngredient[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const source = entry as Record<string, unknown>;
    const id = readString(source, 'id');
    const name = readString(source, 'name');
    const unit = readString(source, 'unit');
    const currentStock = toFiniteNumber(source.currentStock);
    const minStock = toFiniteNumber(source.minStock);
    const cost = toFiniteNumber(source.cost);
    const addonPrice = toFiniteNumber(source.addonPrice);

    if (!id || !name || !unit || currentStock === null || minStock === null || cost === null) {
      return [];
    }

    return [
      {
        id,
        name,
        unit,
        currentStock,
        minStock,
        cost,
        addonPrice: addonPrice ?? undefined,
        imageUrl: isValidHttpUrl(source.imageUrl) ? source.imageUrl.trim() : undefined,
      },
    ];
  });
};

const normalizeLegacyProducts = (state: unknown): LegacyProduct[] => {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return [];
  }

  const products = (state as { products?: unknown }).products;
  if (!Array.isArray(products)) {
    return [];
  }

  return products.flatMap((entry): LegacyProduct[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const source = entry as Record<string, unknown>;
    const id = readString(source, 'id');
    const name = readString(source, 'name');
    const price = toFiniteNumber(source.price);
    const category = readString(source, 'category');

    if (!id || !name || price === null || !category) {
      return [];
    }

    const recipeSource = Array.isArray(source.recipe) ? source.recipe : [];
    const recipe = recipeSource.flatMap((item): LegacyRecipeItem[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return [];
      }
      const recipeEntry = item as Record<string, unknown>;
      const ingredientId = readString(recipeEntry, 'ingredientId');
      const quantity = toFiniteNumber(recipeEntry.quantity);
      if (!ingredientId || quantity === null || quantity <= 0) {
        return [];
      }
      return [{ ingredientId, quantity }];
    });

    return [
      {
        id,
        name,
        price,
        category,
        recipe,
        imageUrl: isValidHttpUrl(source.imageUrl) ? source.imageUrl.trim() : undefined,
      },
    ];
  });
};

const mapCategory = (category: string): ProductCategory | 'COMBO' | null => {
  const normalized = category.trim().toUpperCase();
  if (normalized === 'SNACK') return ProductCategory.SNACK;
  if (normalized === 'DRINK') return ProductCategory.DRINK;
  if (normalized === 'SIDE') return ProductCategory.SIDE;
  if (normalized === 'COMBO') return 'COMBO';
  return null;
};

const buildRecipeRows = (
  product: LegacyProduct,
  ingredientIdMap: Map<string, string>
): { rows: CatalogRecipeRow[]; missingIngredientIds: string[] } => {
  const grouped = new Map<string, number>();
  const missing = new Set<string>();

  product.recipe.forEach((entry) => {
    const relationalIngredientId = ingredientIdMap.get(entry.ingredientId);
    if (!relationalIngredientId) {
      missing.add(entry.ingredientId);
      return;
    }

    grouped.set(relationalIngredientId, (grouped.get(relationalIngredientId) || 0) + entry.quantity);
  });

  return {
    rows: [...grouped.entries()].map(([ingredientId, quantity]) => ({
      ingredientId,
      quantity,
    })),
    missingIngredientIds: [...missing],
  };
};

const diffRecipe = (current: CatalogRecipeRow[], next: CatalogRecipeRow[]) => {
  const currentIds = new Set(current.map((entry) => entry.ingredientId));
  const nextIds = new Set(next.map((entry) => entry.ingredientId));

  return {
    created: next.filter((entry) => !currentIds.has(entry.ingredientId)),
    removed: current.filter((entry) => !nextIds.has(entry.ingredientId)),
  };
};

export const syncCatalogFromAppState = async (
  store: CatalogSyncStore,
  options: CatalogSyncOptions
): Promise<CatalogSyncReport> => {
  const report = emptyReport(options);
  if (!options.enabled) {
    return report;
  }

  const state = await store.readAppState();
  const ingredients = normalizeLegacyIngredients(state);
  const products = normalizeLegacyProducts(state);
  const ingredientIdMap = new Map<string, string>();

  for (const ingredient of ingredients) {
    const externalId = buildAppStateExternalId(ingredient.id);
    const id = isUuid(ingredient.id) ? ingredient.id : randomUUID();
    const existing = await store.findIngredient({
      id: isUuid(ingredient.id) ? ingredient.id : undefined,
      externalId,
    });
    const relationalId = existing?.id || id;
    const row: CatalogIngredientRow = {
      id: relationalId,
      externalId,
      name: ingredient.name,
      unit: ingredient.unit,
      currentStock: Math.max(0, ingredient.currentStock),
      minStock: Math.max(0, ingredient.minStock),
      cost: Math.max(0, ingredient.cost),
      addonPrice: ingredient.addonPrice === undefined ? null : Math.max(0, ingredient.addonPrice),
      imageUrl: ingredient.imageUrl || null,
    };

    if (existing) {
      report.ingredients.updated.push(ingredient.id);
    } else {
      report.ingredients.created.push(ingredient.id);
    }

    if (!options.dryRun) {
      const saved = await store.saveIngredient(row, existing?.id || null);
      ingredientIdMap.set(ingredient.id, saved.id);
      report.writes.ingredients += 1;
    } else {
      ingredientIdMap.set(ingredient.id, relationalId);
    }
  }

  for (const product of products) {
    const category = mapCategory(product.category);
    if (category === 'COMBO') {
      report.products.skippedCombo.push(product.id);
      continue;
    }
    if (!category) {
      report.products.skippedInvalid.push({ id: product.id, reason: 'invalid_category' });
      continue;
    }

    const recipeResult = buildRecipeRows(product, ingredientIdMap);
    if (recipeResult.missingIngredientIds.length > 0) {
      report.products.skippedMissingIngredient.push({
        id: product.id,
        missingIngredientIds: recipeResult.missingIngredientIds,
      });
      continue;
    }
    if (recipeResult.rows.length === 0) {
      report.products.skippedInvalid.push({ id: product.id, reason: 'empty_recipe' });
      continue;
    }

    const externalId = buildAppStateExternalId(product.id);
    const id = isUuid(product.id) ? product.id : randomUUID();
    const existing = await store.findProduct({
      id: isUuid(product.id) ? product.id : undefined,
      externalId,
    });
    const relationalId = existing?.id || id;
    const currentRecipe = existing ? await store.listProductRecipe(existing.id) : [];
    const recipeDiff = diffRecipe(currentRecipe, recipeResult.rows);
    recipeDiff.created.forEach((entry) => {
      report.recipes.created.push({
        productId: relationalId,
        ingredientId: entry.ingredientId,
        quantity: entry.quantity,
      });
    });
    recipeDiff.removed.forEach((entry) => {
      report.recipes.removed.push({
        productId: relationalId,
        ingredientId: entry.ingredientId,
      });
    });

    const row: CatalogProductRow = {
      id: relationalId,
      externalId,
      name: product.name,
      price: Math.max(0, product.price),
      imageUrl: product.imageUrl || PRODUCT_PLACEHOLDER_IMAGE_URL,
      category,
    };

    if (existing) {
      report.products.updated.push(product.id);
    } else {
      report.products.created.push(product.id);
    }

    if (!options.dryRun) {
      const saved = await store.saveProduct(row, existing?.id || null);
      await store.replaceProductRecipe(saved.id, recipeResult.rows);
      report.writes.products += 1;
      report.writes.recipesReplaced += 1;
    }
  }

  return report;
};

class PrismaCatalogSyncStore implements CatalogSyncStore {
  async readAppState(): Promise<unknown | null> {
    const row = await prisma.appState.findUnique({ where: { id: 1 } });
    return row?.stateJson ?? null;
  }

  async findIngredient(identity: { id?: string; externalId: string }): Promise<{ id: string } | null> {
    return prisma.ingredient.findFirst({
      where: {
        OR: [
          ...(identity.id ? [{ id: identity.id }] : []),
          { externalId: identity.externalId },
        ],
      },
      select: { id: true },
    });
  }

  async saveIngredient(row: CatalogIngredientRow, existingId: string | null): Promise<{ id: string }> {
    const data = {
      externalId: row.externalId,
      name: row.name,
      unit: row.unit,
      currentStock: new Prisma.Decimal(row.currentStock),
      minStock: new Prisma.Decimal(row.minStock),
      cost: new Prisma.Decimal(row.cost),
      addonPrice: row.addonPrice === null ? null : new Prisma.Decimal(row.addonPrice),
      imageUrl: row.imageUrl,
      isActive: true,
    };

    if (existingId) {
      return prisma.ingredient.update({
        where: { id: existingId },
        data,
        select: { id: true },
      });
    }

    return prisma.ingredient.create({
      data: {
        id: row.id,
        ...data,
      },
      select: { id: true },
    });
  }

  async findProduct(identity: { id?: string; externalId: string }): Promise<{ id: string } | null> {
    return prisma.product.findFirst({
      where: {
        OR: [
          ...(identity.id ? [{ id: identity.id }] : []),
          { externalId: identity.externalId },
        ],
      },
      select: { id: true },
    });
  }

  async saveProduct(row: CatalogProductRow, existingId: string | null): Promise<{ id: string }> {
    const data = {
      externalId: row.externalId,
      name: row.name,
      price: new Prisma.Decimal(row.price),
      imageUrl: row.imageUrl,
      category: row.category,
      isActive: true,
    };

    if (existingId) {
      return prisma.product.update({
        where: { id: existingId },
        data,
        select: { id: true },
      });
    }

    return prisma.product.create({
      data: {
        id: row.id,
        ...data,
      },
      select: { id: true },
    });
  }

  async listProductRecipe(productId: string): Promise<CatalogRecipeRow[]> {
    const rows = await prisma.productIngredient.findMany({
      where: { productId },
      select: {
        ingredientId: true,
        quantity: true,
      },
    });

    return rows.map((row) => ({
      ingredientId: row.ingredientId,
      quantity: Number(row.quantity),
    }));
  }

  async replaceProductRecipe(productId: string, recipe: CatalogRecipeRow[]): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.productIngredient.deleteMany({
        where: {
          productId,
          ingredientId: {
            notIn: recipe.map((entry) => entry.ingredientId),
          },
        },
      });

      for (const entry of recipe) {
        await tx.productIngredient.upsert({
          where: {
            productId_ingredientId: {
              productId,
              ingredientId: entry.ingredientId,
            },
          },
          create: {
            productId,
            ingredientId: entry.ingredientId,
            quantity: new Prisma.Decimal(entry.quantity),
          },
          update: {
            quantity: new Prisma.Decimal(entry.quantity),
          },
        });
      }
    });
  }
}

export const readCatalogSyncOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): CatalogSyncOptions => ({
  enabled: env.CHECKOUT_V2_CATALOG_SYNC_ENABLED === 'true',
  dryRun: env.CHECKOUT_V2_CATALOG_SYNC_DRY_RUN === 'true',
});

const main = async () => {
  const options = readCatalogSyncOptionsFromEnv();
  if (!options.enabled) {
    // eslint-disable-next-line no-console
    console.error(
      '[catalog-sync] blocked: set CHECKOUT_V2_CATALOG_SYNC_ENABLED=true to run this manual script.'
    );
    process.exitCode = 1;
    return;
  }

  const report = await syncCatalogFromAppState(new PrismaCatalogSyncStore(), options);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[catalog-sync] failed', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
