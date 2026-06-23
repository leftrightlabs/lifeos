// Messages zone — Slack + Notion-comments sources. Gmail is served by the
// existing /api/comms/* endpoints in server.js (list/get/reply/archive/trash/
// draft-reply), which this zone's UI reuses directly. Here we add the two
// sources that didn't exist yet.
//
// Slack uses a workspace Bot token (SLACK_BOT_TOKEN). Until that's set, the
// endpoint returns { connected:false } and the UI shows a "Connect Slack" state.
// Notion comments are team-only, pulled from recently-edited PROJECTS/TASKS pages.

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
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

async function slackApi(method, params = {}) {
  const url = `https://slack.com/api/${method}` + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : '');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  const d = await r.json();
  if (!d.ok) throw new Error(`Slack ${method}: ${d.error}`);
  return d;
}

export function registerMessagesRoutes(app, { notion, cached, WORK_PROJECTS_DS, WORK_TASKS_DS }) {
  // ── Slack ──
  app.get('/api/messages/slack', async (_req, res) => {
    if (!SLACK_TOKEN) return res.json({ connected: false, channels: [] });
    try {
      const data = await cached('messages-slack', async () => {
        const userCache = new Map();
        const userName = async (uid) => {
          if (!uid) return 'Unknown';
          if (userCache.has(uid)) return userCache.get(uid);
          try {
            const u = await slackApi('users.info', { user: uid });
            const name = u.user?.real_name || u.user?.profile?.display_name || u.user?.name || 'Unknown';
            userCache.set(uid, name);
            return name;
          } catch { return 'Unknown'; }
        };
        const conv = await slackApi('conversations.list', {
          types: 'public_channel,private_channel,im,mpim', exclude_archived: 'true', limit: '100',
        });
        const channels = [];
        for (const ch of (conv.channels || [])) {
          if (!ch.is_member && !ch.is_im) continue; // bot must be in the channel
          let hist;
          try { hist = await slackApi('conversations.history', { channel: ch.id, limit: '15' }); }
          catch { continue; }
          const msgs = [];
          for (const m of (hist.messages || [])) {
            if (m.subtype || !m.user) continue; // skip joins/bots/system
            const sender = await userName(m.user);
            msgs.push({
              id: `s_${m.ts}`,
              channelId: ch.id,
              channelName: ch.is_im ? `@${sender}` : `#${ch.name}`,
              sender,
              senderAvatar: initials(sender),
              senderColor: avatarColor(sender),
              text: m.text || '',
              ts: m.ts,
              time: relTime(Number(m.ts) * 1000),
              unread: !!(ch.unread_count || hist.messages.indexOf(m) < (ch.unread_count || 0)),
              isMention: SLACK_GRETCHEN ? (m.text || '').includes(`<@${SLACK_GRETCHEN}>`) : false,
            });
          }
          if (msgs.length) channels.push({ id: ch.id, name: ch.is_im ? `@${msgs[0].sender}` : `#${ch.name}`, messages: msgs });
        }
        return { connected: true, channels };
      });
      res.json(data);
    } catch (err) {
      console.error('messages/slack error:', err.message);
      res.status(500).json({ error: err.message, connected: true, channels: [] });
    }
  });

  app.post('/api/messages/slack/:channelId/read', async (req, res) => {
    if (!SLACK_TOKEN) return res.status(400).json({ error: 'Slack not connected' });
    try {
      await slackApi('conversations.mark', { channel: req.params.channelId, ts: req.body?.ts || '' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Notion comments (team members only) ──
  app.get('/api/messages/notion-comments', async (_req, res) => {
    if (!notion) return res.status(500).json({ error: 'Notion not configured' });
    try {
      const data = await cached('messages-notion-comments', async () => {
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const pages = [];
        for (const ds of [WORK_PROJECTS_DS, WORK_TASKS_DS].filter(Boolean)) {
          try {
            const r = await notion.dataSources.query({
              data_source_id: ds,
              filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } },
              sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
              page_size: 20,
            });
            for (const p of r.results) pages.push(p);
          } catch (e) { console.error('notion-comments page query failed:', e.message); }
        }
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
        const out = [];
        for (const p of pages) {
          let cs;
          try { cs = await notion.comments.list({ block_id: p.id }); }
          catch { continue; }
          for (const c of (cs.results || [])) {
            const uid = c.created_by?.id;
            if (NOTION_BOT_IDS.includes(uid)) continue;
            if (NOTION_TEAM_IDS.length && !NOTION_TEAM_IDS.includes(uid)) continue;
            const text = (c.rich_text || []).map((x) => x.plain_text).join('');
            if (!text.trim()) continue;
            const commenter = await userName(uid);
            out.push({
              id: c.id,
              pageId: p.id,
              pageTitle: titleOf(p),
              commenter,
              commenterInitials: initials(commenter),
              commenterColor: avatarColor(commenter),
              text,
              createdAt: c.created_time,
              time: relTime(Date.parse(c.created_time)),
              unread: true,
              notionUrl: p.url,
            });
          }
        }
        out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return { comments: out };
      });
      res.json(data);
    } catch (err) {
      console.error('messages/notion-comments error:', err.message);
      res.status(500).json({ error: err.message });
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
