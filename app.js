/* ============================================
   ALLUNIME - Application Logic
   Fetches data from OtakuDesu REST API
   
   STRATEGI ANTI-BLOCK:
   ─────────────────────
   1. localStorage cache dengan TTL per endpoint
   2. Stale-while-revalidate (tampilkan cache lama, update di background)
   3. Request deduplication (no duplicate in-flight)
   4. Search debounce 800ms + minimum 3 karakter
   5. Rate limiter: max 1 request per 2 detik
   6. Home/ongoing: cache 30 menit
   7. Detail anime: cache 6 jam
   8. Schedule/genres: cache 24 jam
   9. Search results: cache 10 menit
   ============================================ */

// ============================
// Configuration
// ============================
const CONFIG = {
  // ══════════════════════════════════════════════
  // HARDCODED API URLs — ganti dengan URL API kamu
  // Bisa deploy sendiri dari:
  //   https://github.com/Kaede-No-Ki/otakudesu-rest-api
  //   https://github.com/rakarmp/unofficial-otakudesu-api
  //   https://github.com/eksa-arifa/otakudesuapi
  // ══════════════════════════════════════════════
  API_URLS: [
    window.location.origin + '/api',
    'https://otakudesuapieksa.vercel.app',
    'https://otakudesuapi-allueto.vercel.app',
    'https://unofficial-otakudesu-api-me.vercel.app/api',
    'https://unofficial-otakudesu-api-ruang-kreatif.vercel.app/api',
    'https://otakudesu-api.vercel.app/api/v1',
    'https://otakudesu-unofficial-api.vercel.app/api/v1',
    'https://wajik-anime-api.vercel.app/otakudesu',
  ],

  // CORS proxy fallback
  CORS_PROXIES: [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?url=',
  ],

  SEARCH_DEBOUNCE: 800,     // 800ms debounce pencarian
  SEARCH_MIN_CHARS: 3,      // Minimal 3 karakter untuk search
  RATE_LIMIT_MS: 2000,      // Jeda minimum 2 detik antar request

  // Cache TTL (dalam milidetik)
  CACHE_TTL: {
    home:     30 * 60 * 1000,   // 30 menit
    ongoing:  30 * 60 * 1000,   // 30 menit
    complete: 30 * 60 * 1000,   // 30 menit
    detail:   6 * 60 * 60 * 1000, // 6 jam
    episode:  6 * 60 * 60 * 1000, // 6 jam
    schedule: 24 * 60 * 60 * 1000, // 24 jam
    genres:   24 * 60 * 60 * 1000, // 24 jam
    genre_anime: 60 * 60 * 1000,   // 1 jam
    search:   10 * 60 * 1000,   // 10 menit
  },
};

