const analyticsFallback = { totalVisits: 0, uniqueVisitors: 0 };
let catalogue = [];
let searchCatalogue = [];
let currentFilter = 'new-hindi';
let currentItem = null;
let collectionMembership = new Map();
let dialog;
let searchTimer;
let activeSearch;
let lastSearchQuery = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function formatReleaseDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function itemKey(item) {
  return `${item.mediaType || 'movie'}:${item.id}`;
}

function imageUrl(url) {
  return url ? `/api/image?url=${encodeURIComponent(url)}` : '';
}

function placeholder() {
  return '<div class="poster-placeholder" role="img" aria-label="Poster unavailable"></div>';
}

function poster(item, className = '') {
  return item.posterUrl
    ? `<img class="${className}" src="${imageUrl(item.posterUrl)}" alt="${escapeHtml(item.title)} poster" loading="lazy" data-title-image>`
    : placeholder();
}

function releaseAndGenres(item) {
  const language = { HI: 'Hindi', EN: 'English', TA: 'Tamil', TE: 'Telugu', ML: 'Malayalam', KN: 'Kannada' }[(item.language || '').toUpperCase()] || item.language;
  const parts = [item.genres?.slice(0, 2).join(' · '), language, formatReleaseDate(item.releaseDate)].filter(Boolean);
  return parts.length ? parts.map(escapeHtml).join(' <span>·</span> ') : 'Indian screen pick';
}

function plainMetadata(item) {
  return [item.label, item.genres?.slice(0, 2).join(' · '), item.language, formatReleaseDate(item.releaseDate)]
    .filter(Boolean)
    .join(' · ');
}

function tmdbRating(item) {
  return Number.isFinite(item.rating)
    ? `<span class="tmdb-score">★ ${item.rating.toFixed(1)}</span><span class="rating-source">TMDB · ${Number(item.ratingVotes || 0).toLocaleString()} ratings</span>`
    : '<span class="rating-source">TMDB rating unavailable</span>';
}

function audienceFit(item) {
  const genres = item.genres || [];
  const moods = [];
  if (genres.some(genre => /action|adventure|science fiction|fantasy/i.test(genre))) moods.push('big-screen scale and high-stakes stories');
  if (genres.some(genre => /comedy|family|animation/i.test(genre))) moods.push('a lighter watch or a shared movie night');
  if (genres.some(genre => /romance|drama/i.test(genre))) moods.push('character-led stories and emotional drama');
  if (genres.some(genre => /thriller|crime|mystery|horror/i.test(genre))) moods.push('suspense, mysteries, and darker stories');
  return item.bestFor || (moods.length
    ? `A good fit if you enjoy ${moods.slice(0, 2).join(' or ')}.`
    : 'Explore the synopsis and genres to see if it fits your mood.');
}

function audienceCaveat(item) {
  if (item.mayNotSuit) return item.mayNotSuit;
  const genres = item.genres || [];
  if (genres.some(genre => /horror|thriller|crime/i.test(genre))) return 'May not be your pick if you want a light, low-tension watch.';
  if (genres.some(genre => /drama|romance/i.test(genre))) return 'May not be your pick if you want a fast-paced, action-led story.';
  if (genres.some(genre => /action|adventure|science fiction/i.test(genre))) return 'May not be your pick if you prefer a quiet, character-first story.';
  return 'Check the synopsis and genre mix if you are in a particular mood.';
}

function card(item) {
  const key = escapeHtml(itemKey(item));
  return `<article class="media-card">
    <button class="card-poster" type="button" data-open-title="${key}" aria-label="See details for ${escapeHtml(item.title)}">
      ${poster(item)}
      <span class="type">${escapeHtml(item.label || 'MOVIE')}</span>
      <span class="poster-cta">See the details ↗</span>
    </button>
    <div class="media-info">
      <div class="meta">${releaseAndGenres(item)}</div>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="card-rating">${tmdbRating(item)}</div>
      <p class="card-description"><span class="synopsis-label">${item.description ? 'EDITORIAL NOTE' : 'TMDB SYNOPSIS'}</span>${escapeHtml(item.description || item.overview || audienceFit(item))}</p>
      <button class="card-open" type="button" data-open-title="${key}">Should you watch? <span>↗</span></button>
    </div>
  </article>`;
}

