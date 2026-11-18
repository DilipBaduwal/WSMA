const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const store = path.join(root, 'visitors.json');
const cacheFile = path.join(root, 'content-cache.json');
const communityFile = path.join(root, 'community-votes.json');
const tmdbApiKey = env('TMDB_API_KEY');
const tmdbAccessToken = env('TMDB_ACCESS_TOKEN');
const tavilyKey = env('TAVILY_API_KEY');
const qwenModel = env('QWEN_MODEL') || 'qwen2.5:3b';
const refreshInterval = 24 * 60 * 60 * 1000;
const publicFiles = new Set([
  'index.html', 'latest.html', 'trending.html', 'collections.html',
  'reviews.html', 'styles.css', 'script.js', 'logo.jpeg'
]);

function env(name) {
  const file = fs.existsSync(path.join(root, '.env'))
    ? fs.readFileSync(path.join(root, '.env'), 'utf8')
    : '';
  const row = file.split(/\r?\n/).find(line => line.trim().startsWith(`${name}=`));
  return row ? row.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '') : process.env[name] || '';
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let db = readJson(store, { totalVisits: 0, ips: [] });
let contentCache = readJson(cacheFile, null);
let community = readJson(communityFile, {});
let refreshInProgress;
const verifiedSearchTitles = new Map();
const searchTitleLifetime = 24 * 60 * 60 * 1000;

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function saveAnalytics() {
  try { fs.writeFileSync(store, JSON.stringify(db, null, 2)); } catch (_) { /* Vercel filesystem is read-only. */ }
}

function communityKey(mediaType, id) {
  return `${mediaType}:${id}`;
}

function isKnownTitle(mediaType, id) {
  const searchKey = communityKey(mediaType, id);
  const verifiedUntil = verifiedSearchTitles.get(searchKey);
  if (verifiedUntil && verifiedUntil > Date.now()) return true;
  const lists = [
    contentCache?.latest || [],
    contentCache?.trending || [],
    ...(contentCache?.collections || []).map(collection => collection.items || [])
  ];
  return lists.some(items => items.some(item => item.id === id && item.mediaType === mediaType));
}

function voteSummary(entry, voterKey) {
  const votes = entry?.votes || {};
  const watching = Object.values(votes).filter(vote => vote === 'watch').length;
  const skip = Object.values(votes).filter(vote => vote === 'skip').length;
  return {
    watch: watching,
    skip,
    total: watching + skip,
    viewerVote: votes[voterKey] || null
  };
}

function voterKey(req, res) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map(value => value.trim())
    .find(value => value.startsWith('wos_visitor='));
  let token = cookie?.slice('wos_visitor='.length);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    const secure = req.socket.encrypted ? '; Secure' : '';
    res.setHeader('Set-Cookie', `wos_visitor=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readRequestBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        rejected = true;
        reject(new Error('Request body too large'));
        return;
      }
      if (!rejected) body += chunk;
    });
    req.on('end', () => {
      if (!rejected) resolve(body);
    });
    req.on('error', reject);
  });
}

async function tmdb(endpoint, params = {}) {
  if (!tmdbAccessToken && !tmdbApiKey) {
    throw new Error('TMDB_API_KEY or TMDB_ACCESS_TOKEN must be configured');
  }
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  if (!tmdbAccessToken) url.searchParams.set('api_key', tmdbApiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: tmdbAccessToken ? { Authorization: `Bearer ${tmdbAccessToken}` } : {}
      });
      if (response.ok) return response.json();
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`TMDB request failed (${response.status})`);
      }
      lastError = new Error(`TMDB request failed (${response.status})`);
      await response.body?.cancel();
    } catch (error) {
      lastError = error;
      if (/TMDB request failed \((?!429|5\d\d)/.test(error.message)) throw error;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw lastError || new Error('TMDB request failed after retries');
}

async function tmdbList(endpoint, params) {
  const data = await tmdb(endpoint, params);
  return Array.isArray(data.results) ? data.results : [];
}

async function tavily(title) {
  if (!tavilyKey) return { research: '', sources: [] };
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey,
      query: `${title} Indian film series release review streaming`,
      search_depth: 'basic',
      topic: 'general',
      max_results: 3,
      include_answer: false,
      include_raw_content: false,
      include_domains: [
        'sacnilk.com', 'indianexpress.com', 'thehindu.com',
        'timesofindia.indiatimes.com'
      ]
    })
  });
  if (!response.ok) throw new Error(`Tavily request failed (${response.status})`);
  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const sources = results.map(item => item.url).filter(url => {
    if (typeof url !== 'string') return false;
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  });
  return {
    research: results.map(item => (item.content || '').slice(0, 900)).filter(Boolean).join('\n'),
    sources: sources.slice(0, 3)
  };
}

async function qwen(prompt) {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: qwenModel,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.35 }
    })
  });
  if (!response.ok) throw new Error(`Qwen request failed (${response.status})`);
  const data = await response.json();
  const result = JSON.parse(data.response);
  if (!Array.isArray(result.items)) throw new Error('Qwen returned an invalid editorial response');
  return result.items;
}

function imageUrl(filePath, size) {
  return filePath ? `https://image.tmdb.org/t/p/${size}${filePath}` : null;
}

