import { createHash } from 'node:crypto';

import { Prisma, type CheckoutV2ConfirmationStatus } from '@prisma/client';

import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { RequestContext } from '../types/request-context.js';
import { HttpError } from '../utils/http-error.js';
import type { CheckoutV2ConfirmInput } from '../validators/checkout-v2.validator.js';
import { SaleService, type SaleCreateInput } from './sale.service.js';

export type CheckoutV2ConfirmationRecord = {
  id: string;
  draftId: string;
  commandId: string | null;
  saleId: string | null;
  status: CheckoutV2ConfirmationStatus;
  payloadHash: string;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReserveCheckoutV2ConfirmationInput = {
  draftId: string;
  commandId: string | null;
  payloadHash: string;
};

export interface CheckoutV2ConfirmationStore {
  create(input: ReserveCheckoutV2ConfirmationInput): Promise<CheckoutV2ConfirmationRecord>;
  findByDraftId(draftId: string): Promise<CheckoutV2ConfirmationRecord | null>;
  findByCommandId(commandId: string): Promise<CheckoutV2ConfirmationRecord | null>;
  markFailed(id: string, errorCode: string): Promise<CheckoutV2ConfirmationRecord>;
  markConfirmed(id: string, saleId: string): Promise<CheckoutV2ConfirmationRecord>;
}

export interface CheckoutV2SaleCreator {
  create(input: SaleCreateInput, context?: RequestContext): Promise<{ id: string }>;
  findByExternalId(externalId: string): Promise<{ id: string } | null>;
}

class PrismaCheckoutV2ConfirmationStore implements CheckoutV2ConfirmationStore {
  async create(input: ReserveCheckoutV2ConfirmationInput): Promise<CheckoutV2ConfirmationRecord> {
    return prisma.checkoutV2Confirmation.create({
      data: {
        draftId: input.draftId,
        commandId: input.commandId,
        payloadHash: input.payloadHash,
        status: 'RESERVED',
      },
    });
  }

  async findByDraftId(draftId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return prisma.checkoutV2Confirmation.findUnique({
      where: { draftId },
    });
  }

  async findByCommandId(commandId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return prisma.checkoutV2Confirmation.findUnique({
      where: { commandId },
    });
  }

  async markFailed(id: string, errorCode: string): Promise<CheckoutV2ConfirmationRecord> {
    return prisma.checkoutV2Confirmation.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorCode,
      },
    });
  }

  async markConfirmed(id: string, saleId: string): Promise<CheckoutV2ConfirmationRecord> {
    return prisma.checkoutV2Confirmation.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        saleId,
        errorCode: null,
      },
    });
  }
}

class RelationalCheckoutV2SaleCreator implements CheckoutV2SaleCreator {
  private readonly saleService = new SaleService();

  async create(input: SaleCreateInput, context?: RequestContext): Promise<{ id: string }> {
    return this.saleService.create(input, context);
  }

  async findByExternalId(externalId: string): Promise<{ id: string } | null> {
    return prisma.sale.findUnique({
      where: { externalId },
      select: { id: true },
    });
  }
}

export type CheckoutV2DisabledResult = {
  ok: false;
  code: 'FAST_CHECKOUT_V2_DISABLED';
};

export type CheckoutV2ReservedNotImplementedResult = {
  ok: false;
  code: 'FAST_CHECKOUT_V2_RESERVED_NOT_IMPLEMENTED';
  confirmationId: string;
};

export type CheckoutV2ConfirmedResult = {
  ok: true;
  code: 'FAST_CHECKOUT_V2_CONFIRMED';
  confirmationId: string;
  saleId: string;
  reused: boolean;
};

export type CheckoutV2ConfirmResult =
  | CheckoutV2DisabledResult
  | CheckoutV2ReservedNotImplementedResult
  | CheckoutV2ConfirmedResult;

const normalizeForStableHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableHash);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  return Object.keys(source)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const entry = source[key];
      if (entry !== undefined) {
        acc[key] = normalizeForStableHash(entry);
      }
      return acc;
    }, {});
};

export const hashCheckoutV2Payload = (payload: CheckoutV2ConfirmInput): string => {
  const normalized = normalizeForStableHash(payload);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
};

export const buildCheckoutV2SaleExternalId = (draftId: string): string =>
  `checkout-v2:${createHash('sha256').update(draftId).digest('hex')}`;

const isUniqueConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

export class CheckoutV2Service {
  constructor(
    private readonly store: CheckoutV2ConfirmationStore = new PrismaCheckoutV2ConfirmationStore(),
    private readonly saleCreator: CheckoutV2SaleCreator = new RelationalCheckoutV2SaleCreator()
  ) {}

  async findByDraftId(draftId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return this.store.findByDraftId(draftId);
  }

