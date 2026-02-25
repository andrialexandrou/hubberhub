const { app, BrowserWindow, ipcMain, shell, Menu, clipboard } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

let ghToken = null;

function getToken() {
  if (ghToken) return ghToken;
  try {
    ghToken = execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  }
  return ghToken;
}

async function ghFetch(url) {
  const token = getToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  return res;
}

async function fetchAllNotifications() {
  let all = [];
  let url = 'https://api.github.com/notifications?per_page=50';
  while (url) {
    const res = await ghFetch(url);
    const data = await res.json();
    all = all.concat(data);
    const link = res.headers.get('link');
    const next = link?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return all;
}

async function fetchPRReviewers(owner, repo, prNumber) {
  const res = await ghFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  const pr = await res.json();
  return {
    requested_reviewers: (pr.requested_reviewers || []).map((r) => r.login),
    requested_teams: (pr.requested_teams || []).map((t) => t.slug),
  };
}

async function getUserLogin() {
  const res = await ghFetch('https://api.github.com/user');
  const user = await res.json();
  return user.login;
}

function extractPRNumber(url) {
  const match = url?.match(/\/pulls\/(\d+)$/);
  return match ? match[1] : null;
}

async function enrichNotifications(notifications) {
  const login = await getUserLogin();

  const enriched = await Promise.all(
    notifications.map(async (n) => {
      let priority = 'low';
      let priorityOrder = 3;

      if (n.reason === 'assign' || n.reason === 'mention') {
        priority = 'high';
        priorityOrder = 1;
      } else if (n.reason === 'review_requested') {
        // Check if personally requested
        const prNumber = extractPRNumber(n.subject.url);
        if (prNumber) {
          try {
            const reviewers = await fetchPRReviewers(
              n.repository.owner.login,
              n.repository.name,
              prNumber
            );
            if (reviewers.requested_reviewers.includes(login)) {
              priority = 'high';
              priorityOrder = 1;
            } else {
              priority = 'low';
              priorityOrder = 3;
            }
          } catch {
            priority = 'medium';
            priorityOrder = 2;
          }
        }
      } else if (
        n.reason === 'author' ||
        n.reason === 'comment' ||
        n.reason === 'subscribed'
      ) {
        priority = 'medium';
        priorityOrder = 2;
      } else if (n.reason === 'team_mention') {
        priority = 'low';
        priorityOrder = 3;
      }

      const prNumber = extractPRNumber(n.subject.url);
      let htmlUrl = `https://github.com/${n.repository.full_name}`;
      if (n.subject.type === 'PullRequest' && prNumber) {
        htmlUrl = `https://github.com/${n.repository.full_name}/pull/${prNumber}`;
      } else if (n.subject.type === 'Issue') {
        const issueNum = n.subject.url?.match(/\/issues\/(\d+)$/)?.[1];
        if (issueNum)
          htmlUrl = `https://github.com/${n.repository.full_name}/issues/${issueNum}`;
      } else if (n.subject.type === 'Discussion') {
        const discNum = n.subject.url?.match(/\/discussions\/(\d+)$/)?.[1];
        if (discNum)
          htmlUrl = `https://github.com/${n.repository.full_name}/discussions/${discNum}`;
      }

      return {
        id: n.id,
        title: n.subject.title,
        type: n.subject.type,
        reason: n.reason,
        repo: n.repository.full_name,
        url: htmlUrl,
        updated_at: n.updated_at,
        unread: n.unread,
        priority,
        priorityOrder,
      };
    })
  );

  enriched.sort((a, b) => a.priorityOrder - b.priorityOrder);
  return enriched;
}

// IPC Handlers
ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('show-link-menu', (_event, url) => {
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open in Browser',
      click: () => shell.openExternal(url),
    },
    {
      label: 'Copy URL',
      click: () => clipboard.writeText(url),
    },
  ]);
  menu.popup();
});

ipcMain.handle('fetch-notifications', async () => {
  try {
    const raw = await fetchAllNotifications();
    return await enrichNotifications(raw);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mark-all-read', async () => {
  try {
    await ghFetch('https://api.github.com/notifications', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: 'application/vnd.github+json',
      },
    });
    // The ghFetch helper only does GET — do a direct fetch for PUT
    const token = getToken();
    await fetch('https://api.github.com/notifications', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ last_read_at: new Date().toISOString() }),
    });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mark-thread-read', async (_event, threadId) => {
  try {
    const token = getToken();
    await fetch(`https://api.github.com/notifications/threads/${threadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
