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

const PrintSalesReport: React.FC<PrintSalesReportProps> = ({ payloadId }) => {
  const [payload, setPayload] = useState<SalesReportPrintPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasTriggeredPrintRef = useRef(false);
  const hasRemovedPayloadRef = useRef(false);

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
    const timer = window.setTimeout(() => {
      window.print();
    }, 180);
    return () => {
      window.clearTimeout(timer);
    };
  }, [payload]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const previousAfterPrint = window.onafterprint;
    window.onafterprint = (event: Event) => {
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

  const reportText = useMemo(() => payload?.reportLines.join('\n') ?? '', [payload]);
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
        pre {
          margin: 0;
          font-family: inherit;
          font-size: inherit;
          line-height: inherit;
          font-weight: inherit;
          white-space: pre;
          letter-spacing: 0;
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
        }
      `}</style>

      <div className="report-paper">
        {payload && <pre>{reportText}</pre>}

        {!payload && (
          <>
            <p className="report-center report-strong">Erro ao gerar relatório</p>
            <p className="report-center">{errorMessage || 'Falha desconhecida.'}</p>
          </>
        )}
      </div>
    </div>
  );
};

export default PrintSalesReport;
