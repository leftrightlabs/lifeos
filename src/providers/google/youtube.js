// YouTube provider — Stage 1: public channel + video stats via the YouTube Data
// API v3 (API key, no OAuth). Tells you what content resonates (views/likes/
// comments) + current subscriber count. Stage 2 (separate) will add the YouTube
// Analytics API over OAuth for watch time / traffic sources / subscribers gained.
import { google } from 'googleapis';

// Read env LAZILY (at request time): in the server, dotenv loads after this module
// is imported, so reading at module-load would see empty values.
const apiKey = () => process.env.YOUTUBE_API_KEY || '';
// Accepts a channel ID (UC...) or a handle (@leftrightlabs / leftrightlabs).
const channelRef = () => process.env.YOUTUBE_CHANNEL || process.env.YOUTUBE_CHANNEL_ID || '';

export function ytConfigured() { return !!apiKey() && !!channelRef(); }

const yt = () => google.youtube({ version: 'v3', auth: apiKey() });
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

async function resolveChannelId() {
  const ref = channelRef();
  if (/^UC[\w-]{20,}$/.test(ref)) return ref; // already a channel ID
  const handle = ref.replace(/^@/, '');
  const r = await yt().channels.list({ part: ['id'], forHandle: handle });
  return r.data.items?.[0]?.id || null;
}

// Stage-1 "what's working" for the channel: headline stats + top recent videos.
export async function ytWhatsWorking() {
  const channelId = await resolveChannelId();
  if (!channelId) throw new Error(`channel not found for "${channelRef()}"`);

  const chRes = await yt().channels.list({ part: ['statistics', 'snippet', 'contentDetails'], id: [channelId] });
  const ch = chRes.data.items?.[0];
  if (!ch) throw new Error('channel lookup returned nothing');
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;

  // Most recent ~20 uploads, then fetch their stats.
  let videos = [];
  if (uploads) {
    const pl = await yt().playlistItems.list({ part: ['contentDetails'], playlistId: uploads, maxResults: 20 });
    const ids = (pl.data.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vr = await yt().videos.list({ part: ['statistics', 'snippet'], id: ids });
      videos = (vr.data.items || []).map((v) => ({
        id: v.id,
        title: v.snippet?.title || '(untitled)',
        publishedAt: v.snippet?.publishedAt || null,
        views: n(v.statistics?.viewCount),
        likes: n(v.statistics?.likeCount),
        comments: n(v.statistics?.commentCount),
      }));
    }
  }
  const byViews = [...videos].sort((a, b) => b.views - a.views);
  const recentAvgViews = videos.length ? Math.round(videos.reduce((s, v) => s + v.views, 0) / videos.length) : 0;

  return {
    label: 'YouTube',
    channelTitle: ch.snippet?.title || null,
    subscribers: n(ch.statistics?.subscriberCount),
    totalViews: n(ch.statistics?.viewCount),
    videoCount: n(ch.statistics?.videoCount),
    recentAvgViews,
    topVideos: byViews.slice(0, 5),
    recentVideos: videos.slice(0, 5),
  };
}