async function detailFor(item) {
  const type = item.media_type || item.mediaType || 'movie';
  const [detail, providerResult] = await Promise.all([
    tmdb(`/${type}/${item.id}`, { append_to_response: 'credits' }),
    tmdb(`/${type}/${item.id}/watch/providers`).catch(error => {
      console.error(`TMDB watch-provider lookup failed for ${type} ${item.id}: ${error.message}`);
      return null;
    })
  ]);
  const india = providerResult?.results?.IN;
  const providers = [
    ...(india?.flatrate || []),
    ...(india?.free || []),
    ...(india?.ads || [])
  ];
  const cast = (detail.credits?.cast || []).slice(0, 4).map(person => person.name);
  const crew = detail.credits?.crew || [];
  const director = crew.find(person => person.job === 'Director')?.name;
  const genres = (detail.genres || []).map(genre => genre.name);
  const title = detail.title || detail.name || item.title || item.name;
  return {
    id: detail.id,
    mediaType: type,
    title,
    genreIds: (detail.genres || []).map(genre => genre.id),
    posterUrl: imageUrl(detail.poster_path || item.poster_path, 'w500'),
    backdropUrl: imageUrl(detail.backdrop_path || item.backdrop_path, 'w1280'),
    genres,
    language: (detail.original_language || item.original_language || '').toUpperCase(),
    releaseDate: detail.release_date || detail.first_air_date || item.release_date || item.first_air_date || null,
    cast,
    director: director || null,
    rating: Number.isFinite(detail.vote_average) ? detail.vote_average : null,
    ratingVotes: Number.isFinite(detail.vote_count) ? detail.vote_count : 0,
    ratingSource: 'TMDB',
    streamingPlatforms: [...new Set(providers.map(provider => provider.provider_name))],
    overview: detail.overview || '',
    runtime: detail.runtime || detail.episode_run_time?.[0] || null,
    label: type === 'tv' ? 'SERIES' : 'MOVIE'
  };
}

