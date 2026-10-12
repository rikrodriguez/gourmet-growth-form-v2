import React from 'react';
import ReactDOM from 'react-dom/client';
import { OfficeApp } from './OfficeApp';
import { MondayOwnerPage } from './MondayOwnerPage';
import { ProvenancePage } from './ProvenancePage';
import './office.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{['/office/provenance', '/office/provenance/'].includes(window.location.pathname) ? <ProvenancePage /> : ['/office/monday', '/office/monday/'].includes(window.location.pathname) ? <MondayOwnerPage /> : <OfficeApp />}</React.StrictMode>,
);
