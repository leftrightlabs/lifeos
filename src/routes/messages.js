// Messages zone — Slack + Notion-comments sources. Gmail is served by the
// existing /api/comms/* endpoints in server.js (list/get/reply/archive/trash/
// draft-reply), which this zone's UI reuses directly. Here we add the two
// sources that didn't exist yet.
//
// Slack uses a workspace Bot token (SLACK_BOT_TOKEN). Until that's set, the
// endpoint returns { connected:false } and the UI shows a "Connect Slack" state.
// Notion comments are team-only, pulled from recently-edited PROJECTS/TASKS pages.

const SLACK_GRETCHEN = process.env.SLACK_GRETCHEN_USER_ID || '';
const NOTION_TEAM_IDS = (process.env.NOTION_TEAM_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const NOTION_BOT_IDS = (process.env.NOTION_BOT_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const AV_COLORS = ['#6366F1', '#2563EB', '#06B6D4', '#059669', '#D97706', '#DC2626', '#7C3AED', '#DB2777'];
function avatarColor(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return AV_COLORS[Math.abs(h) % AV_COLORS.length];
}
function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

async function slackApi(token, method, params = {}) {
  const url = `https://slack.com/api/${method}` + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : '');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (!d.ok) throw new Error(`Slack ${method}: ${d.error}`);
  return d;
}

export function registerMessagesRoutes(app, { notion, cached, clearCached, getSlackUserToken, ownNotionUserId, WORK_PROJECTS_DS, WORK_TASKS_DS }) {
  // ── Slack (user token → reads YOUR real unread DMs + channels) ──
  // Strategy: list the conversations the user is in, ask Slack for each one's
  // unread count + last-read marker, then pull only the messages after last_read.
  // Capped + cached to stay within Slack rate limits.
  app.get('/api/messages/slack', async (req, res) => {
    const token = getSlackUserToken && getSlackUserToken();
    if (!token) return res.json({ connected: false, channels: [] });
    const debug = req.query.debug === '1';
    const diag = { tokenType: token.slice(0, 4), conversations: 0, byType: {}, perChannel: [], errors: [] };
    try {
      if ((req.query.fresh === '1' || debug) && clearCached) clearCached('messages-slack');
      const run = async () => {
        // Confirm the token works + identify it (a bot token can't see personal unreads).
        const auth = await slackApi(token, 'auth.test').catch((e) => { diag.errors.push('auth.test: ' + e.message); return null; });
        diag.authedAs = auth?.user; diag.team = auth?.team; diag.isBotToken = token.startsWith('xoxb');
        const myId = auth?.user_id;
        // Slack echoes the token's actual granted scopes in this response header —
        // the definitive way to see whether the read scopes were granted.
        try {
          const rr = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${token}` } });
          diag.grantedScopes = rr.headers.get('x-oauth-scopes');
        } catch (e) { diag.grantedScopes = 'header read failed: ' + e.message; }

        const userCache = new Map();
        const userName = async (uid) => {
          if (!uid) return 'Unknown';
          if (userCache.has(uid)) return userCache.get(uid);
          try {
            const u = await slackApi(token, 'users.info', { user: uid });
            const name = u.user?.real_name || u.user?.profile?.display_name || u.user?.name || 'Unknown';
            userCache.set(uid, name); return name;
          } catch { return 'Unknown'; }
        };

        const conv = await slackApi(token, 'users.conversations', {
          types: 'public_channel,private_channel,im,mpim', exclude_archived: 'true', limit: '200',
        });
        const list = conv.channels || [];
        diag.conversations = list.length;
        for (const ch of list) { const t = ch.is_im ? 'im' : ch.is_mpim ? 'mpim' : ch.is_private ? 'private' : 'public'; diag.byType[t] = (diag.byType[t] || 0) + 1; }

        const channels = [];
        let checked = 0;
        for (const ch of list) {
          if (checked >= 50) break; // bound API calls
          checked++;
          let info;
          try { info = await slackApi(token, 'conversations.info', { channel: ch.id }); }
          catch (e) { diag.errors.push(`info ${ch.id}: ${e.message}`); continue; }
          const c = info.channel || {};
          const lastRead = c.last_read || '0';
          // Derive unread straight from history vs last_read — more reliable than
          // unread_count_display, which is often absent/zero for user tokens.
          let hist;
          try { hist = await slackApi(token, 'conversations.history', { channel: ch.id, oldest: lastRead, limit: '15' }); }
          catch (e) { diag.errors.push(`history ${ch.id}: ${e.message}`); continue; }
          const dmName = ch.is_im ? await userName(c.user || ch.user) : null;
          const channelName = ch.is_im ? `@${dmName}` : `#${c.name || ch.name}`;
          const msgs = [];
          for (const m of (hist.messages || [])) {
            if (m.subtype || !m.user || m.ts === lastRead) continue; // skip system + the already-read marker
            if (m.user === myId) continue;                            // skip my own messages
            const sender = ch.is_im ? dmName : await userName(m.user);
            msgs.push({
              id: `s_${ch.id}_${m.ts}`, channelId: ch.id, channelName,
              sender, senderAvatar: initials(sender), senderColor: avatarColor(sender),
              text: m.text || '', ts: m.ts, time: relTime(Number(m.ts) * 1000),
              unread: true,
              isMention: SLACK_GRETCHEN ? (m.text || '').includes(`<@${SLACK_GRETCHEN}>`) : false,
            });
          }
          diag.perChannel.push({ name: channelName, lastRead, unreadFound: msgs.length, unreadCountDisplay: c.unread_count_display ?? null });
          if (msgs.length) channels.push({ id: ch.id, name: channelName, latestTs: msgs[msgs.length - 1].ts, messages: msgs.reverse() });
        }
        channels.sort((a, b) => Number(b.latestTs) - Number(a.latestTs));
        return { connected: true, channels };
      };
      // Debug bypasses the cache wrapper so diag is always fresh.
      const data = debug ? await run() : await cached('messages-slack', run);
      if (debug) return res.json({ ...data, diag });
      res.json(data);
    } catch (err) {
      console.error('messages/slack error:', err.message);
      res.status(500).json({ error: err.message, connected: true, channels: [], diag });
    }
  });

  app.post('/api/messages/slack/:channelId/read', async (req, res) => {
    const token = getSlackUserToken && getSlackUserToken();
    if (!token) return res.status(400).json({ error: 'Slack not connected' });
    try {
      await slackApi(token, 'conversations.mark', { channel: req.params.channelId, ts: req.body?.ts || '' });
      if (clearCached) clearCached('messages-slack');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Notion comments (team members only) ──
  // Notion has no "list all comments" endpoint, so we scan recent pages in
  // PROJECTS + TASKS and read each one's comments. We do NOT filter by
  // last_edited_time — adding a comment doesn't bump a page's edit time, so a
  // time filter silently drops fresh comments on older pages. Instead we take the
  // most-recently-edited PAGES_SCAN pages and read comments for all of them.
  const PAGES_SCAN = 80;
  app.get('/api/messages/notion-comments', async (req, res) => {
    if (!notion) return res.status(500).json({ error: 'Notion not configured' });
    const debug = req.query.debug === '1';
    const diag = { pagesFetched: 0, pagesScanned: 0, pagesWithComments: 0, totalRawComments: 0, kept: 0, errors: [] };
    try {
      if ((req.query.fresh === '1' || debug) && clearCached) clearCached('messages-notion-comments');
      const run = async () => {
        // 1) Collect candidate pages (metadata only — cheap), newest first.
        let pages = [];
        for (const ds of [WORK_PROJECTS_DS, WORK_TASKS_DS].filter(Boolean)) {
          try {
            const r = await notion.dataSources.query({
              data_source_id: ds,
              sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
              page_size: 100,
            });
            pages.push(...r.results);
          } catch (e) { diag.errors.push(`page query: ${e.message}`); }
        }
        diag.pagesFetched = pages.length;
        pages.sort((a, b) => Date.parse(b.last_edited_time || 0) - Date.parse(a.last_edited_time || 0));
        pages = pages.slice(0, PAGES_SCAN);
        diag.pagesScanned = pages.length;

        const userCache = new Map();
        const userName = async (uid) => {
          if (userCache.has(uid)) return userCache.get(uid);
          try { const u = await notion.users.retrieve({ user_id: uid }); userCache.set(uid, u.name || 'Teammate'); return u.name || 'Teammate'; }
          catch { return 'Teammate'; }
        };
        const titleOf = (p) => {
          const props = p.properties || {};
          const t = Object.values(props).find((v) => v?.type === 'title');
          return t?.title?.map((x) => x.plain_text).join('') || 'Untitled';
        };

        // 2) Fetch comments per page, in small concurrent batches (faster, still
        //    within Notion's rate limits with the client's built-in retry).
        const out = [];
        for (let i = 0; i < pages.length; i += 6) {
          const batch = pages.slice(i, i + 6);
          const results = await Promise.all(batch.map(async (p) => {
            try { const cs = await notion.comments.list({ block_id: p.id }); return { p, comments: cs.results || [] }; }
            catch (e) { diag.errors.push(`comments ${p.id}: ${e.message}`); return { p, comments: [] }; }
          }));
          for (const { p, comments } of results) {
            if (comments.length) diag.pagesWithComments++;
            diag.totalRawComments += comments.length;
            for (const c of comments) {
              const uid = c.created_by?.id;
              if (uid === ownNotionUserId) continue;            // hide my own comments
              if (NOTION_BOT_IDS.includes(uid)) continue;
              if (NOTION_TEAM_IDS.length && !NOTION_TEAM_IDS.includes(uid)) continue;
              const text = (c.rich_text || []).map((x) => x.plain_text).join('');
              if (!text.trim()) continue;
              const commenter = await userName(uid);
              out.push({
                id: c.id, pageId: p.id, pageTitle: titleOf(p),
                commenter, commenterInitials: initials(commenter), commenterColor: avatarColor(commenter),
                text, createdAt: c.created_time, time: relTime(Date.parse(c.created_time)),
                unread: true, notionUrl: p.url,
              });
            }
          }
        }
        diag.kept = out.length;
        out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return { comments: out };
      };
      const data = debug ? await run() : await cached('messages-notion-comments', run);
      if (debug) return res.json({ ...data, diag });
      res.json(data);
    } catch (err) {
      console.error('messages/notion-comments error:', err.message);
      res.status(500).json({ error: err.message, diag });
    }
  });
}

function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
