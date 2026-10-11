import React from 'react';
import ReactDOM from 'react-dom/client';
import { OfficeApp } from './OfficeApp';
import { MondayOwnerPage } from './MondayOwnerPage';
import './office.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{['/office/monday', '/office/monday/'].includes(window.location.pathname) ? <MondayOwnerPage /> : <OfficeApp />}</React.StrictMode>,
);