function trendCard(item, index) {
  const key = escapeHtml(itemKey(item));
  return `<button class="trend-card" type="button" data-open-title="${key}">
    <span class="rank">${String(index + 1).padStart(2, '0')}</span>
    <span class="trend-thumb">${poster(item)}</span>
    <span class="trend-copy"><b>${escapeHtml(item.title)}</b>
      <small>${releaseAndGenres(item)}<br>${tmdbRating(item)}</small>
    </span>
    <span class="trend-arrow">↗</span>
  </button>`;
}

function renderSpotlight(items) {
  const element = document.querySelector('#spotlight');
  if (!element || !items.length) return;
  const item = items.find(candidate => candidate.backdropUrl || candidate.posterUrl) || items[0];
  const key = escapeHtml(itemKey(item));
  const image = item.backdropUrl || item.posterUrl;
  element.innerHTML = `<article class="spotlight-card">
    ${image ? `<img class="spotlight-art" src="${imageUrl(image)}" alt="${escapeHtml(item.title)} artwork" data-title-image>` : ''}
    <div class="spotlight-shade"></div>
    <div class="spotlight-label"><span class="live-dot"></span> TONIGHT'S SHORTLIST</div>
    <div class="spotlight-content">
      <span class="spotlight-kicker">${escapeHtml(item.label || 'MOVIE')} · ${releaseAndGenres(item)}</span>
      <h2>${escapeHtml(item.title)}</h2>
      <div class="spotlight-rating">${tmdbRating(item)}</div>
      <p>${escapeHtml(item.description || item.overview || audienceFit(item))}</p>
      <button class="primary" type="button" data-open-title="${key}">Should I watch it? <span>↗</span></button>
    </div>
  </article>
  <div class="spotlight-caption"><span>Posters and ratings from TMDB</span><span>Details & audience fit <b>↗</b></span></div>`;
}

function renderCollectionTiles(collections) {
  const element = document.querySelector('#featuredCollections');
  if (!element) return;
  element.innerHTML = (collections || []).map(collection => {
    const item = collection.items?.find(title => title.backdropUrl || title.posterUrl);
    const artwork = item?.backdropUrl || item?.posterUrl;
    return `<a class="collection" href="/collections.html#${escapeHtml(collection.id)}">
      ${artwork ? `<img class="collection-art" src="${imageUrl(artwork)}" alt="" loading="lazy" data-title-image>` : placeholder()}
      <span class="collection-shade"></span>
      <span class="collection-label">HINDI FILMS / ${String(collection.items?.length || 0).padStart(2, '0')} TITLES</span>
      <span class="collection-copy"><b>${escapeHtml(collection.title)}</b><small>${escapeHtml(collection.description)}</small></span>
    </a>`;
  }).join('') || '<p class="loading-note">Hindi film collections are not available yet.</p>';
}

function renderCollectionPage(collections) {
  const element = document.querySelector('#collectionsGrid');
  if (!element) return;
  element.innerHTML = (collections || []).map(collection => `
    <section class="collection-list" id="${escapeHtml(collection.id)}">
      <div class="section-head">
        <div><div class="eyebrow">HINDI FILM COLLECTION</div><h2>${escapeHtml(collection.title)}</h2>
        <p class="collection-description">${escapeHtml(collection.description)}</p></div>
      </div>
      <div class="media-grid">${(collection.items || []).map(card).join('')}</div>
    </section>
  `).join('') || '<p class="loading-note">Hindi film collections are not available yet.</p>';
}

function visibleItems() {
  return catalogue.filter(item => {
    const key = itemKey(item);
    const matchesFilter = currentFilter === 'all'
      || collectionMembership.get(currentFilter)?.has(key);
    return matchesFilter;
  });
}

function renderCatalogue() {
  const element = document.querySelector('#latestGrid');
  if (!element) return;
  const items = visibleItems();
  element.innerHTML = items.length
    ? items.map(card).join('')
    : '';
  const empty = document.querySelector('#emptyState');
  if (empty) empty.hidden = items.length > 0;
}

