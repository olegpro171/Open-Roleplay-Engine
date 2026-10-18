import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import { ConfirmationProvider } from './Confirmation';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfirmationProvider><App /></ConfirmationProvider></React.StrictMode>);
