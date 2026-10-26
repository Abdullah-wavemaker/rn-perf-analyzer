import { useSyncExternalStore, type ReactElement } from 'react';
import { authStore } from './api/client';
import { ConfirmProvider } from './components/Confirm';
import { EmptyState } from './components/EmptyState';
import { Icon } from './components/Icon';
import { ToastProvider } from './components/Toast';
import { Shell } from './layout/Shell';
import { AppsPage } from './pages/AppsPage';
import { DevicesPage } from './pages/DevicesPage';
import { JourneysPage } from './pages/JourneysPage';
import { SessionsPage } from './pages/SessionsPage';
import { SessionPage } from './pages/session/SessionPage';
import { paths, useRoute, type Route } from './router';

export function App(): ReactElement {
  const auth = useSyncExternalStore(authStore.subscribe, authStore.get, authStore.get);
  const route = useRoute();

  if (auth === 'unauthenticated') return <NotAuthenticated />;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <Shell route={route}>
          <RouteView route={route} />
        </Shell>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function RouteView({ route }: { route: Route }): ReactElement {
  switch (route.name) {
    case 'sessions':
      return <SessionsPage />;
    case 'apps':
      return <AppsPage selectedId={route.appId} />;
    case 'devices':
      return <DevicesPage />;
    case 'journeys':
      return <JourneysPage />;
    case 'session':
      return <SessionPage key={route.id} id={route.id} tab={route.tab} query={route.query} />;
    default:
      return (
        <div className="page">
          <EmptyState icon="compass" title="Page not found" action={<a className="btn btn-default btn-md" href={paths.sessions()}>Go to sessions</a>}>
            Nothing lives at <span className="mono">{route.path}</span>.
          </EmptyState>
        </div>
      );
  }
}

function NotAuthenticated(): ReactElement {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-icon">
          <Icon name="alert" size={28} />
        </div>
        <h1>Not authenticated</h1>
        <p>
          Open the URL printed by <span className="mono">rnpa serve</span> in your terminal. It looks like{' '}
          <span className="mono">http://127.0.0.1:4310/auth?token=…</span> and sets a session cookie for this browser.
        </p>
        <p className="muted">The dashboard only accepts connections from this machine. Restarting the server issues a new launch token.</p>
        <button type="button" className="btn btn-default btn-md" onClick={() => window.location.reload()}>
          <Icon name="refresh" size={16} />
          <span className="btn-label">I've opened it — reload</span>
        </button>
      </div>
    </div>
  );
}
