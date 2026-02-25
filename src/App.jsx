import { useState, useEffect, useCallback } from 'react';

const PRIORITY_LABELS = {
  high: '🔴 Needs Your Attention',
  medium: '🟡 Following',
  low: '⚪ Team / Low Priority',
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

function NotificationRow({ n, onDismiss }) {
  const handleClick = (e) => {
    e.preventDefault();
    window.api.openExternal(n.url);
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    window.api.showLinkMenu(n.url);
  };

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
          <span className="notif-reason">{REASON_LABELS[n.reason] || n.reason}</span>
          <span className="notif-time">{timeAgo(n.updated_at)}</span>
        </div>
      </div>
      <button className="dismiss-btn" onClick={() => onDismiss(n.id)} title="Mark as read">
        ✕
      </button>
    </div>
  );
}

function Section({ priority, notifications, onDismiss }) {
  if (notifications.length === 0) return null;
  return (
    <div className={`section section-${priority}`}>
      <h2 className="section-title">{PRIORITY_LABELS[priority]}</h2>
      <div className="section-count">{notifications.length}</div>
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
    setLoading(true);
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
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const high = notifications.filter((n) => n.priority === 'high');
  const medium = notifications.filter((n) => n.priority === 'medium');
  const low = notifications.filter((n) => n.priority === 'low');
  const hasHigh = high.length > 0;

  return (
    <div className="app">
      <header className="header">
        <div className="header-spacer" />
        <h1>HubberHub</h1>
        <button
          className="mark-all-btn"
          onClick={handleMarkAllRead}
          disabled={markingAll || notifications.length === 0}
        >
          {markingAll ? 'Clearing…' : 'Mark All as Read'}
        </button>
      </header>

      <div className="toolbar">
        <span className="total-badge">{notifications.length} notification{notifications.length !== 1 ? 's' : ''}</span>
        <button className="refresh-btn" onClick={load} disabled={loading}>
          ↻ Refresh
        </button>
      </div>

      <main className={`main${notifications.length > 0 && !loading ? ' has-content' : ''}`}>
        {loading && <div className="status">Loading notifications…</div>}
        {error && <div className="status error">Error: {error}</div>}
        {!loading && !error && notifications.length === 0 && (
          <div className="status empty">
            🎉 All clear — no notifications!
          </div>
        )}

        {!loading && notifications.length > 0 && (
          <>
            <Section priority="high" notifications={high} onDismiss={handleDismiss} />
            <Section priority="medium" notifications={medium} onDismiss={handleDismiss} />

            {!hasHigh && (medium.length > 0 || low.length > 0) && (
              <div className="defer-banner">
                Nothing needs your direct attention. Safe to clear all.
              </div>
            )}

            <Section priority="low" notifications={low} onDismiss={handleDismiss} />
          </>
        )}
      </main>
    </div>
  );
}
