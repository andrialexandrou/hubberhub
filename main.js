const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// --- Cache ---
const CACHE_DIR = path.join(app.getPath('userData'), 'cache');
const CONTEXT_CACHE_FILE = path.join(CACHE_DIR, 'subject-context.json');

let contextCache = {}; // keyed by subject URL → { updated_at, state, merged, latestComment }
const seenActionIds = new Set(); // track notified action items to avoid duplicates

function loadCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (fs.existsSync(CONTEXT_CACHE_FILE)) {
      contextCache = JSON.parse(fs.readFileSync(CONTEXT_CACHE_FILE, 'utf-8'));
    }
  } catch {
    contextCache = {};
  }
}

function saveCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CONTEXT_CACHE_FILE, JSON.stringify(contextCache));
  } catch {}
}

function getCachedContext(subjectUrl, updatedAt) {
  const entry = contextCache[subjectUrl];
  if (entry && entry.updated_at === updatedAt) return entry;
  return null;
}

function setCachedContext(subjectUrl, updatedAt, data) {
  contextCache[subjectUrl] = { updated_at: updatedAt, ...data };
}

// --- Triage cache (LLM results) ---
const TRIAGE_CACHE_FILE = path.join(CACHE_DIR, 'triage-results.json');
let triageCache = { hash: null, results: null };

function loadTriageCache() {
  try {
    if (fs.existsSync(TRIAGE_CACHE_FILE)) {
      triageCache = JSON.parse(fs.readFileSync(TRIAGE_CACHE_FILE, 'utf-8'));
    }
  } catch {
    triageCache = { hash: null, results: null };
  }
}

function saveTriageCache() {
  try {
    fs.writeFileSync(TRIAGE_CACHE_FILE, JSON.stringify(triageCache));
  } catch {}
}

function computeTriageHash(notifications) {
  // Simple hash: join all id+updated_at pairs
  return notifications.map(n => `${n.id}:${n.updated_at}`).join('|');
}

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
    if (!Array.isArray(data)) break;
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
  if (!url) return null;
  const match = url.match(/\/pulls\/(\d+)$/);
  return match ? match[1] : null;
}

async function fetchLatestComment(subjectUrl) {
  if (!subjectUrl) return null;
  try {
    // Get the latest comment on the thread
    const commentsUrl = subjectUrl.replace(/\/?$/, '/comments?per_page=1&direction=desc');
    const res = await ghFetch(commentsUrl);
    const comments = await res.json();
    if (Array.isArray(comments) && comments.length > 0) {
      return {
        author: comments[0].user?.login,
        body: (comments[0].body || '').slice(0, 300),
        created_at: comments[0].created_at,
      };
    }
  } catch {}
  return null;
}

async function fetchSubjectState(subjectUrl) {
  if (!subjectUrl) return null;
  try {
    const res = await ghFetch(subjectUrl);
    const data = await res.json();
    return {
      state: data.state,
      merged: data.merged,
      draft: data.draft,
      user: data.user?.login,
      title: data.title,
      body: (data.body || '').slice(0, 200),
      labels: (data.labels || []).map((l) => l.name),
      assignees: (data.assignees || []).map((a) => a.login),
      requested_reviewers: (data.requested_reviewers || []).map((r) => r.login),
      requested_teams: (data.requested_teams || []).map((t) => t.slug),
      comments: data.comments,
      created_at: data.created_at,
      closed_at: data.closed_at,
      merged_at: data.merged_at,
    };
  } catch {}
  return null;
}

// Deterministic rules engine — handles clear-cut cases without LLM
function classifyByRules(n, login) {
  const reviewers = n.subjectState?.requested_reviewers || [];
  const assignees = n.subjectState?.assignees || [];
  const teams = n.subjectState?.requested_teams || [];
  const prAuthor = n.subjectState?.user || '';
  const isCopilotPR = /^copilot/i.test(prAuthor) || prAuthor === 'copilot[bot]';
  const state = n.subjectState?.state;
  const merged = n.subjectState?.merged;

  // Team mention → noise
  if (n.reason === 'team_mention') return { cat: 'noise', why: 'Team mention only' };

  // Team-only review → noise
  if (n.reason === 'review_requested' && !reviewers.includes(login) && teams.length > 0)
    return { cat: 'noise', why: 'Team-only review request' };

  // Personal review request → action
  if (reviewers.includes(login))
    return { cat: 'action', why: 'Personally requested to review' };

  // Directly assigned → action
  if (n.reason === 'assign' || assignees.includes(login))
    return { cat: 'action', why: 'Directly assigned' };

  // Direct @mention → action
  if (n.reason === 'mention')
    return { cat: 'action', why: 'Directly mentioned' };

  // Copilot PR where user is reviewer/assignee → action
  if (isCopilotPR && (reviewers.includes(login) || assignees.includes(login)))
    return { cat: 'action', why: 'Your Copilot PR needs attention' };

  // Latest comment @mentions user → action
  if ((n.latestComment?.body || '').toLowerCase().includes(`@${login.toLowerCase()}`))
    return { cat: 'action', why: 'Mentioned in latest comment' };

  // Pure state change (closed/merged), no personal involvement → noise
  if ((state === 'closed' || merged) && n.reason === 'subscribed')
    return { cat: 'noise', why: 'State change on subscribed thread' };

  // User participated (commented/authored) — someone responded, needs attention
  if (n.reason === 'comment')
    return { cat: 'action', why: 'Reply on thread you commented on' };

  // User authored — ambiguous, needs LLM
  if (n.reason === 'author')
    return null; // → send to LLM

  // Subscribed with no personal signals → noise
  if (n.reason === 'subscribed')
    return { cat: 'noise', why: 'Subscribed, no personal involvement' };

  // Anything else unrecognized → ambiguous, send to LLM
  return null;
}

