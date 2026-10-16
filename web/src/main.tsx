import { Component, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { requestFromHash } from './lib/fileLinks';
import { defaultTrusted, frameVerdict, standaloneUrl, type FrameVerdict } from './lib/framing';
import './styles.css';
import './conversation.css';

// Last-resort guard: React unmounts the WHOLE tree on an uncaught render
// error, which reads as a blank white page. Show a reload card instead.
class Boundary extends Component<{ children: ReactNode }, { err: unknown }> {
  state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) { return { err }; }
  componentDidCatch(err: unknown) { console.error('[render crash]', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Something broke in the UI</h2>
          <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
            The error is logged in the browser console. Your agents keep running; reloading usually fixes the view.
          </p>
          <button
            style={{ padding: '8px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: '1px solid #8884', background: 'transparent', color: 'inherit' }}
            onClick={() => location.reload()}
          >Reload</button>
        </div>
      </div>
    );
  }
}

// No StrictMode: it double-mounts in dev, which would open duplicate WebSockets.
const FileLinkPage = lazy(() => import('./components/FileLinkPage'));
function Entry() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  // Keep request identity stable while the page renders metadata or copies a URL.
  const request = useMemo(() => requestFromHash(hash), [hash]);
  return request
    ? <Suspense fallback={<div className="fv-empty">Loading file preview…</div>}><FileLinkPage key={hash} request={request} /></Suspense>
    : <App />;
}

// Inside a frame, render nothing until every ancestor is known to be trusted
// (lib/framing.ts). Top-level loads and the Hub's own embed decide synchronously.
function FrameGate({ children }: { children: ReactNode }) {
  const env = { win: window, referrer: document.referrer };
  const [verdict, setVerdict] = useState<FrameVerdict | 'checking'>(() => {
    const first = frameVerdict(env, defaultTrusted(window));
    return first === 'untrusted' ? 'checking' : first;
  });
  useEffect(() => {
    if (verdict !== 'checking') return;
    // The server may allow more embedders (AM_FRAME_ANCESTORS). Plain fetch: this
    // is a read, and the app's API helpers would start lock/state side effects.
    let live = true;
    fetch('/api/info', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((info) => {
        const extra = Array.isArray(info?.frameAncestors) ? info.frameAncestors.filter((o: unknown) => typeof o === 'string') : [];
        if (live) setVerdict(frameVerdict(env, [...defaultTrusted(window), ...extra]));
      });
    return () => { live = false; };
  }, [verdict]);
  if (verdict === 'top' || verdict === 'trusted') return <>{children}</>;
  if (verdict === 'checking') return null;
  return <FramedElsewhere />;
}

function FramedElsewhere() {
  return (
    <div className="framed-elsewhere" style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Agent Manager is embedded in another site</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
          For your safety it only runs in its own tab or on its Hugging Face Space page.
        </p>
        <button
          style={{ padding: '8px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6, border: '1px solid #8884', background: 'transparent', color: 'inherit' }}
          onClick={() => window.open(standaloneUrl(location.href), '_blank', 'noopener,noreferrer')}
        >Open Agent Manager</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Boundary><FrameGate><Entry /></FrameGate></Boundary>);

// Push notifications ride on this worker (agents message the operator on request).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* unsupported context */ });
}
