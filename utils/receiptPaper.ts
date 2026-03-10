const DEFAULT_RECEIPT_PAPER_WIDTH_MM = 58;
const MIN_RECEIPT_PAPER_WIDTH_MM = 48;
const MAX_RECEIPT_PAPER_WIDTH_MM = 80;

export const clampReceiptPaperWidthMm = (value: number): number =>
  Math.min(MAX_RECEIPT_PAPER_WIDTH_MM, Math.max(MIN_RECEIPT_PAPER_WIDTH_MM, Math.round(value)));

export const getReceiptPaperWidthMm = (): number => {
  if (typeof window === 'undefined') return DEFAULT_RECEIPT_PAPER_WIDTH_MM;

  const raw = window.localStorage.getItem('qb_receipt_paper_width_mm');
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_RECEIPT_PAPER_WIDTH_MM;
  return clampReceiptPaperWidthMm(parsed);
};
