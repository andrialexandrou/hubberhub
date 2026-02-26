import { useState, useEffect, useCallback } from 'react';

const PRIORITY_LABELS = {
  high: 'Action Needed',
  medium: 'For Your Info',
  noise: 'State Changes',
  other: 'Everything Else',
};

const TYPE_ICONS = {
  PullRequest: '⬡',
  Issue: '●',
  Discussion: '💬',
};

const REASON_LABELS = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  assign: 'Assigned',
  author: 'Author',
  comment: 'Comment',
  team_mention: 'Team mention',
  subscribed: 'Subscribed',
};

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function stateLabel(n) {
  if (n.type === 'PullRequest') {
    if (n.merged) return 'merged';
    if (n.state === 'closed') return 'closed';
    if (n.draft) return 'draft';
    if (n.state === 'open') return 'open';
  }
  if (n.type === 'Issue') {
    if (n.state === 'closed') return 'closed';
    if (n.state === 'open') return 'open';
  }
  return null;
}

function NotificationRow({ n, onDismiss }) {
  const sl = stateLabel(n);
  const handleClick = (e) => {
    e.preventDefault();
    window.api.openExternal(n.url);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    window.api.showLinkMenu(n.url);
  };

  const compact = n.priority !== 'high';

  if (compact) {
    return (
      <div className="notification-row compact" data-priority={n.priority}>
        <a
          className="notif-title"
          href={n.url}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title={n.url}
        >
          {n.title}
        </a>
        <span className="notif-repo">{n.repo.replace('github/', '')}</span>
        {sl && <span className={`notif-state notif-state-${sl}`}>{sl}</span>}
        <span className="notif-time">{timeAgo(n.updated_at)}</span>
        <button className="dismiss-btn" onClick={() => onDismiss(n.id)} title="Mark as read">
          ✕
        </button>
      </div>
    );
  }

  return (
    <div className="notification-row" data-priority={n.priority}>
      <div className="notif-icon">{TYPE_ICONS[n.type] || '○'}</div>
      <div className="notif-body">
        <a
          className="notif-title"
          href={n.url}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title={n.url}
        >
          {n.title}
        </a>
        <div className="notif-meta">
          <span className="notif-repo">{n.repo}</span>
          {sl && <span className={`notif-state notif-state-${sl}`}>{sl}</span>}
          <span className="notif-time">{timeAgo(n.updated_at)}</span>
          {n.triageReason && <span className="notif-triage">— {n.triageReason}</span>}
        </div>
      </div>
      <button className="dismiss-btn" onClick={() => onDismiss(n.id)} title="Mark as read">
        ✕
      </button>
    </div>
  );
}

function Section({ priority, notifications, onDismiss, onDismissAll }) {
  if (notifications.length === 0) return null;
  return (
    <div className={`section section-${priority}`}>
      <div className="section-header">
        <div className="section-header-left">
          <h2 className="section-title">{PRIORITY_LABELS[priority]}</h2>
          <span className="section-count">{notifications.length}</span>
        </div>
        {priority !== 'high' && (
          <button className="section-clear-btn" onClick={() => onDismissAll(notifications)}>
            Clear section
          </button>
        )}
      </div>
      <div className="notification-list">
        {notifications.map((n) => (
          <NotificationRow key={n.id} n={n} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    // Only show full loading state on first load (when no data yet)
    const isFirstLoad = notifications.length === 0;
    if (isFirstLoad) setLoading(true);
    setError(null);
    try {
      const data = await window.api.fetchNotifications();
      if (data.error) {
        setError(data.error);
      } else {
        setNotifications(data);
      }
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }, [notifications.length]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [load]);

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    await window.api.markAllRead();
    setNotifications([]);
    setMarkingAll(false);
  };

  const handleDismiss = async (id) => {
    await window.api.markThreadRead(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const handleDismissSection = async (sectionNotifications) => {
    await Promise.all(sectionNotifications.map((n) => window.api.markThreadRead(n.id)));
    const ids = new Set(sectionNotifications.map((n) => n.id));
    setNotifications((prev) => prev.filter((n) => !ids.has(n.id)));
  };

  const high = notifications.filter((n) => n.priority === 'high');
  const medium = notifications.filter((n) => n.priority === 'medium');
  const noise = notifications.filter((n) => {
    if (n.priority !== 'noise') return false;
    const sl = stateLabel(n);
    return sl === 'merged' || sl === 'closed';
  });
  const other = notifications.filter((n) => {
    if (n.priority !== 'noise') return false;
    const sl = stateLabel(n);
    return sl !== 'merged' && sl !== 'closed';
  });
  const hasHigh = high.length > 0;

  return (
    <div className="app">
      <header className="header">
        <div className="header-spacer" />
        <div className="header-center">
          <h1>HubberHub</h1>
          <button className="refresh-btn" onClick={load} disabled={loading}>↻</button>
        </div>
        <button
          className="mark-all-btn"
          onClick={handleMarkAllRead}
          disabled={markingAll || notifications.length === 0}
        >
          {markingAll ? 'Clearing…' : 'Mark all as read'}
        </button>
      </header>

      <main className={`main${notifications.length > 0 ? ' has-content' : ''}`}>
        {loading && notifications.length === 0 && <div className="status">Loading notifications…</div>}
        {error && <div className="status error">Error: {error}</div>}
        {!loading && !error && notifications.length === 0 && (
          <div className="status empty">
            🎉 All clear — no notifications!
          </div>
        )}

        {notifications.length > 0 && (
          <>
            {!hasHigh && (
              <div className="defer-banner">
                Nothing needs your direct attention. Safe to clear all.
              </div>
            )}

            <Section priority="high" notifications={high} onDismiss={handleDismiss} onDismissAll={handleDismissSection} />
            <Section priority="medium" notifications={medium} onDismiss={handleDismiss} onDismissAll={handleDismissSection} />
            <Section priority="noise" notifications={noise} onDismiss={handleDismiss} onDismissAll={handleDismissSection} />
            <Section priority="other" notifications={other} onDismiss={handleDismiss} onDismissAll={handleDismissSection} />
          </>
        )}
      </main>
    </div>
  );
}