// ============================
// Cache Manager
// ============================
const CacheManager = {
  _prefix: 'allunime_cache_',

  /**
   * Simpan data ke cache dengan TTL
   */
  set(key, data, ttlMs) {
    try {
      const entry = {
        data,
        timestamp: Date.now(),
        ttl: ttlMs,
      };
      localStorage.setItem(this._prefix + key, JSON.stringify(entry));
    } catch (e) {
      // localStorage penuh — bersihkan cache lama
      this.cleanup();
      try {
        const entry = { data, timestamp: Date.now(), ttl: ttlMs };
        localStorage.setItem(this._prefix + key, JSON.stringify(entry));
      } catch (_) { /* abaikan */ }
    }
  },

  /**
   * Ambil data dari cache. Return null jika expired atau tidak ada.
   */
  get(key) {
    try {
      const raw = localStorage.getItem(this._prefix + key);
      if (!raw) return null;

      const entry = JSON.parse(raw);
      const age = Date.now() - entry.timestamp;

      if (age > entry.ttl) {
        // Expired tapi masih simpan untuk stale-while-revalidate
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  },

  /**
   * Ambil data stale (expired) untuk ditampilkan selama revalidate
   */
  getStale(key) {
    try {
      const raw = localStorage.getItem(this._prefix + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      return entry.data;
    } catch {
      return null;
    }
  },

  /**
   * Cek apakah cache masih fresh
   */
  isFresh(key) {
    return this.get(key) !== null;
  },

  /**
   * Hapus cache tertentu
   */
  remove(key) {
    localStorage.removeItem(this._prefix + key);
  },

  /**
   * Bersihkan semua cache expired
   */
  cleanup() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this._prefix)) {
        try {
          const entry = JSON.parse(localStorage.getItem(key));
          const age = Date.now() - entry.timestamp;
          // Hapus jika sudah 3x TTL (sangat basi)
          if (age > entry.ttl * 3) {
            keysToRemove.push(key);
          }
        } catch {
          keysToRemove.push(key);
        }
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  },
};

// ============================
// Rate Limiter
// ============================
const RateLimiter = {
  _lastRequest: 0,

  async wait() {
    const now = Date.now();
    const elapsed = now - this._lastRequest;
    if (elapsed < CONFIG.RATE_LIMIT_MS) {
      await new Promise(r => setTimeout(r, CONFIG.RATE_LIMIT_MS - elapsed));
    }
    this._lastRequest = Date.now();
  },
};

// ============================
// Request Deduplication
// ============================
const _inflightRequests = new Map();

function deduplicatedFetch(key, fetchFn) {
  if (_inflightRequests.has(key)) {
    return _inflightRequests.get(key);
  }

  const promise = fetchFn().finally(() => {
    _inflightRequests.delete(key);
  });

  _inflightRequests.set(key, promise);
  return promise;
}

// ============================
// State Management
// ============================
const state = {
  currentPage: 'home',
  currentFilter: 'semua',
  ongoingAnime: [],
  completeAnime: [],
  searchResults: [],
  scheduleData: [],
  genreList: [],
  isLoading: false,
  apiConnected: false,
  currentPageNum: 1,
  workingApiUrl: null,  // API URL yang berhasil connect
};

// ============================
// Mock/Fallback Data
// ============================
const MOCK_ANIME = [];

const MOCK_POPULAR = [
  {
    title: "One Piece Subtitle Indonesia",
    thumb: "https://placehold.co/100x100/1a1a24/e84393?text=OP",
    genres: "Action, Adventure, Comedy, Drama, Fantasy, Shounen, Super Power",
    viewers: "334 User Online"
  },
  {
    title: "Tensei shitara Slime Datta Ken 4th Season Subtitle Indonesia",
    thumb: "https://placehold.co/100x100/1a1a24/6c5ce7?text=Tensura",
    genres: "Action, Comedy, Fantasy, Isekai, Reincarnation, Shounen",
    viewers: "171 User Online"
  },
  {
    title: "Detective Conan Subtitle Indonesia",
    thumb: "https://placehold.co/100x100/1a1a24/00cec9?text=Conan",
    genres: "Adventure, Comedy, Detective, Mystery, Police, Shounen",
    viewers: "114 User Online"
  },
  {
    title: "Naruto: Shippuuden Subtitle Indonesia",
    thumb: "https://placehold.co/100x100/1a1a24/fdcb6e?text=Naruto",
    genres: "Action, Adventure, Comedy, Martial Arts, Shounen, Super Power",
    viewers: "98 User Online"
  },
  {
    title: "Jujutsu Kaisen Season 3 Subtitle Indonesia",
    thumb: "https://placehold.co/100x100/1a1a24/a29bfe?text=JJK",
    genres: "Action, Drama, School, Shounen, Supernatural",
    viewers: "87 User Online"
  }
];

const MOCK_SCHEDULE = [
  { day: "Senin", anime: ["Hokuto no Ken: Fist of the North Star", "Kami no Shizuku", "Snowball Earth"] },
  { day: "Selasa", anime: ["One Piece", "Kamiire Botan", "Rakudai Kenja no Gakuin Musou"] },
  { day: "Rabu", anime: ["Tensei shitara Slime Datta Ken 4th Season", "Detective Conan"] },
  { day: "Kamis", anime: ["Garusu Bando-chan", "Heroine? Saijo Iii", "Awajima Hyakkei"] },
  { day: "Jumat", anime: ["Naruto: Shippuuden", "Jujutsu Kaisen Season 3"] },
  { day: "Sabtu", anime: ["Bleach: Thousand-Year Blood War", "Dragon Ball Daima"] },
  { day: "Minggu", anime: ["Chainsaw Man Season 2", "Solo Leveling Season 2"] }
];

const MOCK_GENRES = [
  "Action", "Adventure", "Comedy", "Demons", "Drama", "Ecchi", "Fantasy", "Game",
  "Harem", "Historical", "Horror", "Isekai", "Josei", "Kids", "Magic", "Martial Arts",
  "Mecha", "Military", "Music", "Mystery", "Parody", "Police", "Psychological",
  "Romance", "Samurai", "School", "Sci-Fi", "Seinen", "Shoujo", "Shounen",
  "Slice of Life", "Space", "Sports", "Super Power", "Supernatural", "Thriller",
  "Vampire"
];

// ============================
// API Service (dengan caching)
// ============================
class AnimeAPI {
  constructor() {
    this.baseUrl = localStorage.getItem('allunime_working_api') || null;
    this.apiType = localStorage.getItem('allunime_api_type') || 'standard';
    this._probePromise = null;
  }

  async checkEndpoint(url, proxy = '') {
    const cleanUrl = url.replace(/\/$/, '');
    const cb = '?t=' + Date.now();
    
    // Coba standard endpoint /home
    try {
      const targetUrl = proxy ? proxy + encodeURIComponent(cleanUrl + '/home' + cb) : cleanUrl + '/home' + cb;
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const json = await res.json();
        if (json && (Array.isArray(json) || json.data || json.home || json.ongoing)) {
          return { ok: true, type: 'standard' };
        }
      }
    } catch {}

    // Coba Eksa endpoint /terbaru
    try {
      const targetUrl = proxy ? proxy + encodeURIComponent(cleanUrl + '/terbaru' + cb) : cleanUrl + '/terbaru' + cb;
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const json = await res.json();
        if (json && (Array.isArray(json) || json.data || json.terbaru || Array.isArray(json.ongoing))) {
          return { ok: true, type: 'eksa' };
        }
      }
    } catch {}

    return { ok: false };
  }

  async checkEndpointWithProxyFallback(url) {
    // Jalankan pengecekan langsung dan proxy secara paralel untuk performa maksimal!
    const checks = [
      this.checkEndpoint(url).then(res => ({ ...res, proxy: '' })),
      this.checkEndpoint(url, CONFIG.CORS_PROXIES[0]).then(res => ({ ...res, proxy: CONFIG.CORS_PROXIES[0] })),
      this.checkEndpoint(url, CONFIG.CORS_PROXIES[1]).then(res => ({ ...res, proxy: CONFIG.CORS_PROXIES[1] }))
    ];

    const results = await Promise.all(checks);
    const successful = results.find(r => r.ok);
    return successful || { ok: false };
  }

  /**
   * Probe semua API URL untuk cari yang hidup.
   * Hasilnya di-cache supaya tidak probe ulang terus.
   */
  async probeApis() {
    if (this.baseUrl) {
      const check = await this.checkEndpointWithProxyFallback(this.baseUrl);
      if (check.ok) {
        this.apiType = check.type;
        this._proxyPrefix = check.proxy;
        state.apiConnected = true;
        updateApiStatus(true);
        return this.baseUrl;
      }
    }

    // Cek semua fallbacks secara paralel (sangat cepat!)
    const promises = CONFIG.API_URLS.map(async (url) => {
      const check = await this.checkEndpointWithProxyFallback(url);
      return { url, check };
    });

    const results = await Promise.all(promises);
    const working = results.find(r => r.check.ok);

    if (working) {
      this.baseUrl = working.url;
      this.apiType = working.check.type;
      this._proxyPrefix = working.check.proxy;
      localStorage.setItem('allunime_working_api', working.url);
      localStorage.setItem('allunime_api_type', working.check.type);
      state.apiConnected = true;
      updateApiStatus(true);
      console.log(`✅ Connected to: ${working.url} (${working.check.type})`);
      return working.url;
    }

    state.apiConnected = false;
    updateApiStatus(false);
    console.warn('⚠️ Tidak ada API yang bisa dihubungi. Menggunakan data demo.');
    return null;
  }

  /**
   * Pastikan API sudah di-probe (singleton promise)
   */
  async ensureConnected() {
    if (state.apiConnected && this.baseUrl) return true;
    if (!this._probePromise) {
      this._probePromise = this.probeApis().finally(() => {
        this._probePromise = null;
      });
    }
    await this._probePromise;
    return state.apiConnected;
  }

  /**
   * Fetch dengan rate limiter
   */
  async _rawFetch(endpoint) {
    if (!this.baseUrl) throw new Error('No API URL');

    await RateLimiter.wait();

    const sep = endpoint.includes('?') ? '&' : '?';
    const cleanEndpoint = endpoint + sep + 't=' + Date.now();

    const url = this._proxyPrefix
      ? this._proxyPrefix + encodeURIComponent(this.baseUrl + cleanEndpoint)
      : this.baseUrl + cleanEndpoint;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Fetch dengan cache + deduplication + stale-while-revalidate
   */
  async cachedFetch(endpoint, cacheKey, cacheType) {
    const ttl = CONFIG.CACHE_TTL[cacheType] || CONFIG.CACHE_TTL.home;

    // 1. Cek cache fresh
    const cached = CacheManager.get(cacheKey);
    if (cached) {
      console.log(`📦 Cache HIT [${cacheKey}]`);
      return cached;
    }

    // 2. Cek stale cache untuk tampilkan segera
    const stale = CacheManager.getStale(cacheKey);

    // 3. Fetch dari API (dengan deduplication)
    const fetchPromise = deduplicatedFetch(cacheKey, async () => {
      const connected = await this.ensureConnected();
      if (!connected) throw new Error('API not connected');
      const data = await this._rawFetch(endpoint);
      // Simpan ke cache
      CacheManager.set(cacheKey, data, ttl);
      console.log(`🌐 API fetched & cached [${cacheKey}]`);
      return data;
    });

    if (stale) {
      console.log(`♻️ Stale cache [${cacheKey}], revalidating...`);
      fetchPromise.catch(() => {});
      return stale;
    }

    return fetchPromise;
  }

  // ── Endpoint methods ──

  async getHome() {
    const endpoint = this.apiType === 'eksa' ? '/terbaru' : '/home';
    return this.cachedFetch(endpoint, 'home', 'home');
  }

  async getOngoing(page = 1) {
    const endpoint = this.apiType === 'eksa' ? '/terbaru' : `/ongoing/page/${page}`;
    return this.cachedFetch(endpoint, `ongoing_p${page}`, 'ongoing');
  }

  async getComplete(page = 1) {
    const endpoint = this.apiType === 'eksa' ? '/terbaru' : `/complete/page/${page}`;
    return this.cachedFetch(endpoint, `complete_p${page}`, 'complete');
  }

  async getSearch(query) {
    const endpoint = this.apiType === 'eksa' ? `/search/${encodeURIComponent(query)}` : `/search/${encodeURIComponent(query)}`;
    const key = `search_${query.toLowerCase().trim()}`;
    return this.cachedFetch(endpoint, key, 'search');
  }

  async getAnimeDetail(slug) {
    const endpoint = `/anime/${slug}`;
    return this.cachedFetch(endpoint, `detail_${slug}`, 'detail');
  }

  async getEpisode(slug) {
    const endpoint = this.apiType === 'eksa' ? `/stream/${slug}` : `/eps/${slug}`;
    return this.cachedFetch(endpoint, `eps_${slug}`, 'episode');
  }

  async getSchedule() {
    if (this.apiType === 'eksa') return null; // Eksa does not support schedule natively
    return this.cachedFetch('/schedule', 'schedule', 'schedule');
  }

  async getGenres() {
    const endpoint = this.apiType === 'eksa' ? '/genrelist' : '/genres';
    return this.cachedFetch(endpoint, 'genres', 'genres');
  }

  async getGenreAnime(genreId, page = 1) {
    const endpoint = `/genres/${genreId}/page/${page}`;
    return this.cachedFetch(endpoint, `genre_${genreId}_p${page}`, 'genre_anime');
  }
}

