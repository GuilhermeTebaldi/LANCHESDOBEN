const decodeRouteParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const resolveSystemBasePath = (): string => {
  if (typeof window === 'undefined') return '';
  const [firstSegment] = window.location.pathname.split('/').filter(Boolean);
  return firstSegment === 'sistema' ? '/sistema' : '';
};

export const buildReceiptPrintRoutePath = (receiptId: string): string =>
  `${resolveSystemBasePath()}/print/${encodeURIComponent(receiptId)}`;

export const buildSalesReportPrintRoutePath = (payloadId: string): string =>
  `${resolveSystemBasePath()}/print/report/${encodeURIComponent(payloadId)}`;

export type PrintRouteTarget =
  | { kind: 'receipt'; id: string }
  | { kind: 'sales-report'; id: string };

export const resolvePrintRouteTarget = (): PrintRouteTarget | null => {
  if (typeof window === 'undefined') return null;
  const normalizedPath = window.location.pathname.replace(/\/+$/, '');
  const salesReportMatch = normalizedPath.match(/(?:^|\/)print\/report\/([^/]+)/i);
  if (salesReportMatch?.[1]) {
    return { kind: 'sales-report', id: decodeRouteParam(salesReportMatch[1]) };
  }

  const receiptMatch = normalizedPath.match(/(?:^|\/)print\/([^/]+)/i);
  if (!receiptMatch?.[1]) return null;
  return { kind: 'receipt', id: decodeRouteParam(receiptMatch[1]) };
};
