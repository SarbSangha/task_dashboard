import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { creditReportAPI } from '../../services/reports';
import { savePendingOutput } from '../../utils/pendingOutput';

/**
 * Landing page for the Credit Report workbook's "Open output" links
 * (<PUBLIC_DASHBOARD_URL>/open-output?ref=<Tool>:<id>).
 *
 * The workbook cannot hold the file URL itself: mirrored outputs live in a
 * private bucket behind short-lived signed links. This page asks the API for
 * a fresh URL and forwards the browser to it. Signed-out visitors are sent
 * to login first; the ref is remembered and reopened by
 * resumePendingOutput() (utils/pendingOutput.js) once they reach the dashboard.
 */

const parseRef = (ref) => {
  const match = /^(.+):(\d+)$/.exec(ref || '');
  return match ? { tool: match[1], id: match[2] } : null;
};

const box = {
  maxWidth: 480,
  margin: '15vh auto',
  padding: '28px 32px',
  borderRadius: 14,
  background: 'var(--color-surface-modal, #fff)',
  color: 'var(--color-text, #111)',
  border: '1px solid var(--color-border-subtle, #ddd)',
  fontFamily: 'inherit',
  textAlign: 'center',
};

export default function OpenOutputPage() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const ref = params.get('ref') || '';

  useEffect(() => {
    if (loading) return;
    const parsed = parseRef(ref);
    if (!parsed) {
      setError('This output link is incomplete.');
      return;
    }
    if (!user) {
      savePendingOutput(ref);
      navigate('/login', { replace: true });
      return;
    }
    let cancelled = false;
    creditReportAPI.outputUrl(parsed.tool, parsed.id)
      .then((data) => {
        if (!cancelled && data?.url) window.location.replace(data.url);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.status === 404
          ? 'This generation has no stored output.'
          : 'Could not open this output. Try again from the dashboard.');
      });
    return () => { cancelled = true; };
  }, [loading, user, ref, navigate]);

  return (
    <div style={box} role="status">
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{error ? 'Output unavailable' : 'Opening output…'}</h2>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 14 }}>
        {error || 'You will be taken to the file in a moment.'}
      </p>
      {error && (
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          style={{ marginTop: 18, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: 'var(--color-button-primary-bg, #1f3864)', color: 'var(--color-button-primary-text, #fff)' }}
        >
          Go to dashboard
        </button>
      )}
    </div>
  );
}