const api = new AnimeAPI();

// ============================
// DOM Helpers
// ============================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================
// Template Rendering
// ============================
function renderAnimeCard(anime, index = 0) {
  const year = anime.year || anime.date?.match(/\d{4}/)?.[0] || '';
  const type = anime.type || 'TV';
  const date = anime.date || '';
  const episode = anime.episode || '';

  return `
    <div class="anime-card" data-slug="${anime.slug || ''}" data-index="${index}" onclick="handleCardClick(this)">
      <div class="anime-thumb">
        <img src="${anime.thumb || 'https://placehold.co/300x400/1a1a24/6c6c85?text=No+Image'}" 
             alt="${anime.title}" loading="lazy"
             onerror="this.src='https://placehold.co/300x400/1a1a24/6c6c85?text=No+Image'">
        <div class="anime-play-overlay">
          <div class="play-btn-icon">▶</div>
        </div>
        <div class="anime-badge">
          ${episode ? `<span class="badge badge-episode">Ep ${episode}</span>` : ''}
          <span class="badge badge-type">${type}</span>
        </div>
      </div>
      <div class="anime-info">
        <h3 class="anime-title">${anime.title}</h3>
        <div class="anime-meta">
          ${year ? `<span class="anime-meta-item">${year}</span><span class="anime-meta-dot"></span>` : ''}
          <span class="anime-meta-item">${type}</span>
          ${date ? `<span class="anime-meta-dot"></span><span class="anime-meta-item">${date}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderSkeletonCards(count = 8) {
  return Array(count).fill('').map(() => `
    <div class="skeleton-card">
      <div class="skeleton skeleton-thumb"></div>
      <div class="skeleton skeleton-text"></div>
      <div class="skeleton skeleton-text-short"></div>
    </div>
  `).join('');
}

function renderPopularItem(item) {
  return `
    <div class="popular-item" onclick="handlePopularClick('${item.title}')">
      <div class="popular-item-thumb">
        <img src="${item.thumb}" alt="${item.title}" loading="lazy"
             onerror="this.src='https://placehold.co/100x100/1a1a24/6c6c85?text=?'">
      </div>
      <div class="popular-item-info">
        <div class="popular-item-title">${item.title}</div>
        <div class="popular-item-genres">Genres: ${item.genres}</div>
        <div class="popular-item-viewers">👥 ${item.viewers}</div>
      </div>
    </div>
  `;
}

// ============================
// Page Rendering
// ============================
function renderHomePage(animeList) {
  const mainContent = $('#main-content');
  mainContent.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Anime Terbaru</h2>
      <div class="filter-tabs">
        <button class="filter-tab ${state.currentFilter === 'semua' ? 'active' : ''}" onclick="filterAnime('semua')">Semua</button>
        <button class="filter-tab ${state.currentFilter === 'anime' ? 'active' : ''}" onclick="filterAnime('anime')">Anime</button>
        <button class="filter-tab ${state.currentFilter === 'donghua' ? 'active' : ''}" onclick="filterAnime('donghua')">Donghua</button>
      </div>
    </div>
    <div class="anime-grid" id="anime-grid">
      ${animeList.map((a, i) => renderAnimeCard(a, i)).join('')}
    </div>
    <div class="pagination" id="pagination">
      ${renderPagination()}
    </div>
  `;
}

function renderSchedulePage() {
  const mainContent = $('#main-content');
  const data = state.scheduleData.length ? state.scheduleData : MOCK_SCHEDULE;

  mainContent.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Jadwal Tayang Anime</h2>
    </div>
    <div class="schedule-container">
      ${data.map(day => `
        <div class="schedule-day animate-in">
          <div class="schedule-day-header">📅 ${day.day}</div>
          <div class="schedule-day-list">
            ${(day.anime || []).map(title => `
              <div class="schedule-anime-item" onclick="searchAnime('${typeof title === 'string' ? title : title.title}')">
                <span class="schedule-anime-title">${typeof title === 'string' ? title : title.title}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderGenrePage() {
  const mainContent = $('#main-content');
  const genres = state.genreList.length ? state.genreList : MOCK_GENRES;

  mainContent.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Daftar Genre</h2>
    </div>
    <div class="genre-grid">
      ${genres.map(genre => {
        const name = typeof genre === 'string' ? genre : genre.name;
        const slug = typeof genre === 'string' ? genre.toLowerCase().replace(/\s+/g, '-') : genre.slug;
        return `<button class="genre-tag" onclick="loadGenreAnime('${slug}', '${name}')">${name}</button>`;
      }).join('')}
    </div>
  `;
}

function renderSearchResultsPage(results, query) {
  const mainContent = $('#main-content');
  if (!results.length) {
    mainContent.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">Hasil Pencarian: "${query}"</h2>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-text">Tidak ada hasil ditemukan</div>
        <div class="empty-state-sub">Coba kata kunci lain</div>
      </div>
    `;
    return;
  }

  mainContent.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Hasil Pencarian: "${query}"</h2>
    </div>
    <div class="anime-grid" id="anime-grid">
      ${results.map((a, i) => renderAnimeCard(a, i)).join('')}
    </div>
  `;
}

function renderPagination() {
  const page = state.currentPageNum;
  const maxPage = 10;
  let buttons = '';
  buttons += `<button class="page-btn ${page <= 1 ? 'disabled' : ''}" onclick="changePage(${page - 1})">‹</button>`;
  const start = Math.max(1, page - 2);
  const end = Math.min(maxPage, page + 2);
  for (let i = start; i <= end; i++) {
    buttons += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
  }
  buttons += `<button class="page-btn ${page >= maxPage ? 'disabled' : ''}" onclick="changePage(${page + 1})">›</button>`;
  return buttons;
}

// ============================
// Data Fetching (cached!)
// ============================
async function loadHomeData() {
  const grid = $('#anime-grid');
  if (grid) grid.innerHTML = renderSkeletonCards(12);

  try {
    const data = await api.getHome();
    const animeList = normalizeAnimeList(data);
    if (animeList.length > 0) {
      state.ongoingAnime = animeList;
      renderHomePage(animeList);
      return;
    }
  } catch (err) {
    console.warn('Home fetch failed:', err.message);
  }

  // Fallback ke mock
  state.ongoingAnime = MOCK_ANIME;
  renderHomePage(MOCK_ANIME);
}

async function loadOngoing(page = 1) {
  state.currentPageNum = page;

  try {
    const data = await api.getOngoing(page);
    const animeList = normalizeAnimeList(data);
    if (animeList.length > 0) {
      renderHomePage(animeList);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
  } catch (err) {
    console.warn('Ongoing fetch failed:', err.message);
  }

  renderHomePage(MOCK_ANIME);
}

let _searchTimeout;
async function searchAnime(query) {
  if (!query || query.length < CONFIG.SEARCH_MIN_CHARS) return;

  const searchDropdown = $('#search-results');
  if (searchDropdown) {
    searchDropdown.classList.add('active');
    searchDropdown.innerHTML = '<div class="search-loading">🔍 Mencari...</div>';
  }

  try {
    const data = await api.getSearch(query);
    const results = normalizeAnimeList(data);
    state.searchResults = results;
    renderSearchDropdown(results);
  } catch {
    // Fallback: cari di data yang sudah ada
    const allLocal = [...state.ongoingAnime, ...MOCK_ANIME];
    const filtered = allLocal.filter(a =>
      a.title.toLowerCase().includes(query.toLowerCase())
    );
    state.searchResults = filtered;
    renderSearchDropdown(filtered);
  }
}

function renderSearchDropdown(results) {
  const searchDropdown = $('#search-results');
  if (!searchDropdown) return;

  if (results.length === 0) {
    searchDropdown.innerHTML = '<div class="search-empty">Tidak ada hasil ditemukan</div>';
    return;
  }

  searchDropdown.innerHTML = results.slice(0, 8).map(anime => `
    <div class="search-result-item" onclick="selectSearchResult('${anime.slug}', '${anime.title.replace(/'/g, "\\'")}')">
      <div class="search-result-thumb">
        <img src="${anime.thumb || 'https://placehold.co/50x70/1a1a24/6c6c85?text=?'}" alt="${anime.title}">
      </div>
      <div class="search-result-info">
        <div class="search-result-title">${anime.title}</div>
        <div class="search-result-meta">${anime.type || 'TV'} • ${(anime.genres || []).join(', ')}</div>
      </div>
    </div>
  `).join('');
}

async function loadSchedule() {
  try {
    const data = await api.getSchedule();
    if (data) {
      if (Array.isArray(data)) {
        state.scheduleData = data;
      } else if (data.data) {
        state.scheduleData = Array.isArray(data.data)
          ? data.data
          : Object.entries(data.data).map(([day, anime]) => ({ day, anime }));
      }
    }
  } catch (err) {
    console.warn('Schedule fetch failed:', err.message);
  }
  renderSchedulePage();
}

async function loadGenres() {
  try {
    const data = await api.getGenres();
    if (data) {
      state.genreList = Array.isArray(data) ? data : (data.data || data.genres || MOCK_GENRES);
    }
  } catch (err) {
    console.warn('Genres fetch failed:', err.message);
  }
  renderGenrePage();
}

async function loadGenreAnime(slug, name) {
  const mainContent = $('#main-content');
  mainContent.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Genre: ${name}</h2>
    </div>
    <div class="anime-grid" id="anime-grid">${renderSkeletonCards(8)}</div>
  `;

  try {
    const data = await api.getGenreAnime(slug);
    const animeList = normalizeAnimeList(data);
    if (animeList.length > 0) {
      $('#anime-grid').innerHTML = animeList.map((a, i) => renderAnimeCard(a, i)).join('');
      return;
    }
  } catch (err) {
    console.warn('Genre anime fetch failed:', err.message);
  }

  const filtered = MOCK_ANIME.filter(a =>
    a.genres && a.genres.some(g => g.toLowerCase() === name.toLowerCase())
  );
  const grid = $('#anime-grid');
  grid.innerHTML = filtered.length > 0
    ? filtered.map((a, i) => renderAnimeCard(a, i)).join('')
    : '<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-text">Tidak ada anime ditemukan untuk genre ini</div></div>';
}

// ============================
// Data Normalization
// ============================
function normalizeAnimeList(data) {
  if (!data) return [];

  let list = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data.home && data.home.ongoing && Array.isArray(data.home.ongoing)) {
    list = data.home.ongoing;
  } else if (data.home && data.home.complete && Array.isArray(data.home.complete)) {
    list = data.home.complete;
  } else if (data.data && Array.isArray(data.data)) {
    list = data.data;
  } else if (data.ongoing && Array.isArray(data.ongoing)) {
    list = data.ongoing;
  } else if (data.anime && Array.isArray(data.anime)) {
    list = data.anime;
  } else if (data.result && Array.isArray(data.result)) {
    list = data.result;
  } else if (data.search && Array.isArray(data.search)) {
    list = data.search;
  }

  return list.map(item => {
    let cleanSlug = item.slug || item.endpoint || item.id || '';
    if (!cleanSlug && item.link) {
      const parts = item.link.replace(/\/$/, '').split('/');
      cleanSlug = parts[parts.length - 1] || '';
    }
    if (cleanSlug) {
      cleanSlug = cleanSlug.replace(/^\//, ''); // remove leading slash
    } else {
      cleanSlug = extractSlug(item.title);
    }

    return {
      title: item.title || item.name || item.judul || '',
      thumb: item.thumb || item.thumbnail || item.poster || item.image || item.cover || '',
      episode: item.episode || item.total_episode || item.eps || '',
      type: item.type || item.status || 'TV',
      date: item.date || item.updated_on || item.updated || item.time || item.day_updated || '',
      slug: cleanSlug,
      genres: item.genres || item.genre || [],
      year: item.year || item.season || '',
      score: item.score || item.rating || '',
      synopsis: item.synopsis || item.sinopsis || item.description || '',
    };
  });
}

function extractSlug(title) {
  if (!title) return '';
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 50);
}

function getAnimeSlug(cleanSlug) {
  if (!cleanSlug) return '';
  if (cleanSlug.includes('-episode-')) {
    return cleanSlug.split('-episode-')[0];
  }
  if (cleanSlug.includes('-eps-')) {
    return cleanSlug.split('-eps-')[0];
  }
  return cleanSlug;
}

// ============================
// Anime Detail Modal
// ============================
async function openAnimeDetail(cardElement) {
  const slug = cardElement?.dataset?.slug;
  const modal = $('#modal-overlay');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  const modalBody = $('.modal-body');
  const modalHeaderImg = $('.modal-header img');

  // Cari dari data yang sudah ada (TANPA hit API)
  const allAnime = [...state.ongoingAnime, ...state.searchResults, ...MOCK_ANIME];
  const anime = allAnime.find(a => a.slug === slug) || allAnime[0];

  if (!anime) { closeModal(); return; }

  modalHeaderImg.src = anime.thumb || 'https://placehold.co/900x280/1a1a24/e84393?text=Anime';

  // Coba ambil detail dari cache/API (cached 6 jam!)
  let detail = null;
  if (slug) {
    try {
      const data = await api.getAnimeDetail(slug);
      detail = data?.data || data;
    } catch (err) {
      const baseSlug = getAnimeSlug(slug);
      if (baseSlug !== slug) {
        try {
          const data = await api.getAnimeDetail(baseSlug);
          detail = data?.data || data;
        } catch (_) {}
      }
      if (!detail) {
        console.warn('Detail fetch failed:', err.message);
      }
    }
  }

  const genres = detail?.genres || anime.genres || ['Action', 'Fantasy'];
  const synopsis = detail?.synopsis || anime.synopsis || 'Synopsis tidak tersedia. Silakan deploy API OtakuDesu untuk melihat sinopsis lengkap.';
  const episodes = detail?.episode_list || detail?.episodes || detail?.list_episode || detail?.episode || [];
  const title = detail?.title || anime.title;
  const score = detail?.score || anime.score || '⭐ N/A';
  const status = detail?.status || anime.type || 'Ongoing';

  const isFav = AccountManager.isBookmarked(slug);
  const animeThumb = detail?.thumb || anime.thumb || '';

  modalBody.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 5px;">
      <h2 class="modal-title" style="margin: 0;">${title}</h2>
      <button class="bookmark-btn ${isFav ? 'active' : ''}" onclick="toggleBookmarkFromModal('${slug}', '${title.replace(/'/g, "\\'")}', '${animeThumb.replace(/'/g, "\\'")}')">
        <span>${isFav ? '⭐ Di-Bookmark' : '⭐ Bookmark'}</span>
      </button>
    </div>
    <div class="modal-meta">
      <span class="modal-meta-tag">${status}</span>
      <span class="modal-meta-tag">${score}</span>
      ${(Array.isArray(genres) ? genres : [genres]).map(g => {
        const name = typeof g === 'string' ? g : g.name || g;
        return `<span class="modal-meta-tag">${name}</span>`;
      }).join('')}
    </div>
    <p class="modal-synopsis">${synopsis}</p>
    <h3 class="modal-section-title">Episodes</h3>
    <div class="episode-list">
      ${episodes.length > 0
        ? episodes.map(ep => {
            const epTitle = typeof ep === 'string' ? ep : (ep.title || ep.episode || `Ep ${ep.number || ''}`);
            let epSlug = typeof ep === 'string' ? '' : (ep.slug || ep.endpoint || ep.link || '');
            if (epSlug.includes('http') || epSlug.includes('/')) {
              const parts = epSlug.replace(/\/$/, '').split('/');
              epSlug = parts[parts.length - 1] || '';
            }
            return `<button class="episode-btn" onclick="playEpisode('${epSlug}', '${slug}')" title="${epTitle}">${epTitle.replace(/.*Episode\s*/i, 'Ep ')}</button>`;
          }).join('')
        : Array.from({length: Math.min(parseInt(anime.episode) || 12, 24)}, (_, i) =>
            `<button class="episode-btn" onclick="showToast('Deploy API untuk menonton episode')">Ep ${i + 1}</button>`
          ).join('')
      }
    </div>
  `;
}

function closeModal() {
  $('#modal-overlay').classList.remove('active');
  document.body.style.overflow = '';
}

async function playEpisode(slug, parentAnimeSlug = '') {
  if (!slug) {
    showToast('Link episode tidak valid', 'error');
    return;
  }

  // Tutup detail modal
  closeModal();

  const mainContent = $('#main-content');
  if (mainContent) {
    // Show loading skeletons inside main content
    mainContent.innerHTML = `
      <div class="stream-container">
        <div class="stream-player-wrapper skeleton" style="height: 400px; display: flex; align-items: center; justify-content: center; background-color: var(--bg-secondary); border-radius: var(--radius-lg);">
          <div style="font-size: 1.2rem; color: var(--text-secondary); animation: pulse 1.5s infinite;">📺 Memuat video player...</div>
        </div>
      </div>
    `;
  }

  try {
    // 1. Fetch streaming data
    const streamData = await api.getEpisode(slug);
    const streamInfo = streamData?.data || streamData;
    
    // 2. Fetch parent anime detail
    if (!parentAnimeSlug) {
      parentAnimeSlug = slug.replace(/-episode-\d+/, '');
    }

    let animeDetail;
    try {
      const detailData = await api.getAnimeDetail(parentAnimeSlug);
      animeDetail = detailData?.data || detailData;
    } catch {
      const baseSlug = getAnimeSlug(parentAnimeSlug);
      const detailData = await api.getAnimeDetail(baseSlug);
      animeDetail = detailData?.data || detailData;
      parentAnimeSlug = baseSlug;
    }

    if (!animeDetail) {
      throw new Error('Detail anime tidak ditemukan');
    }

    // 3. Render streaming player view
    renderStreamPage(slug, parentAnimeSlug, streamInfo, animeDetail);

    // 4. Catat ke riwayat nonton jika ada user login
    const currentUser = AccountManager.getCurrentUser();
    if (currentUser) {
      const epList = animeDetail.episode_list || [];
      const getCleanSlug = (item) => {
        let s = item.slug || item.endpoint || item.link || '';
        if (s.includes('http') || s.includes('/')) {
          s = s.replace(/\/$/, '').split('/').pop();
        }
        return s;
      };
      const currentEp = epList.find(ep => getCleanSlug(ep) === slug);
      const epTitle = currentEp ? currentEp.title : `Episode ${slug.split('-').pop()}`;
      AccountManager.addRecent(animeDetail.title, parentAnimeSlug, epTitle, slug, animeDetail.thumb);
    }
  } catch (err) {
    showToast('Gagal memuat streaming: ' + err.message, 'error');
    loadHomeData();
  }
}

// ============================
// Event Handlers
// ============================
function filterAnime(filter) {
  state.currentFilter = filter;
  $$('.filter-tab').forEach(tab => {
    tab.classList.toggle('active', tab.textContent.toLowerCase() === filter);
  });

  let filtered = state.ongoingAnime.length ? state.ongoingAnime : MOCK_ANIME;

  if (filter === 'anime') {
    filtered = filtered.filter(a => !['ONA', 'DONGHUA'].includes((a.type || '').toUpperCase()));
  } else if (filter === 'donghua') {
    filtered = filtered.filter(a => ['ONA', 'DONGHUA'].includes((a.type || '').toUpperCase()));
  }

  const grid = $('#anime-grid');
  if (grid) {
    grid.innerHTML = filtered.length > 0
      ? filtered.map((a, i) => renderAnimeCard(a, i)).join('')
      : '<div class="empty-state"><div class="empty-state-icon">📂</div><div class="empty-state-text">Tidak ada anime ditemukan</div></div>';
  }
}

function changePage(page) {
  if (page < 1) return;
  state.currentPageNum = page;
  loadOngoing(page);
}

function navigateTo(page) {
  state.currentPage = page;
  $$('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === page);
  });

  switch (page) {
    case 'home': loadHomeData(); break;
    case 'daftar': loadOngoing(); break;
    case 'jadwal': loadSchedule(); break;
    case 'genre': loadGenres(); break;
    default: loadHomeData();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function selectSearchResult(slug, title) {
  const searchDropdown = $('#search-results');
  const searchInput = $('#search-input');
  if (searchDropdown) searchDropdown.classList.remove('active');
  if (searchInput) searchInput.value = '';

  const tempCard = document.createElement('div');
  tempCard.dataset.slug = slug;
  openAnimeDetail(tempCard);
}

function handlePopularClick(title) {
  const searchInput = $('#search-input');
  if (searchInput) {
    searchInput.value = title.replace(' Subtitle Indonesia', '');
    searchAnime(searchInput.value);
  }
}

function toggleMobileMenu() {
  $('.nav-links').classList.toggle('open');
}

// ============================
// API Configuration (manual override)
// ============================
function updateApiUrl() {
  const input = $('#api-url-input');
  const url = input.value.trim().replace(/\/$/, '');

  if (url) {
    showToast('🔄 Menghubungkan ke API...', 'info');

    api.checkEndpointWithProxyFallback(url).then((check) => {
      if (check.ok) {
        api.baseUrl = url;
        api.apiType = check.type;
        api._proxyPrefix = check.proxy;
        state.apiConnected = true;
        updateApiStatus(true);
        
        localStorage.setItem('allunime_working_api', url);
        localStorage.setItem('allunime_api_type', check.type);
        
        showToast(`✅ Terhubung! Tipe API: ${check.type === 'eksa' ? 'Eksa' : 'Standar'}`, 'success');
        
        // Hapus cache lama supaya refresh
        CacheManager.cleanup();
        loadHomeData();
      } else {
        showToast('❌ Gagal terhubung. Periksa URL API Anda.', 'error');
        state.apiConnected = false;
        updateApiStatus(false);
      }
    }).catch(() => {
      showToast('❌ Gagal terhubung. Periksa koneksi Anda.', 'error');
      state.apiConnected = false;
      updateApiStatus(false);
    });
  }
}

function updateApiStatus(connected) {
  const dot = $('.api-status-dot');
  const text = $('.api-status-text');
  if (dot) dot.classList.toggle('connected', connected);
  if (text) text.textContent = connected ? 'Terhubung' : 'Tidak terhubung';

  // Update input field dengan URL yang berhasil
  const input = $('#api-url-input');
  if (input && connected && api.baseUrl) {
    input.value = api.baseUrl;
  }
}

// ============================
// Utilities
// ============================
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function handleSearchInput(e) {
  const query = e.target.value.trim();
  const searchDropdown = $('#search-results');
  clearTimeout(_searchTimeout);

  if (query.length < CONFIG.SEARCH_MIN_CHARS) {
    if (searchDropdown) searchDropdown.classList.remove('active');
    return;
  }

  _searchTimeout = setTimeout(() => searchAnime(query), CONFIG.SEARCH_DEBOUNCE);
}

function handleSearchSubmit(e) {
  if (e.key === 'Enter') {
    const query = e.target.value.trim();
    const searchDropdown = $('#search-results');
    if (searchDropdown) searchDropdown.classList.remove('active');

    if (query.length >= CONFIG.SEARCH_MIN_CHARS) {
      api.getSearch(query).then(data => {
        const results = normalizeAnimeList(data);
        state.searchResults = results;
        renderSearchResultsPage(results, query);
      }).catch(() => {
        const filtered = [...state.ongoingAnime, ...MOCK_ANIME].filter(
          a => a.title.toLowerCase().includes(query.toLowerCase())
        );
        renderSearchResultsPage(filtered, query);
      });
    }
  }
}

// ============================
// Sidebar
// ============================
function renderSidebar() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;

  const currentUser = AccountManager.getCurrentUser();
  const acc = AccountManager.getActiveAccount();
  const recents = (acc && acc.recents) ? acc.recents : [];

  let recentsHtml = '';
  if (!currentUser) {
    recentsHtml = `
      <div class="empty-state" style="padding: var(--space-md); margin-top: 10px; border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        <div class="empty-state-icon" style="font-size: 1.5rem; margin-bottom: 5px;">👤</div>
        <div class="empty-state-text" style="font-size: 0.85rem; font-weight: 600;">Belum Masuk Akun</div>
        <div class="empty-state-sub" style="font-size: 0.75rem;">Masuk akun untuk menyimpan riwayat nonton Anda secara realtime.</div>
      </div>
    `;
  } else if (recents.length === 0) {
    recentsHtml = `
      <div class="empty-state" style="padding: var(--space-md); margin-top: 10px; border: 1px dashed var(--border-color); border-radius: var(--radius-md);">
        <div class="empty-state-icon" style="font-size: 1.5rem; margin-bottom: 5px;">📺</div>
        <div class="empty-state-text" style="font-size: 0.85rem; font-weight: 600;">Belum Ada Riwayat</div>
        <div class="empty-state-sub" style="font-size: 0.75rem;">Mulai menonton anime untuk melihat daftar riwayat di sini.</div>
      </div>
    `;
  } else {
    recentsHtml = `
      <div class="recent-list">
        ${recents.map(r => {
          const timeString = formatRelativeTime(r.watchedAt);
          return `
            <div class="recent-item animate-in" onclick="playEpisode('${r.epSlug}', '${r.animeSlug}')">
              <div class="recent-item-thumb">
                <img src="${r.thumb || 'https://placehold.co/100x150/1a1a24/6c6c85?text=?'}" alt="${r.animeTitle}" loading="lazy" onerror="this.src='https://placehold.co/100x150/1a1a24/6c6c85?text=?'">
              </div>
              <div class="recent-item-info">
                <div class="recent-item-title">${r.animeTitle}</div>
                <div class="recent-item-episode">${r.epTitle}</div>
                <div class="recent-item-time">🕒 ${timeString}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  sidebar.innerHTML = `
    <div class="now-playing">
      <div class="now-playing-icon">▶</div>
      <div class="now-playing-info">
        <div class="now-playing-title">${currentUser ? `Halo, ${currentUser}!` : 'Selamat Datang di Allunime!'}</div>
        <div class="now-playing-source">${currentUser ? 'Lanjutkan menonton favoritmu' : 'Nonton anime subtitle Indonesia'}</div>
      </div>
    </div>

    <div class="popular-widget">
      <h3>🕒 Recent Watched</h3>
      ${recentsHtml}
    </div>
  `;
}

// ============================
// Initialization
// ============================
function initApp() {
  renderSidebar();
  loadHomeData();
  updateAccountModalView(); // Memuat status login dan ikon akun di nav

  // Cleanup cache lama saat startup
  CacheManager.cleanup();

  // Header scroll effect
  window.addEventListener('scroll', () => {
    const header = $('.header');
    if (header) header.classList.toggle('scrolled', window.scrollY > 20);
  });

  // Close search dropdown on click outside
  document.addEventListener('click', (e) => {
    const searchContainer = $('.search-container');
    const searchDropdown = $('#search-results');
    if (searchContainer && searchDropdown && !searchContainer.contains(e.target)) {
      searchDropdown.classList.remove('active');
    }
  });

  // Modal close on overlay click
  const modalOverlay = $('#modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });
  }

  // Account modal close on overlay click
  const accountModalOverlay = $('#account-modal-overlay');
  if (accountModalOverlay) {
    accountModalOverlay.addEventListener('click', (e) => {
      if (e.target === accountModalOverlay) closeAccountModal();
    });
  }

  // ESC to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeAccountModal();
    }
  });

  // Set API URL yang sudah tersimpan
  const apiInput = $('#api-url-input');
  if (apiInput && api.baseUrl) {
    apiInput.value = api.baseUrl;
  }
}

document.addEventListener('DOMContentLoaded', initApp);

// ============================
// Account & Profile Management
// ============================
const AccountManager = {
  getAccounts() {
    const data = localStorage.getItem('allunime_accounts');
    return data ? JSON.parse(data) : [];
  },
  
  saveAccounts(accounts) {
    localStorage.setItem('allunime_accounts', JSON.stringify(accounts));
  },
  
  getCurrentUser() {
    return localStorage.getItem('allunime_current_user') || null;
  },
  
  setCurrentUser(username) {
    if (username) {
      localStorage.setItem('allunime_current_user', username);
    } else {
      localStorage.removeItem('allunime_current_user');
    }
  },
  
  createOrLoginAccount(username) {
    const cleanUsername = username.trim();
    if (!cleanUsername) return null;
    
    let accounts = this.getAccounts();
    let account = accounts.find(a => a.username.toLowerCase() === cleanUsername.toLowerCase());
    
    if (!account) {
      account = {
        username: cleanUsername,
        bookmarks: [],
        recents: []
      };
      accounts.push(account);
      this.saveAccounts(accounts);
    }
    
    this.setCurrentUser(account.username);
    return account;
  },
  
  getActiveAccount() {
    const current = this.getCurrentUser();
    if (!current) return null;
    const accounts = this.getAccounts();
    return accounts.find(a => a.username === current) || null;
  },
  
  updateActiveAccount(updatedAccount) {
    let accounts = this.getAccounts();
    const idx = accounts.findIndex(a => a.username === updatedAccount.username);
    if (idx !== -1) {
      accounts[idx] = updatedAccount;
      this.saveAccounts(accounts);
    }
  },
  
  addBookmark(anime) {
    const acc = this.getActiveAccount();
    if (!acc) return false;
    
    if (!acc.bookmarks) acc.bookmarks = [];
    const exists = acc.bookmarks.some(b => b.slug === anime.slug);
    if (!exists) {
      acc.bookmarks.push({
        title: anime.title,
        slug: anime.slug,
        thumb: anime.thumb,
        type: anime.type || 'TV'
      });
      this.updateActiveAccount(acc);
      return true;
    }
    return false;
  },
  
  removeBookmark(slug) {
    const acc = this.getActiveAccount();
    if (!acc) return false;
    
    if (!acc.bookmarks) acc.bookmarks = [];
    const initialLen = acc.bookmarks.length;
    acc.bookmarks = acc.bookmarks.filter(b => b.slug !== slug);
    if (acc.bookmarks.length !== initialLen) {
      this.updateActiveAccount(acc);
      return true;
    }
    return false;
  },
  
  isBookmarked(slug) {
    const acc = this.getActiveAccount();
    if (!acc) return false;
    return acc.bookmarks && acc.bookmarks.some(b => b.slug === slug);
  },
  
  addRecent(animeTitle, animeSlug, epTitle, epSlug, thumb) {
    const acc = this.getActiveAccount();
    if (!acc) return;
    
    if (!acc.recents) acc.recents = [];
    
    // Hapus duplikat
    acc.recents = acc.recents.filter(r => r.epSlug !== epSlug);
    
    acc.recents.unshift({
      animeTitle,
      animeSlug,
      epTitle,
      epSlug,
      thumb,
      watchedAt: Date.now()
    });
    
    if (acc.recents.length > 10) {
      acc.recents.pop();
    }
    
    this.updateActiveAccount(acc);
    renderSidebar();
  }
};

// ============================
// UI Account Actions
// ============================
function openAccountModal() {
  const modal = $('#account-modal-overlay');
  if (!modal) return;
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  updateAccountModalView();
}

function closeAccountModal() {
  const modal = $('#account-modal-overlay');
  if (modal) modal.classList.remove('active');
  document.body.style.overflow = '';
}

function updateAccountModalView() {
  const currentUser = AccountManager.getCurrentUser();
  const loggedOutView = $('#account-logged-out-view');
  const loggedInView = $('#account-logged-in-view');
  const navAccount = $('#nav-account');
  
  if (currentUser) {
    if (loggedOutView) loggedOutView.style.display = 'none';
    if (loggedInView) loggedInView.style.display = 'block';
    
    const acc = AccountManager.getActiveAccount();
    if (acc) {
      const displayUser = $('#current-username-display');
      const bookCount = $('#bookmarks-count');
      const recCount = $('#recents-count');
      if (displayUser) displayUser.textContent = acc.username;
      if (bookCount) bookCount.textContent = acc.bookmarks ? acc.bookmarks.length : 0;
      if (recCount) recCount.textContent = acc.recents ? acc.recents.length : 0;
      
      if (navAccount) {
        navAccount.textContent = `👤 ${acc.username}`;
      }
    }
  } else {
    if (loggedOutView) loggedOutView.style.display = 'block';
    if (loggedInView) loggedInView.style.display = 'none';
    
    if (navAccount) {
      navAccount.textContent = '👤 Masuk';
    }
    
    const accounts = AccountManager.getAccounts();
    const existingSec = $('#existing-accounts-section');
    const container = $('#accounts-list-container');
    
    if (accounts.length > 0) {
      if (existingSec) existingSec.style.display = 'block';
      if (container) {
        container.innerHTML = accounts.map(a => `
          <div class="accounts-list-item" onclick="loginWithExisting('${a.username.replace(/'/g, "\\'")}')">
            <span>${a.username}</span>
            <span class="accounts-list-item-select">Masuk &raquo;</span>
          </div>
        `).join('');
      }
    } else {
      if (existingSec) existingSec.style.display = 'none';
    }
  }
}

function loginOrCreateAccount() {
  const input = $('#username-input');
  if (!input) return;
  const username = input.value.trim();
  if (!username) {
    showToast('Username tidak boleh kosong', 'error');
    return;
  }
  
  const acc = AccountManager.createOrLoginAccount(username);
  if (acc) {
    showToast(`Selamat datang, ${acc.username}!`, 'success');
    input.value = '';
    updateAccountModalView();
    renderSidebar();
    closeAccountModal();
  }
}

function loginWithExisting(username) {
  const acc = AccountManager.createOrLoginAccount(username);
  if (acc) {
    showToast(`Selamat datang kembali, ${acc.username}!`, 'success');
    updateAccountModalView();
    renderSidebar();
    closeAccountModal();
  }
}

function logoutAccount() {
  const current = AccountManager.getCurrentUser();
  AccountManager.setCurrentUser(null);
  showToast(`Sampai jumpa, ${current}!`, 'info');
  updateAccountModalView();
  renderSidebar();
  closeAccountModal();
}

function showFavoritesList() {
  const acc = AccountManager.getActiveAccount();
  if (!acc || !acc.bookmarks || acc.bookmarks.length === 0) {
    showToast('Belum ada anime favorit disimpan', 'info');
    return;
  }
  
  closeAccountModal();
  
  const mainContent = $('#main-content');
  if (mainContent) {
    mainContent.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">Bookmark / Favorit Saya</h2>
      </div>
      <div class="anime-grid" id="anime-grid">
        ${acc.bookmarks.map((a, i) => renderAnimeCard(a, i)).join('')}
      </div>
    `;
  }
}

// ============================
// Streaming Page Rendering & Action
// ============================
function renderStreamPage(episodeSlug, animeSlug, streamInfo, animeDetail) {
  const mainContent = $('#main-content');
  if (!mainContent) return;

  const streamUrl = streamInfo.stream_url || streamInfo.streaming_url || '';
  const mirrors = streamInfo.mirrors || [];
  const epList = animeDetail.episode_list || [];

  const getCleanSlug = (item) => {
    let s = item.slug || item.endpoint || item.link || '';
    if (s.includes('http') || s.includes('/')) {
      s = s.replace(/\/$/, '').split('/').pop();
    }
    return s;
  };

  const currentIndex = epList.findIndex(ep => getCleanSlug(ep) === episodeSlug);
  
  let prevSlug = '';
  let nextSlug = '';
  
  if (currentIndex !== -1) {
    // Di OtakuDesu, list episode terbalik (terbaru di atas)
    if (currentIndex + 1 < epList.length) {
      prevSlug = getCleanSlug(epList[currentIndex + 1]);
    }
    if (currentIndex - 1 >= 0) {
      nextSlug = getCleanSlug(epList[currentIndex - 1]);
    }
  }

  const isFav = AccountManager.isBookmarked(animeSlug);
  const currentEp = epList[currentIndex];
  const epTitle = currentEp ? currentEp.title : `Episode ${episodeSlug.split('-').pop()}`;

  mainContent.innerHTML = `
    <div class="stream-container">
      <div class="nav-breadcrumbs" style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-xs);">
        <a href="#" onclick="loadHomeData(); return false;" style="color: var(--text-link); text-decoration: none;">Beranda</a> &raquo; 
        <a href="#" onclick="showAnimeFromStream('${animeSlug}'); return false;" style="color: var(--text-link); text-decoration: none;">${animeDetail.title}</a> &raquo; 
        <span>${epTitle}</span>
      </div>

      <div class="stream-player-wrapper animate-in">
        <iframe id="main-player-iframe" class="stream-player-iframe" src="${streamUrl}" allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true" frameborder="0"></iframe>
      </div>

      <div class="stream-controls">
        <div class="stream-servers-box">
          <label for="server-select">Pilih Server:</label>
          <select id="server-select" class="stream-server-select" onchange="changePlayerMirror(this.value)">
            <option value="${streamUrl}">Default Server (B-TUBE)</option>
            ${mirrors.map(m => `<option value="${m.url}">${m.name}</option>`).join('')}
          </select>
        </div>

        <div class="stream-nav-buttons">
          <button class="stream-nav-btn ${prevSlug ? '' : 'disabled'}" onclick="${prevSlug ? `playEpisode('${prevSlug}', '${animeSlug}')` : ''}">&laquo; Prev</button>
          <button class="stream-nav-btn stream-nav-btn-main" onclick="showAnimeFromStream('${animeSlug}')">Semua Episode</button>
          <button class="stream-nav-btn ${nextSlug ? '' : 'disabled'}" onclick="${nextSlug ? `playEpisode('${nextSlug}', '${animeSlug}')` : ''}">Next &raquo;</button>
        </div>
      </div>

      <div class="stream-meta-card animate-in">
        <div class="stream-meta-header">
          <div class="stream-meta-title-box">
            <h2>${animeDetail.title}</h2>
            <p>${epTitle}</p>
          </div>
          <button class="bookmark-btn ${isFav ? 'active' : ''}" onclick="toggleBookmarkFromStream('${animeSlug}', '${animeDetail.title.replace(/'/g, "\\'")}', '${animeDetail.thumb}')">
            <span>${isFav ? '⭐ Di-Bookmark' : '⭐ Bookmark'}</span>
          </button>
        </div>
        
        <div style="display: flex; gap: var(--space-md); flex-wrap: wrap;">
          <img src="${animeDetail.thumb}" alt="${animeDetail.title}" style="width: 100px; height: 140px; border-radius: var(--radius-md); object-fit: cover;">
          <div style="flex: 1; min-width: 250px;">
            <div class="modal-meta" style="margin-bottom: 10px;">
              ${animeDetail.genres.map(g => `<span class="modal-meta-tag">${g}</span>`).join('')}
            </div>
            <p style="font-size: 0.9rem; color: var(--text-secondary); line-height: 1.5;">${animeDetail.synopsis || 'Sinopsis tidak tersedia.'}</p>
          </div>
        </div>

        <h3 style="font-size: 1rem; border-top: 1px solid var(--border-color); padding-top: var(--space-md); margin-top: var(--space-sm);">Semua Episode:</h3>
        <div class="episode-list" style="max-height: 150px; overflow-y: auto; padding: 5px;">
          ${epList.map(ep => {
            const clean = getCleanSlug(ep);
            const isCurrent = clean === episodeSlug;
            return `<button class="episode-btn ${isCurrent ? 'active' : ''}" onclick="playEpisode('${clean}', '${animeSlug}')">${ep.title.replace(/.*Episode\s*/i, 'Ep ')}</button>`;
          }).join('')}
        </div>
      </div>
    </div>
  `;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function changePlayerMirror(url) {
  const iframe = $('#main-player-iframe');
  if (iframe && url) {
    iframe.src = url;
    showToast('Mengubah server player...', 'info');
  }
}

function showAnimeFromStream(animeSlug) {
  const tempCard = document.createElement('div');
  tempCard.dataset.slug = animeSlug;
  openAnimeDetail(tempCard);
}

function toggleBookmarkFromStream(slug, title, thumb) {
  const currentUser = AccountManager.getCurrentUser();
  if (!currentUser) {
    showToast('Harap masuk ke akun terlebih dahulu', 'error');
    openAccountModal();
    return;
  }

  const btn = $('.bookmark-btn');
  const isFav = AccountManager.isBookmarked(slug);
  
  if (isFav) {
    AccountManager.removeBookmark(slug);
    if (btn) {
      btn.classList.remove('active');
      btn.querySelector('span').textContent = '⭐ Bookmark';
    }
    showToast('Dihapus dari Bookmark', 'info');
  } else {
    AccountManager.addBookmark({ slug, title, thumb });
    if (btn) {
      btn.classList.add('active');
      btn.querySelector('span').textContent = '⭐ Di-Bookmark';
    }
    showToast('Ditambahkan ke Bookmark', 'success');
  }
  updateAccountModalView();
}

function toggleBookmarkFromModal(slug, title, thumb) {
  const currentUser = AccountManager.getCurrentUser();
  if (!currentUser) {
    showToast('Harap masuk ke akun terlebih dahulu', 'error');
    openAccountModal();
    return;
  }

  const btn = $('.modal-body .bookmark-btn');
  const isFav = AccountManager.isBookmarked(slug);
  
  if (isFav) {
    AccountManager.removeBookmark(slug);
    if (btn) {
      btn.classList.remove('active');
      btn.querySelector('span').textContent = '⭐ Bookmark';
    }
    showToast('Dihapus dari Bookmark', 'info');
  } else {
    AccountManager.addBookmark({ slug, title, thumb });
    if (btn) {
      btn.classList.add('active');
      btn.querySelector('span').textContent = '⭐ Di-Bookmark';
    }
    showToast('Ditambahkan ke Bookmark', 'success');
  }
  updateAccountModalView();
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Baru saja';
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

function handleCardClick(cardElement) {
  const slug = cardElement?.dataset?.slug;
  if (!slug) return;
  
  if (slug.includes('-episode-') || slug.includes('-eps-')) {
    // Kartu episode terbaru -> Putar langsung!
    playEpisode(slug);
  } else {
    // Kartu detail anime utama -> Buka modal!
    openAnimeDetail(cardElement);
  }
}
