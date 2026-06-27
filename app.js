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
    'https://otakudesuapieksa.vercel.app/api',
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
const MOCK_ANIME = [
  {
    title: "Hokuto no Ken: Fist of the North Star Episode 14 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/e84393?text=Hokuto+no+Ken",
    episode: "14", type: "TV", date: "11 jam lalu", slug: "hokuto-no-ken",
    genres: ["Action", "Drama", "Martial Arts"], year: "2026"
  },
  {
    title: "Kami no Shizuku Episode 12 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/6c5ce7?text=Kami+no+Shizuku",
    episode: "12", type: "TV", date: "12 jam lalu", slug: "kami-no-shizuku",
    genres: ["Drama", "Slice of Life"], year: "2026"
  },
  {
    title: "Snowball Earth Episode 13 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/00cec9?text=Snowball+Earth",
    episode: "13", type: "TV", date: "12 jam lalu", slug: "snowball-earth",
    genres: ["Sci-Fi", "Adventure"], year: "2026"
  },
  {
    title: "Kamiire Botan Episode 12 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/fdcb6e?text=Kamiire+Botan",
    episode: "12", type: "TV", date: "12 jam lalu", slug: "kamiire-botan",
    genres: ["Romance", "Comedy"], year: "2026"
  },
  {
    title: "Tensei shitara Slime Datta Ken 4th Season Episode 12 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/e84393?text=Tensura+S4",
    episode: "12", type: "TV", date: "12 jam lalu", slug: "tensura-s4",
    genres: ["Action", "Comedy", "Fantasy", "Isekai"], year: "2026"
  },
  {
    title: "Garusu Bando-chan Episode 38 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/a29bfe?text=Garusu+Bando",
    episode: "38", type: "ONA", date: "23 jam lalu", slug: "garusu-bando",
    genres: ["Music", "Comedy"], year: "2025"
  },
  {
    title: "Rakudai Kenja no Gakuin Musou Episode 14 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/00b894?text=Rakudai+Kenja",
    episode: "14", type: "TV", date: "1 hari lalu", slug: "rakudai-kenja",
    genres: ["Action", "Fantasy"], year: "2026"
  },
  {
    title: "Heroine? Saijo Iii, All Works Maid desu Episode 1 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/fd79a8?text=Heroine+Maid",
    episode: "1", type: "TV", date: "1 hari lalu", slug: "heroine-maid",
    genres: ["Comedy", "Romance"], year: "2026"
  },
  {
    title: "Awajima Hyakkei Episode 12 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/74b9ff?text=Awajima",
    episode: "12", type: "TV", date: "1 hari lalu", slug: "awajima-hyakkei",
    genres: ["Adventure", "Fantasy"], year: "2026"
  },
  {
    title: "One Piece Episode 1120 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/e84393?text=One+Piece",
    episode: "1120", type: "TV", date: "2 hari lalu", slug: "one-piece",
    genres: ["Action", "Adventure", "Comedy", "Drama"], year: "1999"
  },
  {
    title: "Detective Conan Episode 1150 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/6c5ce7?text=Detective+Conan",
    episode: "1150", type: "TV", date: "3 hari lalu", slug: "detective-conan",
    genres: ["Adventure", "Comedy", "Detective", "Mystery"], year: "1996"
  },
  {
    title: "Naruto: Shippuuden Episode 500 Subtitle Indonesia",
    thumb: "https://placehold.co/300x400/1a1a24/fdcb6e?text=Naruto+Ship",
    episode: "500", type: "TV", date: "4 hari lalu", slug: "naruto-shippuuden",
    genres: ["Action", "Adventure", "Comedy", "Martial Arts"], year: "2007"
  }
];

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
    
    // Coba standard endpoint /home
    try {
      const targetUrl = proxy ? proxy + encodeURIComponent(cleanUrl + '/home') : cleanUrl + '/home';
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return { ok: true, type: 'standard' };
    } catch {}

    // Coba Eksa endpoint /terbaru
    try {
      const targetUrl = proxy ? proxy + encodeURIComponent(cleanUrl + '/terbaru') : cleanUrl + '/terbaru';
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(4000) });
      if (res.ok) return { ok: true, type: 'eksa' };
    } catch {}

    return { ok: false };
  }

  async checkEndpointWithProxyFallback(url) {
    // 1. Coba langsung
    let check = await this.checkEndpoint(url);
    if (check.ok) return { ok: true, type: check.type, proxy: '' };

    // 2. Coba via CORS proxy 1
    check = await this.checkEndpoint(url, CONFIG.CORS_PROXIES[0]);
    if (check.ok) return { ok: true, type: check.type, proxy: CONFIG.CORS_PROXIES[0] };

    // 3. Coba via CORS proxy 2
    check = await this.checkEndpoint(url, CONFIG.CORS_PROXIES[1]);
    if (check.ok) return { ok: true, type: check.type, proxy: CONFIG.CORS_PROXIES[1] };

    return { ok: false };
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

    const url = this._proxyPrefix
      ? this._proxyPrefix + encodeURIComponent(this.baseUrl + endpoint)
      : this.baseUrl + endpoint;

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
    <div class="anime-card" data-slug="${anime.slug || ''}" data-index="${index}" onclick="openAnimeDetail(this)">
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

  modalBody.innerHTML = `
    <h2 class="modal-title">${title}</h2>
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
            return `<button class="episode-btn" onclick="playEpisode('${epSlug}')" title="${epTitle}">${epTitle.replace(/.*Episode\s*/i, 'Ep ')}</button>`;
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

async function playEpisode(slug) {
  if (!slug) {
    showToast('Deploy API untuk menonton episode ini', 'error');
    return;
  }

  try {
    const data = await api.getEpisode(slug);
    const epData = data?.data || data;
    const streamUrl = epData?.stream_url || epData?.streaming_url || '';
    if (streamUrl) {
      window.open(streamUrl, '_blank');
      showToast('Membuka streaming...', 'success');
    } else {
      showToast('URL streaming tidak ditemukan', 'error');
    }
  } catch (err) {
    showToast('Gagal memuat episode: ' + err.message, 'error');
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

  sidebar.innerHTML = `
    <div class="now-playing">
      <div class="now-playing-icon">▶</div>
      <div class="now-playing-info">
        <div class="now-playing-title">Selamat Datang di Allunime!</div>
        <div class="now-playing-source">Nonton anime subtitle Indonesia</div>
      </div>
    </div>

    <div class="discord-widget">
      <h3>Join Discord Allunime</h3>
      <a href="#" class="discord-banner" onclick="showToast('Discord coming soon! 🎮')">
        <svg viewBox="0 0 292 80" xmlns="http://www.w3.org/2000/svg">
          <g>
            <path d="M61.7958 16.494C57.0736 14.2846 52.0244 12.6789 46.7456 11.7646C46.0973 12.9367 45.3399 14.5132 44.8177 15.7673C39.2062 14.9234 33.6463 14.9234 28.138 15.7673C27.6159 14.5132 26.8413 12.9367 26.1872 11.7646C20.9027 12.6789 15.8477 14.2903 11.1255 16.5054C1.60078 30.6037 -0.981215 44.3444 0.309785 57.8928C6.62708 62.4891 12.7493 65.3222 18.7682 67.2294C20.2543 65.2102 21.5797 63.0681 22.7237 60.8132C20.5543 59.9991 18.4757 58.9997 16.5088 57.8415C17.0309 57.4529 17.5415 57.0472 18.0349 56.63C29.9 62.1325 42.8958 62.1325 54.6084 56.63C55.1076 57.0472 55.6182 57.4529 56.1346 57.8415C54.1619 58.9997 52.0776 59.9991 49.9081 60.8189C51.0521 63.0681 52.3718 65.2159 53.8636 67.2351C59.8882 65.3279 66.0162 62.4948 72.3335 57.8928C73.8425 42.1351 69.7968 28.5204 61.7958 16.494ZM24.3568 49.3911C20.7644 49.3911 17.8082 46.0882 17.8082 42.0647C17.8082 38.0412 20.7015 34.7326 24.3568 34.7326C28.0121 34.7326 30.9683 38.0355 30.9055 42.0647C30.9112 46.0882 28.0121 49.3911 24.3568 49.3911ZM48.2862 49.3911C44.6938 49.3911 41.7376 46.0882 41.7376 42.0647C41.7376 38.0412 44.6309 34.7326 48.2862 34.7326C51.9415 34.7326 54.8977 38.0355 54.8349 42.0647C54.8349 46.0882 51.9415 49.3911 48.2862 49.3911Z"/>
            <path d="M98.0293 26.1285H113.693C117.394 26.1285 120.477 26.6658 122.943 27.7404C125.409 28.815 127.257 30.3412 128.487 32.3192C129.717 34.2972 130.332 36.6352 130.332 39.3332C130.332 42.0075 129.717 44.3455 128.487 46.3472C127.257 48.3253 125.409 49.8634 122.943 50.9617C120.477 52.036 117.394 52.5733 113.693 52.5733H98.0293V26.1285ZM113.091 46.8608C115.581 46.8608 117.519 46.2098 118.903 44.9078C120.288 43.6058 120.981 41.7415 120.981 39.3148C120.981 36.9115 120.288 35.0592 118.903 33.7572C117.519 32.4552 115.581 31.8042 113.091 31.8042H107.018V46.8608H113.091Z"/>
            <path d="M139.427 52.5765V26.1317H149.097V52.5765H139.427Z"/>
            <path d="M178.86 40.7005C178.86 40.9992 178.837 41.4588 178.79 42.0795H160.394C160.697 43.5332 161.401 44.6435 162.506 45.4102C163.612 46.1768 164.975 46.5602 166.597 46.5602C168.575 46.5602 170.319 45.9328 171.828 44.6782L176.704 48.9872C174.214 51.7088 170.697 53.0695 166.152 53.0695C163.215 53.0695 160.616 52.5085 158.357 51.3865C156.097 50.2408 154.348 48.6572 153.107 46.6355C151.866 44.6138 151.246 42.3115 151.246 39.7285C151.246 37.1692 151.854 34.8788 153.072 32.8572C154.313 30.8118 155.983 29.2282 158.08 28.1062C160.2 26.9605 162.565 26.3878 165.175 26.3878C167.689 26.3878 169.96 26.9252 171.987 27.9998C174.015 29.0745 175.605 30.6362 176.757 32.6815C177.935 34.7032 178.524 37.0528 178.524 39.7285L178.86 40.7005ZM165.302 32.3495C163.891 32.3495 162.681 32.7448 161.67 33.5352C160.659 34.3255 160.026 35.4122 159.77 36.7952H170.599C170.344 35.4358 169.722 34.3612 168.735 33.5708C167.747 32.7568 166.597 32.3495 165.302 32.3495Z"/>
            <path d="M204.38 40.3805V52.5765H195.37V49.5158C193.767 51.5612 191.313 52.5838 188.007 52.5838C186.007 52.5838 184.241 52.2242 182.71 51.5048C181.202 50.7618 180.02 49.7535 179.165 48.4802C178.31 47.2068 177.882 45.7768 177.882 44.1932C177.882 41.5628 178.855 39.5412 180.802 38.1285C182.749 36.7158 185.729 36.0095 189.74 36.0095H194.822C194.822 33.4975 193.36 32.2415 190.435 32.2415C188.363 32.2415 186.04 32.8855 183.467 34.1738L180.802 28.6908C184.503 26.7128 188.467 25.7232 192.694 25.7232C196.757 25.7232 199.843 26.6178 201.952 28.4072C204.062 30.1965 205.104 32.9538 205.08 36.6792L204.38 40.3805ZM196.112 44.6415C196.888 43.8985 197.388 42.9565 197.388 41.8155V40.5418H193.28C190.378 40.5418 188.927 41.3915 188.927 43.0912C188.927 43.8342 189.226 44.4498 189.823 44.9398C190.42 45.4298 191.185 45.6748 192.117 45.6748C193.517 45.6748 194.935 45.3785 196.112 44.6415Z"/>
            <path d="M219.97 52.5765V18.7012H229.61V52.5765H219.97Z"/>
            <path d="M282.584 39.6052V52.5765H273.04V40.0322C273.04 38.0105 272.68 36.5212 271.962 35.5628C271.243 34.6045 270.176 34.1252 268.762 34.1252C267.208 34.1252 265.956 34.6875 265.008 35.8095C264.06 36.9315 263.583 38.5385 263.583 40.6312V52.5765H253.914V40.0322C253.914 36.7608 252.593 35.1252 249.951 35.1252C248.42 35.1252 247.18 35.6872 246.233 36.8092C245.285 37.9312 244.808 39.5385 244.808 41.6312V52.5765H235.139V26.6305H244.302V29.6912C245.391 28.5218 246.678 27.6272 248.163 27.0072C249.672 26.3638 251.314 26.0422 253.09 26.0422C255.077 26.0422 256.821 26.4725 258.325 27.3335C259.828 28.1945 261.014 29.4208 261.88 31.0122C263.131 29.4445 264.618 28.2302 266.34 27.3692C268.062 26.4845 269.934 26.0422 271.958 26.0422C275.425 26.0422 278.112 27.1168 280.018 29.2662C281.924 31.3918 282.878 34.4525 282.878 38.4485L282.584 39.6052Z"/>
          </g>
        </svg>
      </a>
    </div>

    <div class="popular-widget">
      <h3>Lagi Rame</h3>
      <div class="popular-list">
        ${MOCK_POPULAR.map(item => renderPopularItem(item)).join('')}
      </div>
    </div>
  `;
}

// ============================
// Initialization
// ============================
function initApp() {
  renderSidebar();
  loadHomeData();

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

  // ESC to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // Set API URL yang sudah tersimpan
  const apiInput = $('#api-url-input');
  if (apiInput && api.baseUrl) {
    apiInput.value = api.baseUrl;
  }
}

document.addEventListener('DOMContentLoaded', initApp);