async function searchMovies(query) {
  const results = await tmdbList('/search/movie', {
    query,
    include_adult: 'false',
    region: 'IN',
    language: 'hi-IN',
    page: '1'
  });
  const normalizeTitle = title => String(title || '').trim().toLocaleLowerCase();
  const queryTitle = normalizeTitle(query);
  const exactMatch = item => [item.title, item.original_title]
    .some(title => normalizeTitle(title) === queryTitle);
  const indianLanguages = new Set(['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu']);
  const movies = [...results]
    .sort((a, b) => Number(exactMatch(b)) - Number(exactMatch(a))
      || Number(indianLanguages.has(b.original_language)) - Number(indianLanguages.has(a.original_language)))
    .slice(0, 6)
    .map(item => ({ ...item, media_type: 'movie' }));
  const items = await mapLimit(movies, 2, async item => {
    try {
      const detail = await detailFor(item);
      return {
        ...detail,
        description: '',
        bestFor: '',
        mayNotSuit: '',
        researchSources: []
      };
    } catch (error) {
      console.error(`TMDB search detail failed for "${item.title}": ${error.message}`);
      return {
        id: item.id,
        mediaType: 'movie',
        title: item.title || item.original_title,
        genreIds: item.genre_ids || [],
        posterUrl: imageUrl(item.poster_path, 'w500'),
        backdropUrl: imageUrl(item.backdrop_path, 'w1280'),
        genres: [],
        language: (item.original_language || '').toUpperCase(),
        releaseDate: item.release_date || null,
        cast: [],
        director: null,
        rating: Number.isFinite(item.vote_average) ? item.vote_average : null,
        ratingVotes: Number.isFinite(item.vote_count) ? item.vote_count : 0,
        ratingSource: 'TMDB',
        streamingPlatforms: [],
        overview: item.overview || '',
        runtime: null,
        label: 'MOVIE',
        description: '',
        bestFor: '',
        mayNotSuit: '',
        researchSources: []
      };
    }
  });
  const now = Date.now();
  for (const item of items) {
    const key = communityKey(item.mediaType, item.id);
    verifiedSearchTitles.delete(key);
    verifiedSearchTitles.set(key, now + searchTitleLifetime);
  }
  while (verifiedSearchTitles.size > 1000) {
    verifiedSearchTitles.delete(verifiedSearchTitles.keys().next().value);
  }
  for (const [key, expiresAt] of verifiedSearchTitles) {
    if (expiresAt <= now) verifiedSearchTitles.delete(key);
  }
  return items;
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await callback(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function discoverPages(params, pageCount = 3) {
  const pages = await Promise.all(Array.from({ length: pageCount }, (_, index) =>
    tmdbList('/discover/movie', { ...params, page: String(index + 1) })
  ));
  return pages.flat().map(item => ({ ...item, media_type: 'movie' }));
}

function takeDistinct(items, usedIds, limit = 6) {
  const selected = [];
  for (const item of items) {
    if (usedIds.has(item.id)) continue;
    usedIds.add(item.id);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function freshContent() {
  const today = new Date().toISOString().slice(0, 10);
  const recentReleaseStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hindiFilters = {
    region: 'IN',
    with_original_language: 'hi',
    include_adult: 'false',
    language: 'en-US',
    page: '1'
  };
  const [recentMovies, popularMovies, acclaimedMovies, actionMovies, dramaMovies, comedyMovies] = await Promise.all([
    discoverPages({
      ...hindiFilters,
      'primary_release_date.gte': recentReleaseStart,
      'primary_release_date.lte': today,
      'vote_count.gte': '20',
      sort_by: 'primary_release_date.desc'
    }),
    discoverPages({
      ...hindiFilters,
      'vote_count.gte': '100',
      sort_by: 'popularity.desc'
    }),
    discoverPages({
      ...hindiFilters,
      'vote_count.gte': '300',
      sort_by: 'vote_average.desc'
    }),
    discoverPages({
      ...hindiFilters,
      with_genres: '28,53,80',
      'vote_count.gte': '15',
      sort_by: 'popularity.desc'
    }, 2),
    discoverPages({
      ...hindiFilters,
      with_genres: '18,10749',
      'vote_count.gte': '15',
      sort_by: 'popularity.desc'
    }, 2),
    discoverPages({
      ...hindiFilters,
      with_genres: '35,10751',
      'vote_count.gte': '15',
      sort_by: 'popularity.desc'
    }, 2)
  ]);
  const usedIds = new Set();
  const latestItems = takeDistinct(recentMovies, usedIds);
  const trendingItems = takeDistinct(popularMovies, usedIds);
  const acclaimedItems = takeDistinct(acclaimedMovies, usedIds);
  const collectionItems = {
    'new-hindi': latestItems,
    'popular-hindi': trendingItems,
    'top-rated-hindi': acclaimedItems,
    'action-thriller': takeDistinct(actionMovies, usedIds),
    'drama-romance': takeDistinct(dramaMovies, usedIds),
    'comedy-family': takeDistinct(comedyMovies, usedIds)
  };
  const allItems = Object.values(collectionItems).flat();
  const itemByKey = new Map();
  for (const item of allItems) {
    itemByKey.set(`${item.media_type}:${item.id}`, item);
  }

  const details = (await mapLimit([...itemByKey.values()], 2, async item => {
    try {
      return await detailFor(item);
    } catch (error) {
      console.error(`TMDB detail lookup failed for "${item.title || item.name}": ${error.message}`);
      return null;
    }
  })).filter(Boolean);
  if (!details.length) throw new Error('TMDB did not return any Hindi movie details. Check the API key and try again.');
  const detailByKey = new Map(details.map(item => [`${item.mediaType}:${item.id}`, item]));
  const contentItems = details.map(item => ({ ...item, research: '', researchSources: [] }));

  const recentKeys = new Set(latestItems.map(item => `${item.mediaType}:${item.id}`));
  const researchItems = contentItems.filter(item => recentKeys.has(`${item.mediaType}:${item.id}`));
  if (tavilyKey) {
    await mapLimit(researchItems, 3, async item => {
      try {
        const research = await tavily(item.title);
        item.research = research.research;
        item.researchSources = research.sources;
      } catch (error) {
        console.error(`Tavily research failed for "${item.title}": ${error.message}`);
      }
    });
  } else {
    console.warn('TAVILY_API_KEY is not configured; editorial research was skipped');
  }

  const editorial = new Array(contentItems.length);
  const editorialBatches = [];
  for (let index = 0; index < contentItems.length; index += 3) {
    editorialBatches.push({ start: index, items: contentItems.slice(index, index + 3) });
  }
  await mapLimit(editorialBatches, 2, async batch => {
    try {
      const copies = await qwen(
        'Write original, concise, spoiler-free guidance for Hindi movie viewers. ' +
        'Do not claim to have watched these films, invent facts, or copy research wording. ' +
        'Use genre and research context to say who may enjoy each title and one reasonable caveat. ' +
        'Return JSON as {"items":[{"description":"...","bestFor":"...","mayNotSuit":"..."}]}. ' +
        `Return exactly ${batch.items.length} items in order. Titles: ` +
        JSON.stringify(batch.items.map(item => ({
          title: item.title,
          genres: item.genres,
          synopsis: item.overview.slice(0, 350),
          research: item.research.slice(0, 550)
        })))
      );
      batch.items.forEach((item, index) => {
        editorial[batch.start + index] = copies[index] || {};
      });
    } catch (error) {
      console.error(`Editorial copy generation failed for "${batch.items.map(item => item.title).join(', ')}": ${error.message}`);
    }
  });

  const editorialByKey = new Map();
  contentItems.forEach((item, index) => {
    const copy = editorial[index] || {};
    editorialByKey.set(`${item.mediaType}:${item.id}`, {
      description: typeof copy.description === 'string' ? copy.description.trim() : '',
      bestFor: typeof copy.bestFor === 'string' ? copy.bestFor.trim() : '',
      mayNotSuit: typeof copy.mayNotSuit === 'string' ? copy.mayNotSuit.trim() : ''
    });
  });
  const render = items => items.map(item => {
    const key = `${item.media_type}:${item.id}`;
    const detail = detailByKey.get(key);
    if (!detail) return null;
    const research = contentItems.find(candidate => `${candidate.mediaType}:${candidate.id}` === key);
    const copy = editorialByKey.get(key) || {};
    return {
      ...detail,
      description: copy.description || '',
      bestFor: copy.bestFor || '',
      mayNotSuit: copy.mayNotSuit || '',
      researchSources: research?.researchSources || []
    };
  }).filter(Boolean);

  const result = {
    cacheVersion: 4,
    updatedAt: new Date().toISOString(),
    source: 'Metadata and artwork: TMDB · Research: Tavily · Editorial copy: Qwen local',
    latest: render(latestItems),
    trending: render(trendingItems),
    collections: [
      {
        id: 'new-hindi',
        title: 'Recent Hindi releases',
        description: 'Hindi films released in the past year, ordered by TMDB popularity.',
        items: render(collectionItems['new-hindi'])
      },
      {
        id: 'popular-hindi',
        title: 'Popular Hindi films',
        description: 'Hindi-language films attracting audience interest on TMDB.',
        items: render(collectionItems['popular-hindi'])
      },
      {
        id: 'top-rated-hindi',
        title: 'Highly rated Hindi films',
        description: 'Hindi films with a substantial number of TMDB ratings, ordered by average rating.',
        items: render(collectionItems['top-rated-hindi'])
      },
      {
        id: 'action-thriller',
        title: 'Action & thriller',
        description: 'Hindi action, crime, and thriller films, distinct from the other lists.',
        items: render(collectionItems['action-thriller'])
      },
      {
        id: 'drama-romance',
        title: 'Drama & romance',
        description: 'Hindi dramas and romances, selected as a separate movie category.',
        items: render(collectionItems['drama-romance'])
      },
      {
        id: 'comedy-family',
        title: 'Comedy & family',
        description: 'Hindi comedies and family films for a lighter watch.',
        items: render(collectionItems['comedy-family'])
      }
    ]
  };
  try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2)); } catch (_) { /* Cache is ephemeral on Vercel. */ }
  return result;
}

async function getContent() {
  const cacheIsFresh = contentCache?.cacheVersion === 4
    && Date.now() - new Date(contentCache.updatedAt).getTime() < refreshInterval;
  const cacheIsCompatible = contentCache?.cacheVersion === 4;
  if (cacheIsFresh) return contentCache;
  if (!tmdbApiKey && !tmdbAccessToken) {
    if (cacheIsCompatible) return contentCache;
    throw new Error('TMDB API credentials are missing. Add TMDB_API_KEY to .env to load current Hindi movie posters and titles.');
  }
  if (!refreshInProgress) {
    refreshInProgress = freshContent()
      .then(result => {
        contentCache = result;
        return result;
      })
      .finally(() => {
        refreshInProgress = null;
      });
  }
  try {
    return await refreshInProgress;
  } catch (error) {
    console.error(`Content refresh failed: ${error.message}`);
    if (cacheIsCompatible) return { ...contentCache, refreshWarning: 'Showing cached content; refresh failed.' };
    throw error;
  }
}

async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname === '/api/image') {
      const target = requestUrl.searchParams.get('url');
      if (!target || !/^https:\/\/(image\.tmdb\.org|images\.unsplash\.com)\//.test(target)) {
        return send(res, 400, 'text/plain', 'Unsupported image source');
      }
      const imageResponse = await fetch(target);
      if (!imageResponse.ok) return send(res, imageResponse.status, 'text/plain', 'Image unavailable');
      res.writeHead(200, {
        'Content-Type': imageResponse.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(Buffer.from(await imageResponse.arrayBuffer()));
    }
    if (requestUrl.pathname === '/api/community' && req.method === 'GET') {
      const voter = voterKey(req, res);
      const entries = requestUrl.searchParams.get('items')?.split(',').slice(0, 24) || [];
      const result = {};
      for (const entry of entries) {
        const match = /^(movie|tv):(\d{1,10})$/.exec(entry);
        if (match) {
          result[entry] = voteSummary(community[entry], voter);
        }
      }
      return send(res, 200, 'application/json', JSON.stringify(result));
    }
    if (requestUrl.pathname === '/api/community' && req.method === 'POST') {
      if (!req.headers['content-type']?.includes('application/json')) {
        return send(res, 415, 'application/json', JSON.stringify({ error: 'Expected application/json' }));
      }
      let vote;
      try {
        vote = JSON.parse(await readRequestBody(req));
      } catch (error) {
        const status = error.message === 'Request body too large' ? 413 : 400;
        return send(res, status, 'application/json', JSON.stringify({ error: 'Invalid vote request' }));
      }
      if (!vote || !['movie', 'tv'].includes(vote.mediaType)
        || !Number.isSafeInteger(vote.id) || vote.id < 1
        || !['watch', 'skip'].includes(vote.verdict)) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid vote fields' }));
      }
      if (!isKnownTitle(vote.mediaType, vote.id)) {
        return send(res, 404, 'application/json', JSON.stringify({ error: 'Title not found' }));
      }
      const key = communityKey(vote.mediaType, vote.id);
      community[key] ||= { votes: {} };
      const voter = voterKey(req, res);
      community[key].votes[voter] = vote.verdict;
      try { fs.writeFileSync(communityFile, JSON.stringify(community, null, 2)); } catch (_) { /* Use a database for durable votes in production. */ }
      return send(res, 200, 'application/json', JSON.stringify({
        [key]: voteSummary(community[key], voter)
      }));
    }
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');
    if (requestUrl.pathname === '/api/analytics') {
      const visitor = crypto.createHash('sha256')
        .update((req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim())
        .digest('hex');
      db.totalVisits++;
      if (!db.ips.includes(visitor)) db.ips.push(visitor);
      saveAnalytics();
      return send(res, 200, 'application/json', JSON.stringify({
        totalVisits: db.totalVisits,
        uniqueVisitors: db.ips.length
      }));
    }
    if (requestUrl.pathname === '/api/content') {
      const data = await getContent();
      return send(res, 200, 'application/json', JSON.stringify(data));
    }
    if (requestUrl.pathname === '/api/search' && req.method === 'GET') {
      const query = (requestUrl.searchParams.get('query') || '').trim();
      if (query.length < 2 || query.length > 100) {
        return send(res, 400, 'application/json', JSON.stringify({
          error: 'Search needs between 2 and 100 characters.'
        }));
      }
      const items = await searchMovies(query);
      return send(res, 200, 'application/json', JSON.stringify({ items }));
    }

    const file = requestUrl.pathname === '/' ? 'index.html' : decodeURIComponent(requestUrl.pathname.slice(1));
    if (!publicFiles.has(file)) return send(res, 404, 'text/plain', 'Not found');
    const type = file.endsWith('.css') ? 'text/css'
      : file.endsWith('.js') ? 'text/javascript'
      : file.endsWith('.jpeg') ? 'image/jpeg'
      : 'text/html';
    return send(res, 200, type, fs.readFileSync(path.join(root, file)));
  } catch (error) {
    console.error(error.message);
    return send(res, 503, 'application/json', JSON.stringify({ error: error.message || 'Content refresh unavailable' }));
  }
}

if (require.main === module) {
  http.createServer(handler).listen(process.env.PORT || 3000, () => {
    console.log(`Running on http://localhost:${process.env.PORT || 3000}`);
  });
}

module.exports = handler;
