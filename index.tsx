
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PrintReceipt from './components/PrintReceipt';
import PrintSalesReport from './components/PrintSalesReport';
import { installGlobalErrorMonitor } from './utils/errorMonitorClient';
import { resolvePrintRouteTarget } from './utils/printRoutes';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const printRouteTarget = resolvePrintRouteTarget();
installGlobalErrorMonitor('sistema');

root.render(
  <React.StrictMode>
    {printRouteTarget?.kind === 'sales-report' ? (
      <PrintSalesReport payloadId={printRouteTarget.id} />
    ) : printRouteTarget?.kind === 'receipt' ? (
      <PrintReceipt receiptId={printRouteTarget.id} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
