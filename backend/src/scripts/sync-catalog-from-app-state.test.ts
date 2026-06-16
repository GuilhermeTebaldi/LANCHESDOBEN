import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAppStateExternalId,
  type CatalogIngredientRow,
  type CatalogProductRow,
  type CatalogRecipeRow,
  type CatalogSyncStore,
  isUuid,
  readCatalogSyncOptionsFromEnv,
  syncCatalogFromAppState,
} from './sync-catalog-from-app-state.js';

const UUID_INGREDIENT = '11111111-1111-4111-8111-111111111111';
const UUID_PRODUCT = '22222222-2222-4222-8222-222222222222';

class MemoryCatalogSyncStore implements CatalogSyncStore {
  state: unknown;
  ingredients = new Map<string, CatalogIngredientRow>();
  products = new Map<string, CatalogProductRow>();
  recipes = new Map<string, CatalogRecipeRow[]>();
  appStateReads = 0;
  appStateWrites = 0;
  salesWrites = 0;
  stockMovementWrites = 0;
  checkoutConfirmationWrites = 0;

  constructor(state: unknown) {
    this.state = state;
  }

  async readAppState(): Promise<unknown | null> {
    this.appStateReads += 1;
    return this.state;
  }

  async findIngredient(identity: { id?: string; externalId: string }): Promise<{ id: string } | null> {
    const byId = identity.id ? this.ingredients.get(identity.id) : null;
    if (byId) return { id: byId.id };

    for (const ingredient of this.ingredients.values()) {
      if (ingredient.externalId === identity.externalId) {
        return { id: ingredient.id };
      }
    }
    return null;
  }

  async saveIngredient(row: CatalogIngredientRow, existingId: string | null): Promise<{ id: string }> {
    const id = existingId || row.id;
    this.ingredients.set(id, { ...row, id });
    return { id };
  }

  async findProduct(identity: { id?: string; externalId: string }): Promise<{ id: string } | null> {
    const byId = identity.id ? this.products.get(identity.id) : null;
    if (byId) return { id: byId.id };

    for (const product of this.products.values()) {
      if (product.externalId === identity.externalId) {
        return { id: product.id };
      }
    }
    return null;
  }

  async saveProduct(row: CatalogProductRow, existingId: string | null): Promise<{ id: string }> {
    const id = existingId || row.id;
    this.products.set(id, { ...row, id });
    return { id };
  }

  async listProductRecipe(productId: string): Promise<CatalogRecipeRow[]> {
    return this.recipes.get(productId)?.map((entry) => ({ ...entry })) || [];
  }

  async replaceProductRecipe(productId: string, recipe: CatalogRecipeRow[]): Promise<void> {
    this.recipes.set(productId, recipe.map((entry) => ({ ...entry })));
  }
}

const buildState = (overrides: Record<string, unknown> = {}) => ({
  ingredients: [
    {
      id: UUID_INGREDIENT,
      name: 'Pao',
      unit: 'un',
      currentStock: 10,
      minStock: 1,
      cost: 2,
      imageUrl: 'data:image/png;base64,AAAA',
    },
    {
      id: 'legacy-cheese',
      name: 'Queijo',
      unit: 'g',
      currentStock: 500,
      minStock: 50,
      cost: 0.04,
      addonPrice: 1.5,
      imageUrl: 'https://cdn.example.com/cheese.png',
    },
  ],
  products: [
    {
      id: UUID_PRODUCT,
      name: 'X Teste',
      price: 20,
      imageUrl: 'data:image/png;base64,BBBB',
      category: 'Snack',
      recipe: [
        { ingredientId: UUID_INGREDIENT, quantity: 1 },
        { ingredientId: 'legacy-cheese', quantity: 30 },
      ],
    },
  ],
  ...overrides,
});

test('catalog sync blocks without exact enable flag and does not read or write', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  const report = await syncCatalogFromAppState(store, { enabled: false, dryRun: false });

  assert.equal(report.blocked, true);
  assert.equal(store.appStateReads, 0);
  assert.equal(store.ingredients.size, 0);
  assert.equal(store.products.size, 0);
});

test('catalog sync dry-run reports changes without writing', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  const report = await syncCatalogFromAppState(store, { enabled: true, dryRun: true });

  assert.equal(report.dryRun, true);
  assert.deepEqual(report.ingredients.created, [UUID_INGREDIENT, 'legacy-cheese']);
  assert.deepEqual(report.products.created, [UUID_PRODUCT]);
  assert.equal(report.recipes.created.length, 2);
  assert.equal(store.ingredients.size, 0);
  assert.equal(store.products.size, 0);
  assert.equal(store.recipes.size, 0);
});

