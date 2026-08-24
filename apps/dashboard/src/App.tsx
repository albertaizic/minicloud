import { Outlet, Link, useLocation } from 'react-router-dom';

export default function App() {
  const location = useLocation();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">◆</span> MiniCloud
        </Link>
        <span className="tagline">local platform · deploys from git to docker</span>
        <nav>
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>Overview</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