async function triageWithLLM(notifications, login) {
  const token = getToken();
  const BATCH_SIZE = 30;

  const allResults = [];
  const ambiguous = [];

  // First pass: deterministic rules
  for (let i = 0; i < notifications.length; i++) {
    const result = classifyByRules(notifications[i], login);
    if (result) {
      allResults.push({ idx: i, cat: result.cat, why: result.why });
    } else {
      ambiguous.push(i);
    }
  }

  const ruleAction = allResults.filter(r => r.cat === 'action').length;
  const ruleFyi = allResults.filter(r => r.cat === 'fyi').length;
  const ruleNoise = allResults.filter(r => r.cat === 'noise').length;
  console.log(`[Rules] Classified ${allResults.length}/${notifications.length}: ${ruleAction} action, ${ruleFyi} fyi, ${ruleNoise} noise`);
  console.log(`[LLM] ${ambiguous.length} ambiguous notifications need LLM`);

  if (ambiguous.length === 0) return allResults;

  // Build LLM items for ambiguous only
  const llmItems = ambiguous.map((i) => {
    const n = notifications[i];
    return {
      idx: i,
      title: n.title,
      repo: n.repo,
      type: n.type,
      reason: n.reason,
      state: n.subjectState?.state,
      merged: n.subjectState?.merged,
      prAuthor: n.subjectState?.user,
      labels: n.subjectState?.labels,
      lastCommentBy: n.latestComment?.author,
      lastCommentSnippet: n.latestComment?.body,
    };
  });

  const buildPrompt = (items) => `You are a notification triage assistant for GitHub user "${login}".

These notifications are ones where the user previously commented or authored the thread. New activity happened but it's unclear if the user needs to act.

Classify each as:
- "action": Someone is asking the user a question, requesting their input, or responding to something the user needs to follow up on.
- "fyi": Activity the user might want to know about but doesn't need to respond to (e.g. someone else answered, status updates, general discussion).
- "noise": Bot activity, CI updates, or irrelevant chatter.

Lean toward "fyi" unless there's a clear ask directed at the user. Look at lastCommentBy and lastCommentSnippet to judge if the user is being addressed.

Return ONLY a JSON array: [{"idx": N, "cat": "action|fyi|noise", "why": "brief reason"}]
No markdown wrapping.

Notifications:
${JSON.stringify(items)}`;

  // Process ambiguous in batches
  const batches = [];
  for (let i = 0; i < llmItems.length; i += BATCH_SIZE) {
    batches.push(llmItems.slice(i, i + BATCH_SIZE));
  }

  console.log(`[LLM] Processing ${llmItems.length} ambiguous in ${batches.length} batches...`);

  for (const batch of batches) {
    try {
      const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: buildPrompt(batch) }],
          temperature: 0,
        }),
      });

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '[]';
      const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      allResults.push(...parsed);
      console.log(`[LLM] Batch done: ${parsed.length} classified (${parsed.filter(r=>r.cat==='action').length} action, ${parsed.filter(r=>r.cat==='fyi').length} fyi, ${parsed.filter(r=>r.cat==='noise').length} noise)`);
    } catch (err) {
      console.error('[LLM] Batch failed:', err.message);
      batch.forEach(item => allResults.push({ idx: item.idx, cat: 'fyi', why: 'LLM batch failed' }));
    }
  }

  console.log(`[LLM] Total: ${allResults.filter(r=>r.cat==='action').length} action, ${allResults.filter(r=>r.cat==='fyi').length} fyi, ${allResults.filter(r=>r.cat==='noise').length} noise`);
  return allResults;
}

