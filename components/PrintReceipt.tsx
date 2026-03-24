import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_APP_STATE, loadAppState, type AppState } from '../data/appStorage';
import type { Sale, SaleBasePaymentMethod, SaleDraft, SaleOrigin, SalePaymentMethod, SalePaymentSplitEntry } from '../types';
import { getReceiptPaperWidthMm } from '../utils/receiptPaper';
import {
  consumeReceiptPrintPayload,
  removeReceiptPrintPayload,
  type ReceiptPrintPayload,
} from '../utils/receiptPrintPayload';

interface PrintReceiptProps {
  receiptId: string;
}

interface ReceiptLine {
  id: string;
  qty: number;
  name: string;
  unitPrice: number;
  subtotal: number;
  note?: string;
}

interface ReceiptViewModel {
  restaurantName: string;
  orderNumber: number | null;
  orderId: string;
  paidAt: Date | null;
  lines: ReceiptLine[];
  itemsTotal: number;
  total: number;
  paymentMethodLabel: string;
  paymentCashReceived: number | null;
  paymentChange: number | null;
  paymentSplits: Array<{
    label: string;
    methodLabel: string;
    amount: number;
    cashReceived: number | null;
    change: number | null;
  }>;
  saleOriginLabel: string | null;
  saleOriginShortLabel: string | null;
  appOrderTotal: number | null;
  isAppSale: boolean;
  observations: string[];
}

const DEFAULT_RESTAURANT_NAME = 'LANCHESDOBEN';
const RECEIPT_LOAD_RETRY_DELAY_MS = 180;
const RECEIPT_LOAD_MAX_WAIT_MS = 15000;

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const roundMoney = (value: number): number => Number(value.toFixed(2));

const formatMoney = (value: number): string =>
  moneyFormatter.format(Number.isFinite(value) ? value : 0);

const normalizeMoneyValue = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return roundMoney(value);
};

