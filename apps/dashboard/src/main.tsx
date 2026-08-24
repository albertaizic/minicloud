import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';
import App from './App.js';
import Overview from './pages/Overview.js';
import AppDetail from './pages/AppDetail.js';
import DeploymentDetail from './pages/DeploymentDetail.js';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route path="/" element={<Overview />} />
          <Route path="/apps/:id" element={<AppDetail />} />
          <Route path="/deployments/:id" element={<DeploymentDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
