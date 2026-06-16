import {
  Prisma,
  ProductCategory,
  SaleStatus,
  StockDirection,
  StockMovementReason,
  StockTargetType,
  type PrismaClient,
  type RefundType,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';
import type { RequestContext } from '../types/request-context.js';
import { roundMoney, roundQuantity, toDecimal, toNumber } from '../utils/decimal.js';
import { HttpError } from '../utils/http-error.js';
import { AuditService } from './audit.service.js';
import {
  buildRefundIngredientRows,
  mergeRefundTargets,
  sumRefundIngredientCost,
} from './sale-refund.utils.js';
import { SessionService } from './session.service.js';

export interface RecipeItemInput {
  ingredientId: string;
  quantity: number;
}

export interface SaleCreateItemInput {
  productId: string;
  quantity: number;
  priceOverride?: number;
  recipeOverride?: RecipeItemInput[];
}

export interface SaleCreateInput {
  externalId?: string;
  sessionId?: string;
  items: SaleCreateItemInput[];
  note?: string;
}

interface RefundItemInput {
  saleItemId: string;
  quantity: number;
}

interface RefundCreateInput {
  type: RefundType;
  reason?: string;
  items?: RefundItemInput[];
}

interface SaleListFilters {
  sessionId?: string;
  includeRefunded?: boolean;
  onlyRefunded?: boolean;
}

const normalizeRecipe = (recipe: RecipeItemInput[]) => {
  const grouped = new Map<string, number>();
  recipe.forEach((item) => {
    const current = grouped.get(item.ingredientId) || 0;
    grouped.set(item.ingredientId, current + item.quantity);
  });

  return [...grouped.entries()].map(([ingredientId, quantity]) => ({
    ingredientId,
    quantity: roundQuantity(quantity),
  }));
};

const categoryLabel = (category: ProductCategory): 'Snack' | 'Drink' | 'Side' => {
  if (category === ProductCategory.SNACK) return 'Snack';
  if (category === ProductCategory.DRINK) return 'Drink';
  return 'Side';
};

export class SaleService {
  private readonly sessionService = new SessionService();

  async list(filters: SaleListFilters = {}) {
    return prisma.sale.findMany({
      where: {
        sessionId: filters.sessionId,
        status: filters.onlyRefunded
          ? SaleStatus.REFUNDED
          : filters.includeRefunded
            ? undefined
            : {
                not: SaleStatus.REFUNDED,
              },
      },
      include: {
        items: {
          include: {
            ingredients: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        refunds: {
          select: {
            totalCostReversed: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getById(saleId: string) {
    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        items: {
          include: {
            ingredients: true,
          },
          orderBy: { createdAt: 'asc' },
        },
        refunds: {
          include: {
            items: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!sale) {
      throw new HttpError(404, 'Venda não encontrada.');
    }

    return sale;
  }

  async create(input: SaleCreateInput, context?: RequestContext) {
    if (input.items.length === 0) {
      throw new HttpError(422, 'A venda precisa ter ao menos um item.');
    }

    const resolvedSession = input.sessionId
      ? await this.sessionService.getSessionById(input.sessionId)
      : await this.sessionService.getCurrentSession();

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const uniqueProductIds = [...new Set(input.items.map((item) => item.productId))];
      const products = await tx.product.findMany({
        where: {
          id: { in: uniqueProductIds },
          isActive: true,
        },
        include: {
          recipeItems: {
            include: {
              ingredient: true,
            },
          },
        },
      });

      if (products.length !== uniqueProductIds.length) {
        const foundIds = new Set(products.map((product) => product.id));
        const missingProductIds = uniqueProductIds.filter((id) => !foundIds.has(id));
        throw new HttpError(422, 'Venda contém produtos inexistentes ou inativos.', {
          missingProductIds,
        });
      }

      type PlannedIngredient = {
        ingredientId: string;
        quantityPerUnit: number;
      };

      type PlannedItem = {
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: number;
        baseUnitPrice: number;
        category: ProductCategory;
        plannedIngredients: PlannedIngredient[];
        baseRecipe: PlannedIngredient[];
      };

      const productById = new Map<string, (typeof products)[number]>(
        products.map((product) => [product.id, product])
      );
      const plannedItems: PlannedItem[] = [];

      for (const rawItem of input.items) {
        const product = productById.get(rawItem.productId);
        if (!product) {
          throw new HttpError(422, `Produto ${rawItem.productId} não disponível.`);
        }

        const baseRecipe = normalizeRecipe(
          product.recipeItems.map((recipeItem) => ({
            ingredientId: recipeItem.ingredientId,
            quantity: toNumber(recipeItem.quantity),
          }))
        );

        if (baseRecipe.length === 0) {
          throw new HttpError(422, `Produto ${product.name} não possui receita configurada.`);
        }

        const plannedIngredients = rawItem.recipeOverride
          ? normalizeRecipe(rawItem.recipeOverride)
          : baseRecipe;

        if (plannedIngredients.length === 0) {
          throw new HttpError(422, `Receita customizada inválida para ${product.name}.`);
        }

        const allowedIngredientIds = new Set(baseRecipe.map((entry) => entry.ingredientId));
        const invalidCustomIngredient = plannedIngredients.find(
          (entry) => !allowedIngredientIds.has(entry.ingredientId)
        );

        if (invalidCustomIngredient) {
          throw new HttpError(
            422,
            `Receita customizada contém insumo fora da receita base (${invalidCustomIngredient.ingredientId}).`
          );
        }

        const quantity = rawItem.quantity;
        plannedItems.push({
          productId: product.id,
          productName: product.name,
          quantity,
          unitPrice: rawItem.priceOverride ?? toNumber(product.price),
          baseUnitPrice: toNumber(product.price),
          category: product.category,
          plannedIngredients: plannedIngredients.map((entry) => ({
            ingredientId: entry.ingredientId,
            quantityPerUnit: entry.quantity,
          })),
          baseRecipe: baseRecipe.map((entry) => ({
            ingredientId: entry.ingredientId,
            quantityPerUnit: entry.quantity,
          })),
        });
      }

      const consumption = new Map<string, number>();
      const ingredientIds = new Set<string>();
      plannedItems.forEach((item) => {
        item.plannedIngredients.forEach((ingredient) => {
          const quantity = ingredient.quantityPerUnit * item.quantity;
          const current = consumption.get(ingredient.ingredientId) || 0;
          consumption.set(ingredient.ingredientId, roundQuantity(current + quantity));
          ingredientIds.add(ingredient.ingredientId);
        });
      });

      const ingredientRows = await tx.ingredient.findMany({
        where: {
          id: { in: [...ingredientIds] },
          isActive: true,
        },
      });

      if (ingredientRows.length !== ingredientIds.size) {
        const foundIds = new Set(ingredientRows.map((row) => row.id));
        const missingIngredientIds = [...ingredientIds].filter((id) => !foundIds.has(id));
        throw new HttpError(422, 'Venda contém insumos ausentes/inativos.', { missingIngredientIds });
      }

      const ingredientById = new Map<
        string,
        {
          cost: number;
          stock: number;
          name: string;
          unit: string;
        }
      >(
        ingredientRows.map((ingredient) => [
          ingredient.id,
          {
            cost: toNumber(ingredient.cost),
            stock: toNumber(ingredient.currentStock),
            name: ingredient.name,
            unit: ingredient.unit,
          },
        ])
      );

      for (const [ingredientId, neededQty] of consumption.entries()) {
        const row = ingredientById.get(ingredientId);
        if (!row) {
          throw new HttpError(422, `Insumo ${ingredientId} ausente.`);
        }

        if (row.stock < neededQty) {
          throw new HttpError(409, `Estoque insuficiente para o insumo ${row.name}.`, {
            ingredientId,
            required: neededQty,
            available: row.stock,
          });
        }
      }

      for (const [ingredientId, neededQty] of consumption.entries()) {
        const changed = await tx.$executeRaw`
          UPDATE ingredients
          SET current_stock = current_stock - ${toDecimal(neededQty)}
          WHERE id = ${ingredientId}::uuid
            AND current_stock >= ${toDecimal(neededQty)}
        `;

        if (Number(changed) !== 1) {
          throw new HttpError(409, `Conflito de concorrência ao reservar estoque (${ingredientId}).`);
        }
      }

      type SaleItemComputed = {
        planned: PlannedItem;
        lineTotal: number;
        lineCost: number;
        baseLineCost: number;
        ingredients: Array<{
          ingredientId: string;
          ingredientNameSnapshot: string;
          unitSnapshot: string;
          quantity: number;
          unitCost: number;
          lineCost: number;
        }>;
      };

      const computedItems: SaleItemComputed[] = plannedItems.map((item) => {
        let lineCost = 0;
        let baseLineCost = 0;

        const ingredients = item.plannedIngredients.map((plannedIngredient) => {
          const ingredientInfo = ingredientById.get(plannedIngredient.ingredientId);
          if (!ingredientInfo) {
            throw new HttpError(422, `Insumo ${plannedIngredient.ingredientId} não encontrado.`);
          }

          const lineQuantity = roundQuantity(plannedIngredient.quantityPerUnit * item.quantity);
          const ingredientLineCost = roundQuantity(lineQuantity * ingredientInfo.cost);
          lineCost += ingredientLineCost;

          return {
            ingredientId: plannedIngredient.ingredientId,
            ingredientNameSnapshot: ingredientInfo.name,
            unitSnapshot: ingredientInfo.unit,
            quantity: lineQuantity,
            unitCost: ingredientInfo.cost,
            lineCost: ingredientLineCost,
          };
        });

        item.baseRecipe.forEach((baseIngredient) => {
          const ingredientInfo = ingredientById.get(baseIngredient.ingredientId);
          if (!ingredientInfo) {
            return;
          }
          const lineQuantity = roundQuantity(baseIngredient.quantityPerUnit * item.quantity);
          baseLineCost += roundQuantity(lineQuantity * ingredientInfo.cost);
        });

        const lineTotal = roundMoney(item.unitPrice * item.quantity);

        return {
          planned: item,
          lineTotal,
          lineCost: roundQuantity(lineCost),
          baseLineCost: roundQuantity(baseLineCost),
          ingredients,
        };
      });

      const totalGross = roundMoney(
        computedItems.reduce((sum, item) => roundMoney(sum + item.lineTotal), 0)
      );
      const totalCost = roundQuantity(
        computedItems.reduce((sum, item) => roundQuantity(sum + item.lineCost), 0)
      );

      const sale = await tx.sale.create({
        data: {
          externalId: input.externalId,
          sessionId: resolvedSession.id,
          status: SaleStatus.ACTIVE,
          totalGross: toDecimal(totalGross),
          totalNet: toDecimal(totalGross),
          totalCost: toDecimal(totalCost),
          totalRefunded: toDecimal(0),
          createdByUserId: context?.actorUserId,
          items: {
            create: computedItems.map((item) => {
              const baseUnitCost = item.planned.quantity > 0 ? item.baseLineCost / item.planned.quantity : 0;
              const unitCost = item.planned.quantity > 0 ? item.lineCost / item.planned.quantity : 0;
              return {
                productId: item.planned.productId,
                productNameSnapshot: item.planned.productName,
                quantity: item.planned.quantity,
                unitPrice: toDecimal(item.planned.unitPrice),
                baseUnitPrice: toDecimal(item.planned.baseUnitPrice),
                priceAdjustment: toDecimal(item.planned.unitPrice - item.planned.baseUnitPrice),
                unitCost: toDecimal(unitCost),
                baseUnitCost: toDecimal(baseUnitCost),
                lineTotal: toDecimal(item.lineTotal),
                lineCost: toDecimal(item.lineCost),
                ingredients: {
                  create: item.ingredients.map((ingredient) => ({
                    ingredientId: ingredient.ingredientId,
                    ingredientNameSnapshot: ingredient.ingredientNameSnapshot,
                    unitSnapshot: ingredient.unitSnapshot,
                    quantity: toDecimal(ingredient.quantity),
                    unitCost: toDecimal(ingredient.unitCost),
                    lineCost: toDecimal(ingredient.lineCost),
                  })),
                },
              };
            }),
          },
        },
        include: {
          items: {
            include: { ingredients: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      for (const [ingredientId, quantity] of consumption.entries()) {
        const ingredient = ingredientById.get(ingredientId);
        if (!ingredient) continue;

        await tx.stockMovement.create({
          data: {
            targetType: StockTargetType.INGREDIENT,
            direction: StockDirection.OUT,
            reason: StockMovementReason.SALE,
            isManual: false,
            quantity: toDecimal(quantity),
            unitCost: toDecimal(ingredient.cost),
            totalCost: toDecimal(roundQuantity(quantity * ingredient.cost)),
            ingredientId,
            saleId: sale.id,
            sessionId: resolvedSession.id,
            createdByUserId: context?.actorUserId,
            note: input.note || null,
          },
        });
      }

      await new AuditService(tx).log(
        {
          entityName: 'sales',
          entityId: sale.id,
          action: 'SALE_CREATED',
          afterData: {
            totalGross,
            totalCost,
            totalItems: sale.items.length,
            categoryMix: computedItems.reduce(
              (acc, item) => {
                const key = categoryLabel(item.planned.category);
                acc[key] = (acc[key] || 0) + item.planned.quantity;
                return acc;
              },
              {} as Record<string, number>
            ),
          },
        },
        context
      );

      return sale;
    });

    return result;
  }

  async undoLastSale(sessionId: string | undefined, context?: RequestContext) {
    const resolvedSession = sessionId
      ? await this.sessionService.getSessionById(sessionId)
      : await this.sessionService.getCurrentSession();

    const lastSale = await prisma.sale.findFirst({
      where: {
        sessionId: resolvedSession.id,
        status: {
          in: [SaleStatus.ACTIVE, SaleStatus.PARTIALLY_REFUNDED],
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastSale) {
      throw new HttpError(404, 'Nenhuma venda encontrada para desfazer nesta sessão.');
    }

    return this.createRefund(lastSale.id, { type: 'FULL', reason: 'UNDO_LAST_SALE' }, context);
  }

  async createRefund(saleId: string, input: RefundCreateInput, context?: RequestContext) {
    const refund = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: {
          items: {
            include: {
              ingredients: true,
              refundItems: true,
            },
            orderBy: { createdAt: 'asc' },
          },
          refunds: {
            include: {
              items: true,
            },
          },
        },
      });

      if (!sale) {
        throw new HttpError(404, 'Venda não encontrada para estorno.');
      }

      if (sale.status === SaleStatus.REFUNDED) {
        throw new HttpError(409, 'Esta venda já foi totalmente estornada.');
      }

      const refundableByItem = new Map<
        string,
        {
          sold: number;
          available: number;
          item: (typeof sale.items)[number];
        }
      >(
        sale.items.map((item) => {
          const alreadyRefunded = item.refundItems.reduce((sum, refundItem) => sum + refundItem.quantity, 0);
          return [
            item.id,
            {
              sold: item.quantity,
              available: item.quantity - alreadyRefunded,
              item,
            },
          ];
        })
      );

      const targets: Array<{ saleItemId: string; quantity: number }> = [];

      if (input.type === 'FULL') {
        refundableByItem.forEach((value, saleItemId) => {
          if (value.available > 0) {
            targets.push({ saleItemId, quantity: value.available });
          }
        });
      } else {
        const mergedItems = mergeRefundTargets(input.items || []);
        mergedItems.forEach((entry) => {
          const record = refundableByItem.get(entry.saleItemId);
          if (!record) {
            throw new HttpError(422, `Item ${entry.saleItemId} não pertence à venda.`);
          }
          if (entry.quantity > record.available) {
            throw new HttpError(409, `Quantidade de estorno maior que saldo disponível para ${entry.saleItemId}.`, {
              saleItemId: entry.saleItemId,
              available: record.available,
              requested: entry.quantity,
            });
          }
          targets.push({
            saleItemId: entry.saleItemId,
            quantity: entry.quantity,
          });
        });
      }

      if (targets.length === 0) {
        throw new HttpError(422, 'Nenhum item elegível para estorno.');
      }

      type IngredientRestore = {
        ingredientId: string;
        quantity: number;
        unitCost: number;
        ingredientName: string;
      };

      const ingredientRestoreMap = new Map<string, IngredientRestore>();

      let totalAmount = 0;
      let totalCostReversed = 0;

      const refundItemPlan = targets.map((target) => {
        const source = refundableByItem.get(target.saleItemId);
        if (!source) {
          throw new HttpError(422, `Item ${target.saleItemId} não encontrado para estorno.`);
        }

        const saleItem = source.item;
        const amount = roundMoney(toNumber(saleItem.unitPrice) * target.quantity);
        const ingredientRows = buildRefundIngredientRows(
          saleItem.ingredients.map((ingredientSnapshot) => ({
            saleItemIngredientId: ingredientSnapshot.id,
            ingredientId: ingredientSnapshot.ingredientId,
            ingredientNameSnapshot: ingredientSnapshot.ingredientNameSnapshot,
            quantitySold: toNumber(ingredientSnapshot.quantity),
            unitCost: toNumber(ingredientSnapshot.unitCost),
          })),
          saleItem.quantity,
          target.quantity
        );

        ingredientRows.forEach((row) => {
          if (!row.ingredientId) return;

          const existing = ingredientRestoreMap.get(row.ingredientId);
          if (existing) {
            existing.quantity = roundQuantity(existing.quantity + row.quantity);
          } else {
            ingredientRestoreMap.set(row.ingredientId, {
              ingredientId: row.ingredientId,
              quantity: row.quantity,
              unitCost: row.unitCost,
              ingredientName: row.ingredientNameSnapshot,
            });
          }
        });

        const costReversed = sumRefundIngredientCost(ingredientRows);
        totalAmount = roundMoney(totalAmount + amount);
        totalCostReversed = roundQuantity(totalCostReversed + costReversed);

        return {
          saleItemId: saleItem.id,
          quantity: target.quantity,
          amount,
          costReversed,
          ingredientRows,
        };
      });

      const restoreIngredientIds = [...ingredientRestoreMap.keys()];
      const restoreIngredients = await tx.ingredient.findMany({
        where: {
          id: { in: restoreIngredientIds },
        },
      });

      if (restoreIngredients.length !== restoreIngredientIds.length) {
        const foundIds = new Set(restoreIngredients.map((item) => item.id));
        const missing = restoreIngredientIds.filter((id) => !foundIds.has(id));
        throw new HttpError(422, 'Não foi possível estornar: insumo removido do cadastro.', {
          missingIngredientIds: missing,
        });
      }

      for (const restore of ingredientRestoreMap.values()) {
        await tx.ingredient.update({
          where: { id: restore.ingredientId },
          data: {
            currentStock: {
              increment: toDecimal(restore.quantity),
            },
          },
        });
      }

      const refund = await tx.refund.create({
        data: {
          saleId: sale.id,
          type: input.type,
          reason: input.reason || null,
          totalAmount: toDecimal(totalAmount),
          totalCostReversed: toDecimal(totalCostReversed),
          createdByUserId: context?.actorUserId,
          items: {
            create: refundItemPlan.map((plan) => ({
              saleItemId: plan.saleItemId,
              quantity: plan.quantity,
              amount: toDecimal(plan.amount),
              costReversed: toDecimal(plan.costReversed),
              ingredients: {
                create: plan.ingredientRows.map((row) => ({
                  saleItemIngredientId: row.saleItemIngredientId,
                  ingredientId: row.ingredientId,
                  ingredientNameSnapshot: row.ingredientNameSnapshot,
                  quantity: toDecimal(row.quantity),
                  unitCost: toDecimal(row.unitCost),
                  lineCost: toDecimal(row.lineCost),
                })),
              },
            })),
          },
        },
        include: {
          items: {
            include: {
              ingredients: true,
            },
          },
        },
      });

      for (const restore of ingredientRestoreMap.values()) {
        await tx.stockMovement.create({
          data: {
            targetType: StockTargetType.INGREDIENT,
            direction: StockDirection.IN,
            reason: StockMovementReason.REFUND,
            quantity: toDecimal(restore.quantity),
            unitCost: toDecimal(restore.unitCost),
            totalCost: toDecimal(roundQuantity(restore.quantity * restore.unitCost)),
            ingredientId: restore.ingredientId,
            saleId: sale.id,
            refundId: refund.id,
            sessionId: sale.sessionId,
            createdByUserId: context?.actorUserId,
            note: input.reason || null,
          },
        });
      }

      const nextTotalRefunded = roundMoney(toNumber(sale.totalRefunded) + totalAmount);
      const nextTotalNet = roundMoney(toNumber(sale.totalGross) - nextTotalRefunded);

      const nextStatus =
        nextTotalRefunded >= roundMoney(toNumber(sale.totalGross))
          ? SaleStatus.REFUNDED
          : SaleStatus.PARTIALLY_REFUNDED;

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          totalRefunded: toDecimal(nextTotalRefunded),
          totalNet: toDecimal(nextTotalNet),
          status: nextStatus,
        },
      });

      await new AuditService(tx).log(
        {
          entityName: 'refunds',
          entityId: refund.id,
          action: 'REFUND_CREATED',
          metadata: {
            saleId: sale.id,
            type: input.type,
            totalAmount,
            totalCostReversed,
            resultingSaleStatus: nextStatus,
            resultingTotalNet: nextTotalNet,
          },
        },
        context
      );

      return refund;
    });

    return refund;
  }
}