const formatDateTime = (value: Date | null): string => {
  if (!value) return '--';
  const datePart = value.toLocaleDateString('pt-BR');
  const timePart = value.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${datePart} ${timePart}`;
};

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const getRestaurantName = (): string => {
  if (typeof window === 'undefined') return DEFAULT_RESTAURANT_NAME;
  const local = normalizeText(window.localStorage.getItem('qb_restaurant_name'));
  return local || DEFAULT_RESTAURANT_NAME;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

const isSameCalendarDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const formatBasePaymentMethod = (method: SaleBasePaymentMethod): string => {
  if (method === 'DEBITO') return 'DEBITO';
  if (method === 'CREDITO') return 'CREDITO';
  if (method === 'DINHEIRO') return 'DINHEIRO';
  return method;
};

const formatPaymentMethod = (method: SalePaymentMethod | null | undefined): string => {
  if (!method) return 'NAO INFORMADO';
  if (method === 'DIVIDIDO') return 'DIVIDIDO';
  if (method === 'DEBITO') return 'DEBITO';
  if (method === 'CREDITO') return 'CREDITO';
  if (method === 'DINHEIRO') return 'DINHEIRO';
  return method;
};

const normalizeSplitPayments = (entries: SalePaymentSplitEntry[] | undefined) =>
  (entries || [])
    .filter((entry): entry is SalePaymentSplitEntry => Boolean(entry && entry.method && Number.isFinite(entry.amount)))
    .map((entry, index) => {
      const amount = normalizeMoneyValue(entry.amount) ?? 0;
      const cashReceived = normalizeMoneyValue(entry.cashReceived);
      const change = normalizeMoneyValue(entry.change);
      return {
        label: normalizeText(entry.label) || `Parcela ${index + 1}`,
        methodLabel: formatBasePaymentMethod(entry.method),
        amount,
        cashReceived,
        change,
      };
    });

const summarizeSplitPaymentMethods = (
  splits: Array<{ methodLabel: string }>
): string => {
  const orderedUniqueMethods: string[] = [];
  splits.forEach((split) => {
    if (!orderedUniqueMethods.includes(split.methodLabel)) {
      orderedUniqueMethods.push(split.methodLabel);
    }
  });
  return orderedUniqueMethods.length > 0 ? orderedUniqueMethods.join(' + ') : 'NAO INFORMADO';
};

const isAppSaleOrigin = (origin: SaleOrigin): boolean =>
  origin === 'IFOOD' || origin === 'APP99' || origin === 'KEETA';

const formatSaleOrigin = (origin: SaleOrigin | null | undefined): string => {
  if (origin === 'IFOOD') return 'IFOOD';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'KEETA';
  return 'BALCAO';
};

const formatSaleOriginShort = (origin: SaleOrigin | null | undefined): string | null => {
  if (origin === 'IFOOD') return 'IF';
  if (origin === 'APP99') return '99';
  if (origin === 'KEETA') return 'KT';
  return null;
};

const collectSales = (state: AppState): Sale[] => {
  const grouped = new Map<string, Sale>();
  state.sales.forEach((sale) => grouped.set(sale.id, sale));
  state.globalSales.forEach((sale) => {
    if (!grouped.has(sale.id)) {
      grouped.set(sale.id, sale);
    }
  });
  return [...grouped.values()];
};

const getOrderGroupKey = (sale: Sale): string =>
  sale.saleDraftId ? `draft:${sale.saleDraftId}` : `sale:${sale.id}`;

const buildOrderNumberByGroup = (allSales: Sale[]): Map<string, number> => {
  const firstTimestampByGroup = new Map<string, number>();

  allSales.forEach((sale) => {
    const key = getOrderGroupKey(sale);
    const saleDate = toDate(sale.timestamp);
    const currentTs = saleDate ? saleDate.getTime() : Number.POSITIVE_INFINITY;
    const existingTs = firstTimestampByGroup.get(key);
    if (existingTs === undefined || currentTs < existingTs) {
      firstTimestampByGroup.set(key, currentTs);
    }
  });

  const orderedGroups = [...firstTimestampByGroup.entries()].sort((a, b) => {
    const tsDiff = a[1] - b[1];
    if (tsDiff !== 0) return tsDiff;
    return a[0].localeCompare(b[0]);
  });

  const numberByGroup = new Map<string, number>();
  orderedGroups.forEach(([groupKey], index) => {
    numberByGroup.set(groupKey, index + 1);
  });
  return numberByGroup;
};

const resolveReceiptSales = (
  allSales: Sale[],
  receiptId: string
): { orderId: string; targetSale: Sale; sales: Sale[] } | null => {
  const directSale = allSales.find((sale) => sale.id === receiptId);
  if (directSale) {
    if (directSale.saleDraftId) {
      const groupSales = allSales.filter((sale) => sale.saleDraftId === directSale.saleDraftId);
      return {
        orderId: directSale.saleDraftId,
        targetSale: directSale,
        sales: groupSales.length > 0 ? groupSales : [directSale],
      };
    }
    return {
      orderId: directSale.id,
      targetSale: directSale,
      sales: [directSale],
    };
  }

  const byDraft = allSales.filter((sale) => sale.saleDraftId === receiptId);
  if (byDraft.length === 0) return null;

  return {
    orderId: receiptId,
    targetSale: byDraft[0],
    sales: byDraft,
  };
};

const buildReceiptLines = (
  sales: Sale[],
  draft: SaleDraft | undefined
): { lines: ReceiptLine[]; observations: string[] } => {
  const draftItemById = new Map<string, SaleDraft['items'][number]>();
  if (draft) {
    draft.items.forEach((item) => {
      draftItemById.set(item.id, item);
    });
  }

  const observations: string[] = [];
  const lines = sales.map((sale) => {
    let qty = 1;
    let unitPrice = roundMoney(sale.total);
    let note: string | undefined;

    if (draft && sale.saleDraftId === draft.id) {
      const prefix = `${draft.id}-`;
      const draftItemId = sale.id.startsWith(prefix) ? sale.id.slice(prefix.length) : '';
      const draftItem = draftItemId ? draftItemById.get(draftItemId) : undefined;

      if (draftItem) {
        qty = Number.isFinite(draftItem.qty) && draftItem.qty > 0 ? draftItem.qty : 1;
        if (
          typeof draftItem.unitPriceSnapshot === 'number' &&
          Number.isFinite(draftItem.unitPriceSnapshot)
        ) {
          unitPrice = roundMoney(draftItem.unitPriceSnapshot);
        } else {
          unitPrice = roundMoney(sale.total / qty);
        }

        const normalizedNote = normalizeText(draftItem.note);
        if (normalizedNote) {
          note = normalizedNote;
          observations.push(`${draftItem.nameSnapshot || sale.productName}: ${normalizedNote}`);
        }
      }
    }

    const lineOrigin = sale.saleOrigin || draft?.saleOrigin || 'LOCAL';
    if (isAppSaleOrigin(lineOrigin)) {
      unitPrice = qty > 0 ? roundMoney(sale.total / qty) : roundMoney(sale.total);
    }

    return {
      id: sale.id,
      qty,
      name: sale.productName,
      unitPrice,
      subtotal: roundMoney(sale.total),
      note,
    };
  });

  return { lines, observations };
};

const buildReceiptViewModel = (state: AppState, receiptId: string): ReceiptViewModel | null => {
  const allSales = collectSales(state);
  const resolved = resolveReceiptSales(allSales, receiptId);
  if (!resolved) return null;

  const { orderId, targetSale, sales } = resolved;
  const orderGroupKey = getOrderGroupKey(targetSale);
  const sessionOrderNumberByGroup = buildOrderNumberByGroup(state.sales);
  let orderNumber = sessionOrderNumberByGroup.get(orderGroupKey) ?? null;

  if (orderNumber === null) {
    const targetSaleDate = toDate(targetSale.timestamp);
    if (targetSaleDate) {
      const sameDaySales = allSales.filter((sale) => {
        const saleDate = toDate(sale.timestamp);
        return saleDate ? isSameCalendarDay(saleDate, targetSaleDate) : false;
      });
      const dayOrderNumberByGroup = buildOrderNumberByGroup(sameDaySales);
      orderNumber = dayOrderNumberByGroup.get(orderGroupKey) ?? null;
    }
  }

  const relatedDraft = targetSale.saleDraftId
    ? state.saleDrafts.find((draft) => draft.id === targetSale.saleDraftId)
    : undefined;

  const { lines, observations } = buildReceiptLines(sales, relatedDraft);
  const linesTotal = roundMoney(lines.reduce((sum, line) => sum + line.subtotal, 0));
  const saleOrigin = relatedDraft?.saleOrigin || targetSale.saleOrigin || 'LOCAL';
  const isAppSale = isAppSaleOrigin(saleOrigin);
  const appOrderTotal = isAppSale
    ? normalizeMoneyValue(relatedDraft?.appOrderTotal ?? targetSale.appOrderTotal)
    : null;
  const total = isAppSale ? appOrderTotal ?? linesTotal : linesTotal;

  const paidAt =
    toDate(relatedDraft?.payment?.confirmedAt) ||
    toDate(targetSale.payment?.confirmedAt) ||
    toDate(targetSale.timestamp);

  const payment = relatedDraft?.payment ?? targetSale.payment;
  const paymentMethod = payment?.method ?? null;
  const paymentCashReceived = normalizeMoneyValue(payment?.cashReceived);
  const paymentChange = normalizeMoneyValue(payment?.change);
  const paymentSplits = paymentMethod === 'DIVIDIDO' ? normalizeSplitPayments(payment?.splitPayments) : [];
  const paymentMethodLabel =
    paymentMethod === 'DIVIDIDO'
      ? summarizeSplitPaymentMethods(paymentSplits)
      : formatPaymentMethod(paymentMethod);

  return {
    restaurantName: getRestaurantName(),
    orderNumber,
    orderId,
    paidAt,
    lines,
    itemsTotal: linesTotal,
    total,
    paymentMethodLabel,
    paymentCashReceived,
    paymentChange,
    paymentSplits,
    saleOriginLabel: isAppSale ? formatSaleOrigin(saleOrigin) : null,
    saleOriginShortLabel: formatSaleOriginShort(saleOrigin),
    appOrderTotal,
    isAppSale,
    observations,
  };
};

const buildReceiptViewModelFromPayload = (
  payload: ReceiptPrintPayload
): ReceiptViewModel | null => {
  const data = payload.receipt;
  if (!data || !Array.isArray(data.lines) || data.lines.length === 0) return null;

  const lines = data.lines.map((line) => ({
    id: line.id,
    qty: Math.max(1, Math.round(Number(line.qty) || 1)),
    name: line.name || 'Item',
    unitPrice: roundMoney(Math.max(0, Number(line.unitPrice) || 0)),
    subtotal: roundMoney(Math.max(0, Number(line.subtotal) || 0)),
    note: normalizeText(line.note || undefined) || undefined,
  }));

  const paymentSplits = (data.paymentSplits || []).map((split, index) => ({
    label: normalizeText(split.label) || `Parcela ${index + 1}`,
    methodLabel: normalizeText(split.methodLabel) || 'NAO INFORMADO',
    amount: roundMoney(Math.max(0, Number(split.amount) || 0)),
    cashReceived: normalizeMoneyValue(split.cashReceived),
    change: normalizeMoneyValue(split.change),
  }));

  const observations = (data.observations || [])
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => Boolean(entry));

  return {
    restaurantName: normalizeText(data.restaurantName) || DEFAULT_RESTAURANT_NAME,
    orderNumber:
      data.orderNumber === null || data.orderNumber === undefined
        ? null
        : Math.max(0, Math.round(Number(data.orderNumber) || 0)),
    orderId: normalizeText(data.orderId) || '--',
    paidAt: toDate(data.paidAtIso),
    lines,
    itemsTotal: roundMoney(Math.max(0, Number(data.itemsTotal) || 0)),
    total: roundMoney(Math.max(0, Number(data.total) || 0)),
    paymentMethodLabel: normalizeText(data.paymentMethodLabel) || 'NAO INFORMADO',
    paymentCashReceived: normalizeMoneyValue(data.paymentCashReceived),
    paymentChange: normalizeMoneyValue(data.paymentChange),
    paymentSplits,
    saleOriginLabel: normalizeText(data.saleOriginLabel),
    saleOriginShortLabel: normalizeText(data.saleOriginShortLabel),
    appOrderTotal: normalizeMoneyValue(data.appOrderTotal),
    isAppSale: Boolean(data.isAppSale),
    observations,
  };
};

const PrintReceipt: React.FC<PrintReceiptProps> = ({ receiptId }) => {
  const [receipt, setReceipt] = useState<ReceiptViewModel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasTriggeredPrintRef = useRef(false);
  const printTimerRef = useRef<number | null>(null);
  const paperWidthMm = useMemo(() => getReceiptPaperWidthMm(), []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;
    let hadLoadFailure = false;
    const startedAt = Date.now();
    setIsLoading(true);
    setErrorMessage(null);
    setReceipt(null);
    hasTriggeredPrintRef.current = false;
    if (printTimerRef.current !== null) {
      window.clearTimeout(printTimerRef.current);
      printTimerRef.current = null;
    }

    const localPayload = consumeReceiptPrintPayload(receiptId);
    if (localPayload) {
      const payloadModel = buildReceiptViewModelFromPayload(localPayload);
      if (payloadModel) {
        setReceipt(payloadModel);
        setIsLoading(false);
        return () => {
          cancelled = true;
        };
      }
    }

    const scheduleRetry = () => {
      if (cancelled) return;
      retryTimer = window.setTimeout(() => {
        void loadReceipt();
      }, RECEIPT_LOAD_RETRY_DELAY_MS);
    };

    const loadReceipt = async () => {
      try {
        const state = await loadAppState(DEFAULT_APP_STATE);
        if (cancelled) return;
        const model = buildReceiptViewModel(state, receiptId);
        if (model) {
          setReceipt(model);
          setIsLoading(false);
          return;
        }
      } catch {
        hadLoadFailure = true;
      }

      if (cancelled) return;

      if (Date.now() - startedAt >= RECEIPT_LOAD_MAX_WAIT_MS) {
        setErrorMessage(
          hadLoadFailure
            ? 'Falha ao carregar dados do cupom.'
            : 'Pedido não encontrado para impressão.'
        );
        setIsLoading(false);
        return;
      }

      scheduleRetry();
    };

    void loadReceipt();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [receiptId]);

  const triggerAutoPrint = useCallback((): boolean => {
    if (!receipt) return false;
    if (hasTriggeredPrintRef.current) return false;
    if (document.visibilityState === 'hidden') return false;

    hasTriggeredPrintRef.current = true;
    if (printTimerRef.current !== null) {
      window.clearTimeout(printTimerRef.current);
      printTimerRef.current = null;
    }

    printTimerRef.current = window.setTimeout(() => {
      printTimerRef.current = null;
      try {
        window.focus();
      } catch {
        // ignore focus failures
      }
      try {
        window.print();
      } catch {
        hasTriggeredPrintRef.current = false;
      }
    }, 180);

    return true;
  }, [receipt]);

  useEffect(() => {
    if (!receipt) return;
    const tryPrint = () => {
      void triggerAutoPrint();
    };

    tryPrint();
    window.addEventListener('focus', tryPrint);
    window.addEventListener('pageshow', tryPrint);
    document.addEventListener('visibilitychange', tryPrint);

    return () => {
      window.removeEventListener('focus', tryPrint);
      window.removeEventListener('pageshow', tryPrint);
      document.removeEventListener('visibilitychange', tryPrint);
      if (printTimerRef.current !== null) {
        window.clearTimeout(printTimerRef.current);
        printTimerRef.current = null;
      }
    };
  }, [receipt, triggerAutoPrint]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const previousAfterPrint = window.onafterprint;
    window.onafterprint = (event: Event) => {
      removeReceiptPrintPayload(receiptId);
      try {
        window.close();
      } catch {
        // ignore close failures
      }
      if (typeof previousAfterPrint === 'function') {
        previousAfterPrint.call(window, event);
      }
    };
    return () => {
      window.onafterprint = previousAfterPrint;
    };
  }, [receiptId]);

  const printedAt = useMemo(() => new Date(), []);

  return (
    <div className="receipt-shell">
      <style>{`
        @page { size: ${paperWidthMm}mm auto; margin: 0; }
        html, body {
          margin: 0;
          padding: 0;
          background: #fff;
          color: #000;
          font-family: "Courier New", Courier, monospace;
        }
        .receipt-shell {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          background: #fff;
        }
        .receipt-paper {
          width: ${paperWidthMm}mm;
          max-width: ${paperWidthMm}mm;
          padding: 3mm 2mm;
          font-size: 10px;
          line-height: 1.28;
          font-weight: 700;
          letter-spacing: 0;
        }
        .receipt-center { text-align: center; }
        .receipt-strong { font-weight: 900; }
        .receipt-divider {
          border-top: 2px dashed #000;
          margin: 6px 0;
        }
        .receipt-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: start;
          column-gap: 6px;
        }
        .receipt-label {
          min-width: 0;
          word-break: break-word;
        }
        .receipt-value {
          text-align: right;
          white-space: nowrap;
        }
        .receipt-value-break {
          white-space: normal;
          word-break: break-all;
        }
        .receipt-item .receipt-row:first-child {
          font-weight: 800;
        }
        .receipt-row .receipt-value {
          font-weight: 800;
        }
        .receipt-item + .receipt-item {
          margin-top: 5px;
        }
        .receipt-note {
          margin-top: 2px;
          font-size: 10px;
          font-weight: 700;
        }
        .receipt-badge {
          display: inline-block;
          border: 1px solid #000;
          border-radius: 999px;
          padding: 0 5px;
          margin-left: 4px;
          font-size: 9px;
          line-height: 1.2;
          vertical-align: middle;
        }
        .receipt-actions {
          margin: 18px 0 28px;
          display: flex;
          gap: 8px;
        }
        .receipt-actions button {
          border: 1px solid #111;
          background: #111;
          color: #fff;
          border-radius: 8px;
          padding: 8px 12px;
          font-family: inherit;
          font-weight: 700;
          font-size: 12px;
          cursor: pointer;
        }
        .receipt-actions button.secondary {
          background: #fff;
          color: #111;
        }
        @media print {
          html, body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .no-print { display: none !important; }
          .receipt-shell { min-height: auto; }
          .receipt-paper {
            margin: 0;
            padding: 2.5mm 2mm;
            font-size: 10px;
            line-height: 1.25;
            font-weight: 700;
          }
          .receipt-paper * {
            color: #000 !important;
            text-shadow: none;
            -webkit-text-stroke: 0;
            text-rendering: optimizeLegibility;
          }
          .receipt-paper .receipt-strong {
            font-weight: 900 !important;
          }
        }
      `}</style>

      <div className="receipt-paper">
        {isLoading && <p className="receipt-center">Carregando cupom...</p>}

        {!isLoading && errorMessage && (
          <>
            <p className="receipt-center receipt-strong">Erro ao gerar cupom</p>
            <p className="receipt-center">{errorMessage}</p>
          </>
        )}

        {!isLoading && receipt && (
          <>
            <div className="receipt-center">
              <div className="receipt-strong">{receipt.restaurantName}</div>
              <div>CUPOM NAO FISCAL</div>
            </div>

            <div className="receipt-divider" />

            <div className="receipt-row">
              <span className="receipt-label receipt-strong">Pedido</span>
              <span className="receipt-value">{receipt.orderNumber ? String(receipt.orderNumber) : '--'}</span>
            </div>
            <div className="receipt-row">
              <span className="receipt-label">Código</span>
              <span className="receipt-value receipt-value-break">{receipt.orderId}</span>
            </div>
            <div className="receipt-row">
              <span className="receipt-label">Pago em</span>
              <span className="receipt-value">{formatDateTime(receipt.paidAt)}</span>
            </div>
            <div className="receipt-row">
              <span className="receipt-label">Impresso em</span>
              <span className="receipt-value">{formatDateTime(printedAt)}</span>
            </div>
            <div className="receipt-row">
              <span className="receipt-label">Pagamento</span>
              <span className="receipt-value">{receipt.paymentMethodLabel}</span>
            </div>
            {receipt.saleOriginLabel && (
              <div className="receipt-row">
                <span className="receipt-label">Canal</span>
                <span className="receipt-value">{receipt.saleOriginLabel}</span>
              </div>
            )}
            {receipt.paymentMethodLabel === 'DINHEIRO' && receipt.paymentCashReceived !== null && (
              <div className="receipt-row">
                <span className="receipt-label">Recebido</span>
                <span className="receipt-value">{formatMoney(receipt.paymentCashReceived)}</span>
              </div>
            )}
            {receipt.paymentMethodLabel === 'DINHEIRO' && receipt.paymentChange !== null && (
              <div className="receipt-row">
                <span className="receipt-label">{receipt.paymentChange >= 0 ? 'Troco' : 'Faltam'}</span>
                <span className="receipt-value">{formatMoney(Math.abs(receipt.paymentChange))}</span>
              </div>
            )}
            {receipt.paymentSplits.length > 0 && (
              <>
                {receipt.paymentSplits.map((split, index) => (
                  <React.Fragment key={`${split.label}-${index}`}>
                    <div className="receipt-row">
                      <span className="receipt-label">{`Pagamento ${index + 1} (${split.methodLabel})`}</span>
                      <span className="receipt-value">{formatMoney(split.amount)}</span>
                    </div>
                    {split.methodLabel === 'DINHEIRO' && split.cashReceived !== null && (
                      <div className="receipt-row">
                        <span className="receipt-label">Recebido {split.label}</span>
                        <span className="receipt-value">{formatMoney(split.cashReceived)}</span>
                      </div>
                    )}
                    {split.methodLabel === 'DINHEIRO' && split.change !== null && (
                      <div className="receipt-row">
                        <span className="receipt-label">{split.change >= 0 ? 'Troco' : 'Faltam'}</span>
                        <span className="receipt-value">{formatMoney(Math.abs(split.change))}</span>
                      </div>
                    )}
                  </React.Fragment>
                ))}
              </>
            )}

            <div className="receipt-divider" />

            {receipt.lines.map((line) => (
              <div key={line.id} className="receipt-item">
                <div className="receipt-row">
                  <span className="receipt-label">
                    {line.qty}x {line.name}
                  </span>
                  <span className="receipt-value">{formatMoney(line.subtotal)}</span>
                </div>
                <div className="receipt-row">
                  <span className="receipt-label">Valor un.</span>
                  <span className="receipt-value">{formatMoney(line.unitPrice)}</span>
                </div>
                {line.note && <div className="receipt-note">Obs: {line.note}</div>}
              </div>
            ))}

            {receipt.observations.length > 0 && (
              <>
                <div className="receipt-divider" />
                <div className="receipt-strong">OBSERVACOES</div>
                {receipt.observations.map((observation, index) => (
                  <div key={`${observation}-${index}`} className="receipt-note">
                    - {observation}
                  </div>
                ))}
              </>
            )}

            <div className="receipt-divider" />

            {receipt.isAppSale && (
              <div className="receipt-row">
                <span className="receipt-label">Total itens</span>
                <span className="receipt-value">{formatMoney(receipt.itemsTotal)}</span>
              </div>
            )}

            <div className="receipt-row receipt-strong">
              <span className="receipt-label">
                TOTAL
                {receipt.saleOriginShortLabel && (
                  <span className="receipt-badge">{receipt.saleOriginShortLabel}</span>
                )}
              </span>
              <span className="receipt-value">{formatMoney(receipt.total)}</span>
            </div>

            <div className="receipt-divider" />
            <p className="receipt-center">Obrigado e volte sempre!</p>
          </>
        )}
      </div>

      <div className="receipt-actions no-print">
        <button
          type="button"
          onClick={() => {
            window.print();
          }}
        >
          Imprimir
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            window.close();
          }}
        >
          Fechar
        </button>
      </div>
    </div>
  );
};

export default PrintReceipt;