async function enrichNotifications(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) return [];
  const login = await getUserLogin();

  // First pass: build enriched data with context (cache-aware)
  const withContext = await Promise.all(
    notifications
      .filter((n) => n && n.repository && n.subject)
      .map(async (n) => {
      const prNumber = extractPRNumber(n.subject?.url);
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

      // Check cache first
      let latestComment, subjectState;
      const cached = getCachedContext(n.subject?.url, n.updated_at);
      if (cached) {
        latestComment = cached.latestComment;
        subjectState = cached.subjectState;
      } else {
        [latestComment, subjectState] = await Promise.all([
          fetchLatestComment(n.subject?.url),
          fetchSubjectState(n.subject?.url),
        ]);
        setCachedContext(n.subject?.url, n.updated_at, { latestComment, subjectState });
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
        latestComment,
        subjectState,
      };
    })
  );

  const cacheHits = withContext.filter((_, i) => {
    const n = notifications.filter(n => n && n.repository && n.subject)[i];
    return getCachedContext(n?.subject?.url, n?.updated_at);
  }).length;
  console.log(`[Cache] ${cacheHits}/${withContext.length} context hits`);

  // Second pass: LLM triage (skip if notification set unchanged)
  const hash = computeTriageHash(withContext);
  let triageResults;
  if (triageCache.hash === hash && triageCache.results) {
    console.log(`[LLM] Skipped — triage cache hit`);
    triageResults = triageCache.results;
  } else {
    triageResults = await triageWithLLM(withContext, login);
    triageCache = { hash, results: triageResults };
    saveTriageCache();
  }

  // Apply LLM classifications
  const PRIORITY_MAP = { action: 'high', fyi: 'medium', noise: 'noise' };
  const ORDER_MAP = { action: 1, fyi: 2, noise: 3 };

  const enriched = withContext.map((n, i) => {
    const classification = triageResults?.find((r) => r.idx === i);
    const cat = classification?.cat || 'fyi';
    return {
      ...n,
      priority: PRIORITY_MAP[cat] || 'medium',
      priorityOrder: ORDER_MAP[cat] || 2,
      triageReason: classification?.why || '',
      state: n.subjectState?.state || null,
      merged: n.subjectState?.merged || false,
      draft: n.subjectState?.draft || false,
      latestComment: undefined,
      subjectState: undefined,
    };
  });

  enriched.sort((a, b) => a.priorityOrder - b.priorityOrder);
  saveCache();

  // Desktop notifications for new action items
  const actionItems = enriched.filter((n) => n.priority === 'high' && n.unread);
  const newActions = actionItems.filter((n) => !seenActionIds.has(n.id));
  if (newActions.length > 0) {
    newActions.forEach((n) => seenActionIds.add(n.id));
    if (newActions.length === 1) {
      const n = newActions[0];
      const notif = new Notification({
        title: 'Action needed',
        body: `${n.title}\n${n.repo}`,
        silent: true,
      });
      notif.on('click', () => shell.openExternal(n.url));
      notif.show();
    } else {
      const notif = new Notification({
        title: `${newActions.length} items need your attention`,
        body: newActions.slice(0, 3).map((n) => n.title).join('\n'),
        silent: true,
      });
      notif.show();
    }
  }

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
    const result = await enrichNotifications(raw);
    const size = JSON.stringify(result).length;
    console.log(`[IPC] Sending ${Array.isArray(result) ? result.length : 0} notifications (${(size / 1024).toFixed(0)}KB) to renderer`);
    return result;
  } catch (err) {
    console.error('[IPC] fetch-notifications error:', err);
    return { error: err.message };
  }
});

ipcMain.handle('mark-all-read', async () => {
  try {
    const token = getToken();
    // Fetch current unread notification thread IDs
    const notifications = await fetchAllNotifications();
    // Mark each as done (DELETE)
    await Promise.all(
      notifications.map((n) =>
        fetch(`https://api.github.com/notifications/threads/${n.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })
      )
    );
    console.log(`[API] Marked ${notifications.length} threads as done`);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('mark-thread-read', async (_event, threadId) => {
  try {
    const token = getToken();
    await fetch(`https://api.github.com/notifications/threads/${threadId}`, {
      method: 'DELETE',
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
    title: 'HubberHub',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('crashed', (event, killed) => {
    console.error('[CRASH] WebContents crashed, killed:', killed);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[CRASH] Render process gone:', details);
  });

  win.on('unresponsive', () => {
    console.error('[CRASH] Window became unresponsive');
  });

  // win.webContents.openDevTools({ mode: 'detach' });

  // Prevent in-app navigation — all links open externally
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.setName('HubberHub');

process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[CRASH] Unhandled rejection:', err);
});

app.whenReady().then(() => {
  loadCache();
  loadTriageCache();

  app.setLoginItemSettings({
    openAtLogin: true,
    name: 'HubberHub',
  });

  createWindow();

  app.on('render-process-gone', (_event, _wc, details) => {
    console.error('[CRASH] Renderer process gone:', details);
  });
});

app.on('window-all-closed', () => app.quit());