test('catalog sync real mode is idempotent', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  const first = await syncCatalogFromAppState(store, { enabled: true, dryRun: false });
  const second = await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  assert.deepEqual(first.ingredients.created, [UUID_INGREDIENT, 'legacy-cheese']);
  assert.deepEqual(second.ingredients.updated, [UUID_INGREDIENT, 'legacy-cheese']);
  assert.equal(store.ingredients.size, 2);
  assert.equal(store.products.size, 1);
  assert.equal([...store.recipes.values()][0].length, 2);
});

test('catalog sync preserves valid UUID and uses externalId for non-UUID ids', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  assert.equal(store.ingredients.has(UUID_INGREDIENT), true);
  const legacyIngredient = [...store.ingredients.values()].find(
    (entry) => entry.externalId === buildAppStateExternalId('legacy-cheese')
  );
  assert.ok(legacyIngredient);
  assert.equal(isUuid(legacyIngredient.id), true);
  assert.notEqual(legacyIngredient.id, 'legacy-cheese');
});

test('catalog sync does not copy base64 images and uses product placeholder', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  const uuidIngredient = store.ingredients.get(UUID_INGREDIENT);
  const product = store.products.get(UUID_PRODUCT);
  assert.equal(uuidIngredient?.imageUrl, null);
  assert.equal(product?.imageUrl, 'https://example.com/xburger-product-placeholder.png');
});

test('catalog sync skips combo products', async () => {
  const store = new MemoryCatalogSyncStore(
    buildState({
      products: [
        {
          id: 'combo-1',
          name: 'Combo',
          price: 30,
          imageUrl: 'https://cdn.example.com/combo.png',
          category: 'Combo',
          recipe: [{ ingredientId: UUID_INGREDIENT, quantity: 1 }],
        },
      ],
    })
  );

  const report = await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  assert.deepEqual(report.products.skippedCombo, ['combo-1']);
  assert.equal(store.products.size, 0);
});

test('catalog sync creates and removes product ingredient links', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  await syncCatalogFromAppState(store, { enabled: true, dryRun: false });
  const firstRecipe = store.recipes.get(UUID_PRODUCT) || [];
  assert.equal(firstRecipe.length, 2);

  store.state = buildState({
    products: [
      {
        id: UUID_PRODUCT,
        name: 'X Teste',
        price: 20,
        imageUrl: 'https://cdn.example.com/x.png',
        category: 'SNACK',
        recipe: [{ ingredientId: UUID_INGREDIENT, quantity: 1 }],
      },
    ],
  });

  const report = await syncCatalogFromAppState(store, { enabled: true, dryRun: false });
  const secondRecipe = store.recipes.get(UUID_PRODUCT) || [];

  assert.equal(report.recipes.removed.length, 1);
  assert.equal(secondRecipe.length, 1);
  assert.equal(secondRecipe[0].ingredientId, UUID_INGREDIENT);
});

test('catalog sync skips product when recipe ingredient is missing', async () => {
  const store = new MemoryCatalogSyncStore(
    buildState({
      products: [
        {
          id: 'product-missing',
          name: 'Sem insumo',
          price: 10,
          imageUrl: 'https://cdn.example.com/missing.png',
          category: 'Side',
          recipe: [{ ingredientId: 'missing-ingredient', quantity: 1 }],
        },
      ],
    })
  );

  const report = await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  assert.deepEqual(report.products.skippedMissingIngredient, [
    {
      id: 'product-missing',
      missingIngredientIds: ['missing-ingredient'],
    },
  ]);
  assert.equal(store.products.size, 0);
});

test('catalog sync never writes app_state, sales, stock movements or checkout confirmations', async () => {
  const store = new MemoryCatalogSyncStore(buildState());
  await syncCatalogFromAppState(store, { enabled: true, dryRun: false });

  assert.equal(store.appStateWrites, 0);
  assert.equal(store.salesWrites, 0);
  assert.equal(store.stockMovementWrites, 0);
  assert.equal(store.checkoutConfirmationWrites, 0);
});

test('catalog sync env parser requires exact true values', () => {
  assert.deepEqual(readCatalogSyncOptionsFromEnv({}), {
    enabled: false,
    dryRun: false,
  });
  assert.deepEqual(
    readCatalogSyncOptionsFromEnv({
      CHECKOUT_V2_CATALOG_SYNC_ENABLED: 'True',
      CHECKOUT_V2_CATALOG_SYNC_DRY_RUN: 'TRUE',
    }),
    {
      enabled: false,
      dryRun: false,
    }
  );
  assert.deepEqual(
    readCatalogSyncOptionsFromEnv({
      CHECKOUT_V2_CATALOG_SYNC_ENABLED: 'true',
      CHECKOUT_V2_CATALOG_SYNC_DRY_RUN: 'true',
    }),
    {
      enabled: true,
      dryRun: true,
    }
  );
});
