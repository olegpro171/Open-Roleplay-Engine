import { applyTheme, initialTheme } from './theme';
import { LocalizationStartup } from './localization';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './palette.css';
import './style.css';
import { ConfirmationProvider } from './Confirmation';
import { trackPopupInput } from './popup-input';
import { trackPressedControls } from './pressed-controls';

applyTheme(initialTheme());
trackPopupInput();
trackPressedControls();

createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalizationStartup /><ConfirmationProvider><App /></ConfirmationProvider></React.StrictMode>);