  async findByCommandId(commandId: string): Promise<CheckoutV2ConfirmationRecord | null> {
    return this.store.findByCommandId(commandId);
  }

  async markFailed(id: string, errorCode: string): Promise<CheckoutV2ConfirmationRecord> {
    return this.store.markFailed(id, errorCode);
  }

  async markConfirmed(id: string, saleId: string): Promise<CheckoutV2ConfirmationRecord> {
    return this.store.markConfirmed(id, saleId);
  }

  async reserveConfirmation(
    payload: CheckoutV2ConfirmInput
  ): Promise<CheckoutV2ConfirmationRecord> {
    const payloadHash = hashCheckoutV2Payload(payload);
    const commandId = payload.commandId || null;

    const byDraft = await this.store.findByDraftId(payload.draftId);
    if (byDraft) {
      if (byDraft.payloadHash !== payloadHash) {
        throw new HttpError(409, 'Conflito de idempotência no checkout v2.', {
          ok: false,
          code: 'CHECKOUT_V2_IDEMPOTENCY_CONFLICT',
        });
      }
      return byDraft;
    }

    if (commandId) {
      const byCommand = await this.store.findByCommandId(commandId);
      if (byCommand) {
        if (byCommand.payloadHash !== payloadHash || byCommand.draftId !== payload.draftId) {
          throw new HttpError(409, 'Conflito de idempotência no checkout v2.', {
            ok: false,
            code: 'CHECKOUT_V2_IDEMPOTENCY_CONFLICT',
          });
        }
        return byCommand;
      }
    }

    try {
      return await this.store.create({
        draftId: payload.draftId,
        commandId,
        payloadHash,
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }

      const existing =
        (await this.store.findByDraftId(payload.draftId)) ||
        (commandId ? await this.store.findByCommandId(commandId) : null);

      if (existing && existing.payloadHash === payloadHash && existing.draftId === payload.draftId) {
        return existing;
      }

      throw new HttpError(409, 'Conflito de idempotência no checkout v2.', {
        ok: false,
        code: 'CHECKOUT_V2_IDEMPOTENCY_CONFLICT',
      });
    }
  }

  async confirm(
    input: CheckoutV2ConfirmInput,
    context?: RequestContext
  ): Promise<CheckoutV2ConfirmResult> {
    if (!env.FAST_CHECKOUT_V2_ENABLED) {
      return {
        ok: false,
        code: 'FAST_CHECKOUT_V2_DISABLED',
      };
    }

    const confirmation = await this.reserveConfirmation(input);

    if (!env.FAST_CHECKOUT_V2_CREATE_SALE_ENABLED) {
      return {
        ok: false,
        code: 'FAST_CHECKOUT_V2_RESERVED_NOT_IMPLEMENTED',
        confirmationId: confirmation.id,
      };
    }

    if (confirmation.status === 'CONFIRMED') {
      if (!confirmation.saleId) {
        throw new HttpError(500, 'Confirmação v2 marcada sem venda vinculada.', {
          ok: false,
          code: 'CHECKOUT_V2_CONFIRMED_WITHOUT_SALE',
        });
      }

      return {
        ok: true,
        code: 'FAST_CHECKOUT_V2_CONFIRMED',
        confirmationId: confirmation.id,
        saleId: confirmation.saleId,
        reused: true,
      };
    }

    const externalId = buildCheckoutV2SaleExternalId(input.draftId);
    const existingSale = await this.saleCreator.findByExternalId(externalId);
    if (existingSale) {
      await this.markConfirmed(confirmation.id, existingSale.id);
      return {
        ok: true,
        code: 'FAST_CHECKOUT_V2_CONFIRMED',
        confirmationId: confirmation.id,
        saleId: existingSale.id,
        reused: true,
      };
    }

    try {
      const sale = await this.saleCreator.create(
        {
          externalId,
          note: `checkout_v2 draftId=${input.draftId} commandId=${input.commandId}`,
          items: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.qty,
            priceOverride: item.unitPrice,
            recipeOverride: item.recipe,
          })),
        },
        context
      );

      await this.markConfirmed(confirmation.id, sale.id);

      return {
        ok: true,
        code: 'FAST_CHECKOUT_V2_CONFIRMED',
        confirmationId: confirmation.id,
        saleId: sale.id,
        reused: false,
      };
    } catch (error) {
      if (isUniqueConflict(error)) {
        const recoveredSale = await this.saleCreator.findByExternalId(externalId);
        if (recoveredSale) {
          await this.markConfirmed(confirmation.id, recoveredSale.id);
          return {
            ok: true,
            code: 'FAST_CHECKOUT_V2_CONFIRMED',
            confirmationId: confirmation.id,
            saleId: recoveredSale.id,
            reused: true,
          };
        }
      }

      await this.markFailed(confirmation.id, 'CHECKOUT_V2_CREATE_SALE_FAILED');
      throw error;
    }
  }
}
