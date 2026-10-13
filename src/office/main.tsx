import React from 'react';
import ReactDOM from 'react-dom/client';
import { OfficeApp } from './OfficeApp';
import { MondayOwnerPage } from './MondayOwnerPage';
import { ProvenancePage } from './ProvenancePage';
import { CommunicationsPage } from './CommunicationsPage';
import './communications.css';
import './office.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{['/office/communications', '/office/communications/'].includes(window.location.pathname) ? <CommunicationsPage /> : ['/office/provenance', '/office/provenance/'].includes(window.location.pathname) ? <ProvenancePage /> : ['/office/monday', '/office/monday/'].includes(window.location.pathname) ? <MondayOwnerPage /> : <OfficeApp />}</React.StrictMode>,
);
