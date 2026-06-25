import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  consumeSalesReportPrintPayload,
  removeSalesReportPrintPayload,
  type SalesReportPrintPayload,
} from '../utils/salesReportPrintPayload';
import { getReceiptPaperWidthMm } from '../utils/receiptPaper';

interface PrintSalesReportProps {
  payloadId: string;
}

const PRINT_ATTEMPT_DELAYS_MS = [80, 350, 900];

type ParsedReportLine =
  | { kind: 'blank' }
  | { kind: 'divider' }
  | { kind: 'row'; label: string; value: string }
  | { kind: 'text'; value: string; center: boolean; strong: boolean };

const parseReportLines = (lines: string[]): ParsedReportLine[] =>
  lines.map((rawLine) => {
    const withoutRightSpaces = rawLine.replace(/\s+$/, '');
    const line = withoutRightSpaces.trimStart();
    if (!line) return { kind: 'blank' };

    if (/^-{5,}$/.test(line)) {
      return { kind: 'divider' };
    }

    const pairMatch = line.match(/^(.*\S)\s{2,}(\S.*)$/);
    if (pairMatch) {
      return { kind: 'row', label: pairMatch[1], value: pairMatch[2] };
    }

    const isHeadline =
      /^[A-Z0-9À-Ý ()/.:_-]+$/.test(line) &&
      !line.startsWith('R$') &&
      !line.startsWith('#');
    return {
      kind: 'text',
      value: line,
      center: isHeadline,
      strong: isHeadline,
    };
  });

const PrintSalesReport: React.FC<PrintSalesReportProps> = ({ payloadId }) => {
  const [payload, setPayload] = useState<SalesReportPrintPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasTriggeredPrintRef = useRef(false);
  const hasRemovedPayloadRef = useRef(false);
  const printTimerRef = useRef<number | null>(null);
  const printAttemptTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const loaded = consumeSalesReportPrintPayload(payloadId);
    setPayload(loaded);
    setErrorMessage(loaded ? null : 'Relatório não encontrado para impressão.');
    hasTriggeredPrintRef.current = false;
    hasRemovedPayloadRef.current = false;
  }, [payloadId]);

  useEffect(() => {
    if (!payload) return;
    document.title = payload.title;
  }, [payload]);

  useEffect(() => {
    if (!payload) return;
    if (hasTriggeredPrintRef.current) return;
    hasTriggeredPrintRef.current = true;

    const printNow = () => {
      try {
        window.focus();
        window.print();
      } catch {
        hasTriggeredPrintRef.current = false;
      }
    };

    window.requestAnimationFrame(() => {
      printTimerRef.current = window.setTimeout(() => {
        printTimerRef.current = null;
        printNow();
      }, 0);
    });

    PRINT_ATTEMPT_DELAYS_MS.forEach((delay) => {
      const timer = window.setTimeout(() => {
        printAttemptTimersRef.current = printAttemptTimersRef.current.filter((entry) => entry !== timer);
        printNow();
      }, delay);
      printAttemptTimersRef.current.push(timer);
    });

    return () => {
      if (printTimerRef.current !== null) {
        window.clearTimeout(printTimerRef.current);
        printTimerRef.current = null;
      }
      printAttemptTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      printAttemptTimersRef.current = [];
    };
  }, [payload]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const previousAfterPrint = window.onafterprint;
    window.onafterprint = (event: Event) => {
      if (printTimerRef.current !== null) {
        window.clearTimeout(printTimerRef.current);
        printTimerRef.current = null;
      }
      printAttemptTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      printAttemptTimersRef.current = [];
      if (!hasRemovedPayloadRef.current) {
        removeSalesReportPrintPayload(payloadId);
        hasRemovedPayloadRef.current = true;
      }
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
  }, [payloadId]);

  const parsedLines = useMemo(
    () => parseReportLines(payload?.reportLines ?? []),
    [payload]
  );
  const paperWidthMm = useMemo(() => getReceiptPaperWidthMm(), []);

  return (
    <div className="report-shell">
      <style>{`
        @page { size: ${paperWidthMm}mm auto; margin: 0; }
        html, body {
          margin: 0;
          padding: 0;
          background: #fff;
          color: #000;
          font-family: "Courier New", Courier, monospace;
        }
        .report-shell {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          background: #fff;
        }
        .report-paper {
          width: ${paperWidthMm}mm;
          max-width: ${paperWidthMm}mm;
          padding: 3mm 2mm;
          font-size: 10px;
          line-height: 1.28;
          font-weight: 700;
          letter-spacing: 0;
        }
        .report-center { text-align: center; }
        .report-strong { font-weight: 900; }
        .report-divider {
          border-top: 2px dashed #000;
          margin: 6px 0;
        }
        .report-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: start;
          column-gap: 6px;
        }
        .report-label {
          min-width: 0;
          word-break: break-word;
        }
        .report-value {
          text-align: right;
          white-space: nowrap;
          font-weight: 800;
        }
        .report-text {
          margin: 0;
        }
        .report-blank {
          height: 5px;
        }
        .report-actions {
          display: flex;
          gap: 8px;
          margin: 14px 0 18px;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .report-actions button {
          border: 0;
          border-radius: 10px;
          background: #111827;
          color: #fff;
          font-size: 13px;
          font-weight: 800;
          padding: 10px 14px;
          cursor: pointer;
        }
        .report-actions button.secondary {
          background: #e5e7eb;
          color: #111827;
        }
        @media print {
          html, body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .report-shell { min-height: auto; }
          .report-paper {
            margin: 0;
            padding: 2.5mm 2mm;
            font-size: 10px;
            line-height: 1.25;
            font-weight: 700;
          }
          .report-paper * {
            color: #000 !important;
            text-shadow: none;
            -webkit-text-stroke: 0;
            text-rendering: optimizeLegibility;
          }
          .report-paper .report-strong {
            font-weight: 900 !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      <div className="report-paper">
        {payload &&
          parsedLines.map((line, index) => {
            if (line.kind === 'blank') {
              return <div key={`blank-${index}`} className="report-blank" />;
            }
            if (line.kind === 'divider') {
              return <div key={`divider-${index}`} className="report-divider" />;
            }
            if (line.kind === 'row') {
              return (
                <div key={`row-${index}`} className="report-row">
                  <span className="report-label">{line.label}</span>
                  <span className="report-value">{line.value}</span>
                </div>
              );
            }
            return (
              <p
                key={`text-${index}`}
                className={[
                  'report-text',
                  line.center ? 'report-center' : '',
                  line.strong ? 'report-strong' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {line.value}
              </p>
            );
          })}

        {!payload && (
          <>
            <p className="report-center report-strong">Erro ao gerar relatório</p>
            <p className="report-center">{errorMessage || 'Falha desconhecida.'}</p>
          </>
        )}
      </div>
      <div className="report-actions no-print">
        <button
          type="button"
          onClick={() => {
            window.focus();
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

export default PrintSalesReport;
