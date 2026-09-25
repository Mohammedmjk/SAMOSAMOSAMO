import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "https://a7c96a81388ef064498da248c89269b5@o4512148160643072.ingest.de.sentry.io/4512148175126608"
});
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
