import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import FirebaseGate from './AuthGate.jsx';
import './styles.css';
import './firebase-workflow.css';
import './admin-dashboard.css';
import './dark-mode.css';
import './pastel-blue.css';
import './suppliers.css';
import './equipment.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <FirebaseGate>
      <App />
    </FirebaseGate>
  </React.StrictMode>,
);