function initDialog() {
  dialog = document.querySelector('#movieDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'movieDialog';
    dialog.className = 'movie-dialog';
    dialog.innerHTML = '<button class="dialog-close" type="button" aria-label="Close details">×</button><div id="movieDialogContent"></div>';
    document.body.append(dialog);
  }
  dialog.querySelector('.dialog-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-title]');
    if (!button) return;
    const item = catalogue.find(candidate => itemKey(candidate) === button.dataset.openTitle);
    if (item) {
      document.querySelector('#searchResults')?.setAttribute('hidden', '');
      openTitle(item);
    }
  });
}

function showSearchMessage(message, className = '') {
  const results = document.querySelector('#searchResults');
  if (!results) return;
  results.innerHTML = `<p class="search-message ${className}" role="status">${escapeHtml(message)}</p>`;
  results.hidden = false;
}

function renderSearchResults(items) {
  const results = document.querySelector('#searchResults');
  if (!results) return;
  if (!items.length) {
    showSearchMessage("Sorry, we couldn't find that movie. We're fixing our catalogue — try another title.");
    return;
  }
  searchCatalogue = items;
  const knownItems = new Map(catalogue.map(item => [itemKey(item), item]));
  for (const item of items) knownItems.set(itemKey(item), item);
  catalogue = [...knownItems.values()];
  results.innerHTML = `<p class="search-message" role="status">TMDB results · ${items.length} ${items.length === 1 ? 'movie' : 'movies'}</p>
    ${items.map(item => `<button class="search-result" type="button" data-open-title="${escapeHtml(itemKey(item))}">
      <span class="search-result-poster">${item.posterUrl
        ? `<img src="${imageUrl(item.posterUrl)}" alt="" loading="lazy" data-title-image>`
        : '<span aria-hidden="true">🎬</span>'}</span>
      <span class="search-result-copy"><b>${escapeHtml(item.title)}</b>
        <small>${escapeHtml([item.releaseDate?.slice(0, 4), item.language, item.genres?.slice(0, 2).join(' · ')].filter(Boolean).join(' · ') || 'Movie details from TMDB')}</small>
        <span>${tmdbRating(item)}</span>
      </span>
      <span class="search-result-arrow" aria-hidden="true">↗</span>
    </button>`).join('')}`;
  results.hidden = false;
}

async function searchMovies(rawQuery, force = false) {
  const query = rawQuery.trim();
  const results = document.querySelector('#searchResults');
  if (!results) return;
  if (query.length < 2) {
    activeSearch?.abort();
    lastSearchQuery = '';
    if (query) showSearchMessage('Enter at least 2 characters to search TMDB.');
    else results.hidden = true;
    return;
  }
  if (!force && query === lastSearchQuery && !activeSearch) return;
  activeSearch?.abort();
  activeSearch = new AbortController();
  const controller = activeSearch;
  lastSearchQuery = query;
  showSearchMessage('Searching TMDB…');
  try {
    const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Search failed (${response.status})`);
    if (activeSearch !== controller) return;
    renderSearchResults(Array.isArray(data.items) ? data.items : []);
    activeSearch = null;
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (activeSearch !== controller) return;
    console.error(error);
    showSearchMessage('Sorry, movie search is temporarily unavailable. Please try again shortly.', 'search-error');
    activeSearch = null;
  }
}

function dialogMarkup(item, community = null) {
  const heroImage = item.backdropUrl || item.posterUrl;
  const cast = item.cast?.length
    ? `<p><b>Featuring</b> ${item.cast.map(escapeHtml).join(' · ')}</p>`
    : '';
  const director = item.director ? `<p><b>Director</b> ${escapeHtml(item.director)}</p>` : '';
  const runtime = item.runtime ? `<p><b>Runtime</b> ${escapeHtml(item.runtime)} min</p>` : '';
  const platforms = item.streamingPlatforms?.length
    ? `<p><b>Watch in India</b> ${item.streamingPlatforms.map(escapeHtml).join(' · ')}</p>`
    : '<p><b>Where to watch</b> Streaming availability is not listed by TMDB for India.</p>';
  const votes = community || { watch: 0, skip: 0, total: 0, viewerVote: null };
  const percentage = votes.total ? Math.round((votes.watch / votes.total) * 100) : 0;
  const communityResult = votes.total
    ? `<div class="verdict-meter"><span style="width:${percentage}%"></span></div><p class="verdict-count"><b>${percentage}%</b> would watch · ${votes.total.toLocaleString()} community ${votes.total === 1 ? 'vote' : 'votes'}</p>`
    : '<p class="verdict-count">Be the first to weigh in. Community votes are separate from TMDB ratings.</p>';
  const viewerVote = votes.viewerVote
    ? '<p class="vote-confirmation">Your vote is included. You can change it anytime.</p>'
    : '';
  const overview = item.overview
    ? `<p class="detail-overview">${escapeHtml(item.overview)}</p>`
    : `<p class="detail-overview">${escapeHtml(item.description || 'Synopsis is not available yet. Check back as this title is updated.')}</p>`;
  const backdrop = heroImage
    ? `<div class="detail-backdrop" style="background-image:linear-gradient(0deg,#18191b 0%,rgba(24,25,27,.15) 100%),url('${imageUrl(heroImage)}')"></div>`
    : '<div class="detail-backdrop detail-backdrop-empty"></div>';
  return `<article class="detail-sheet">
    ${backdrop}
    <div class="detail-body">
      <div class="eyebrow">${escapeHtml(plainMetadata(item) || 'TITLE')}</div>
      <h2 id="dialogTitle">${escapeHtml(item.title)}</h2>
      <div class="detail-ratings">${tmdbRating(item)}</div>
      ${overview}
      <div class="audience-grid">
        <section><span class="eyebrow">A GOOD FIT IF</span><p>${escapeHtml(audienceFit(item))}</p></section>
        <section><span class="eyebrow">MAY NOT BE FOR YOU IF</span><p>${escapeHtml(audienceCaveat(item))}</p></section>
      </div>
      <div class="detail-facts">${director}${cast}${runtime}${platforms}</div>
      <section class="community-vote">
        <div><span class="eyebrow">THE COMMUNITY VERDICT</span><h3>Would you watch it?</h3></div>
        <div class="vote-actions">
          <button type="button" class="vote-button ${votes.viewerVote === 'watch' ? 'selected' : ''}" data-vote="watch" ${votes.viewerVote === 'watch' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>I'd watch <span>↗</span></button>
          <button type="button" class="vote-button ${votes.viewerVote === 'skip' ? 'selected' : ''}" data-vote="skip" ${votes.viewerVote === 'skip' ? 'aria-pressed="true"' : 'aria-pressed="false"'}>Not for me <span>×</span></button>
        </div>
        <div class="community-result" aria-live="polite">${communityResult}${viewerVote}</div>
        <small>One quick vote per browser profile. Votes are anonymous and are not professional reviews.</small>
      </section>
      <div class="detail-attribution">Film metadata and artwork are provided by TMDB. ${item.researchSources?.length ? `Editorial research: ${item.researchSources.map((source, i) => `<a href="${imageUrl(source)}" target="_blank" rel="noopener noreferrer">Source ${i + 1}</a>`).join(' · ')}.` : ''}</div>
    </div>
  </article>`;
}

async function openTitle(item) {
  currentItem = item;
  const content = dialog.querySelector('#movieDialogContent');
  content.innerHTML = dialogMarkup(item);
  dialog.showModal();
  try {
    const response = await fetch(`/api/community?items=${encodeURIComponent(itemKey(item))}`);
    if (!response.ok) throw new Error(`Community data request failed (${response.status})`);
    const summaries = await response.json();
    if (dialog.open && currentItem === item) {
      content.innerHTML = dialogMarkup(item, summaries[itemKey(item)]);
      attachVoteActions(item);
    }
  } catch (error) {
    console.error(error);
    const result = content.querySelector('.community-result');
    if (result) result.innerHTML = '<p class="vote-confirmation">Community votes are temporarily unavailable.</p>';
    attachVoteActions(item);
  }
  if (!content.querySelector('[data-vote]')) attachVoteActions(item);
}

function attachVoteActions(item) {
  const content = dialog.querySelector('#movieDialogContent');
  content.querySelectorAll('[data-vote]').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/community', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mediaType: item.mediaType,
            id: item.id,
            verdict: button.dataset.vote
          })
        });
        if (!response.ok) throw new Error(`Vote could not be saved (${response.status})`);
        const data = await response.json();
        content.innerHTML = dialogMarkup(item, data[itemKey(item)]);
        attachVoteActions(item);
      } catch (error) {
        console.error(error);
        const result = content.querySelector('.community-result');
        if (result) result.innerHTML = '<p class="vote-confirmation">Your vote could not be saved. Please try again.</p>';
        button.disabled = false;
      }
    });
  });
}

async function loadAnalytics() {
  const total = document.querySelector('#totalVisits');
  const unique = document.querySelector('#uniqueVisitors');
  if (!total || !unique) return;
  try {
    const response = await fetch('/api/analytics');
    if (!response.ok) throw new Error(`Analytics request failed (${response.status})`);
    const data = await response.json();
    total.textContent = Number(data.totalVisits).toLocaleString();
    unique.textContent = Number(data.uniqueVisitors).toLocaleString();
  } catch (error) {
    console.error(error);
    total.textContent = analyticsFallback.totalVisits.toLocaleString();
    unique.textContent = analyticsFallback.uniqueVisitors.toLocaleString();
  }
}

async function loadContent() {
  try {
    const response = await fetch('/api/content');
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Content request failed (${response.status})`);
    }
    const data = await response.json();
    const latest = Array.isArray(data.latest) ? data.latest : [];
    const trending = Array.isArray(data.trending) ? data.trending : [];
    const collections = Array.isArray(data.collections) ? data.collections : [];
    const allTitles = [...latest, ...trending, ...collections.flatMap(collection => collection.items || [])];
    catalogue = [...new Map([...allTitles, ...searchCatalogue].map(item => [itemKey(item), item])).values()];
    collectionMembership = new Map(collections.map(collection => [
      collection.id,
      new Set((collection.items || []).map(itemKey))
    ]));
    collectionMembership.set('all', new Set(catalogue.map(itemKey)));
    renderCatalogue();
    renderSpotlight(latest);
    renderCollectionTiles(collections);
    renderCollectionPage(collections);
    const trendElement = document.querySelector('#trendGrid');
    if (trendElement) trendElement.innerHTML = trending.length
      ? trending.slice(0, 5).map(trendCard).join('')
      : '<p class="loading-note">No trending titles are available right now.</p>';
  } catch (error) {
    console.error(error);
    for (const selector of ['#latestGrid', '#trendGrid']) {
      const element = document.querySelector(selector);
      if (element) {
        element.innerHTML = '<p class="loading-note"></p>';
        element.querySelector('.loading-note').textContent = error.message || 'Fresh catalogue data is temporarily unavailable.';
      }
    }
    const spotlight = document.querySelector('#spotlight');
    if (spotlight) {
      spotlight.innerHTML = '<div class="spotlight-offline"></div>';
      spotlight.querySelector('.spotlight-offline').textContent = error.message || 'Fresh picks are temporarily unavailable. Please try again shortly.';
    }
    for (const selector of ['#featuredCollections', '#collectionsGrid']) {
      const element = document.querySelector(selector);
      if (element) {
        element.innerHTML = '<p class="loading-note"></p>';
        element.querySelector('.loading-note').textContent = error.message || 'Hindi film collections are temporarily unavailable.';
      }
    }
  }
}

initDialog();
document.addEventListener('error', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.hasAttribute('data-title-image')) {
    image.replaceWith(Object.assign(document.createElement('div'), {
      className: 'poster-placeholder',
      role: 'img',
      ariaLabel: 'Artwork unavailable'
    }));
  }
}, true);
loadAnalytics();
loadContent();

document.querySelector('#catalogFilters')?.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  currentFilter = button.dataset.filter;
  document.querySelectorAll('#catalogFilters [data-filter]').forEach(filter => {
    filter.classList.toggle('active', filter === button);
    filter.setAttribute('aria-pressed', String(filter === button));
  });
  renderCatalogue();
});

const movieSearch = document.querySelector('#movieSearch');
movieSearch?.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchMovies(movieSearch.value), 350);
});
document.querySelector('#movieSearchForm')?.addEventListener('submit', event => {
  event.preventDefault();
  clearTimeout(searchTimer);
  searchMovies(movieSearch?.value || '', true);
});
document.addEventListener('click', event => {
  if (!event.target.closest('.search-wrap')) {
    document.querySelector('#searchResults')?.setAttribute('hidden', '');
  }
});
