/* ═══════════════════════════════════════════════
   TICKER — Stock Market Tracker PWA
   app.js — all logic, API calls, watchlist state
   ═══════════════════════════════════════════════ */

   'use strict';

   /* ── 1. CONFIG — paste your Alpha Vantage key here ── */
   const API_KEY   = '1UGYQ0OSXL9KDCA1';
   const API_BASE  = 'https://www.alphavantage.co/query';
   const CACHE_TTL = 5 * 60 * 1000;   // 5 min — don't re-fetch if data is fresh
   
   /* ── 2. STATE ── */
   let watchlist   = [];               // array of ticker strings, e.g. ['AAPL','MSFT']
   let priceCache  = {};               // { AAPL: { data, timestamp } }
   let apiCallsToday = 0;
   let searchDebounceTimer = null;
   let currentSearchTicker = '';
   
   /* ── 3. DOM REFS ── */
   const searchInput    = document.getElementById('search-input');
   const searchClear    = document.getElementById('search-clear');
   const searchResults  = document.getElementById('search-results');
   const previewTicker  = document.getElementById('preview-ticker');
   const searchStatus   = document.getElementById('search-status');
   const addBtn         = document.getElementById('add-btn');
   const watchlistGrid  = document.getElementById('watchlist-grid');
   const emptyState     = document.getElementById('empty-state');
   const lastUpdatedEl  = document.getElementById('last-updated');
   const refreshBtn     = document.getElementById('refresh-btn');
   const apiCountEl     = document.getElementById('api-count');
   const watchlistCount = document.getElementById('watchlist-count');
   const marketStatus   = document.getElementById('market-status');
   const toast          = document.getElementById('toast');
   const offlineBanner  = document.getElementById('offline-banner');
   const cardTemplate   = document.getElementById('stock-card-template');
   
   /* ════════════════════════════════════════════════
      4. INIT
      ════════════════════════════════════════════════ */
   function init() {
     loadFromStorage();
     renderWatchlist();
     updateMarketStatus();
     updateCounters();
     bindEvents();
     registerServiceWorker();
   
     /* refresh all prices on load if watchlist not empty */
     if (watchlist.length > 0) refreshAll();
   
     /* online / offline detection */
     window.addEventListener('online',  () => { offlineBanner.hidden = true;  refreshAll(); });
     window.addEventListener('offline', () => { offlineBanner.hidden = false; });
     if (!navigator.onLine) offlineBanner.hidden = false;
   }
   
   /* ════════════════════════════════════════════════
      5. LOCAL STORAGE
      ════════════════════════════════════════════════ */
   function loadFromStorage() {
     try {
       const saved = localStorage.getItem('ticker_watchlist');
       if (saved) watchlist = JSON.parse(saved);
   
       const cache = localStorage.getItem('ticker_price_cache');
       if (cache) priceCache = JSON.parse(cache);
   
       const calls = localStorage.getItem('ticker_api_calls');
       if (calls) {
         const parsed = JSON.parse(calls);
         /* reset daily counter if it's a new day */
         const today = new Date().toDateString();
         apiCallsToday = parsed.date === today ? parsed.count : 0;
       }
     } catch (e) {
       console.warn('Storage read error:', e);
     }
   }
   
   function saveWatchlist() {
     try {
       localStorage.setItem('ticker_watchlist', JSON.stringify(watchlist));
     } catch (e) { console.warn('Storage write error:', e); }
   }
   
   function savePriceCache() {
     try {
       localStorage.setItem('ticker_price_cache', JSON.stringify(priceCache));
     } catch (e) {}
   }
   
   function saveApiCount() {
     try {
       localStorage.setItem('ticker_api_calls', JSON.stringify({
         date:  new Date().toDateString(),
         count: apiCallsToday
       }));
     } catch (e) {}
   }
   
   /* ════════════════════════════════════════════════
      6. ALPHA VANTAGE API
      ════════════════════════════════════════════════ */
   
   /* Fetch the latest quote for one ticker.
      Returns a normalised quote object or null on failure. */
   async function fetchQuote(ticker) {
     /* serve from cache if fresh */
     const cached = priceCache[ticker];
     if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
       return cached.data;
     }
   
     if (apiCallsToday >= 25) {
       showToast('Daily API limit reached (25/25). Try tomorrow.', 'error');
       return null;
     }
   
     const url = `${API_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${API_KEY}`;
   
     try {
       const res  = await fetch(url);
       if (!res.ok) throw new Error(`HTTP ${res.status}`);
       const json = await res.json();
   
       apiCallsToday++;
       saveApiCount();
       updateCounters();
   
       /* Alpha Vantage wraps data in "Global Quote" */
       const q = json['Global Quote'];
       if (!q || !q['05. price']) return null;
   
       const data = {
         ticker:     ticker,
         price:      parseFloat(q['05. price']),
         open:       parseFloat(q['02. open']),
         high:       parseFloat(q['03. high']),
         low:        parseFloat(q['04. low']),
         change:     parseFloat(q['09. change']),
         changePct:  parseFloat(q['10. change percent']),
         volume:     parseInt(q['06. volume'], 10),
         prevClose:  parseFloat(q['08. previous close']),
         fetchedAt:  Date.now()
       };
   
       priceCache[ticker] = { data, timestamp: Date.now() };
       savePriceCache();
       return data;
   
     } catch (err) {
       console.error(`fetchQuote(${ticker}) failed:`, err);
       /* return stale cache if we have it */
       if (cached) return cached.data;
       return null;
     }
   }
   
   /* ════════════════════════════════════════════════
      7. SEARCH
      ════════════════════════════════════════════════ */
   function onSearchInput() {
     const val = searchInput.value.trim().toUpperCase();
     searchClear.hidden = val.length === 0;
   
     if (val.length === 0) {
       hideSearchResults();
       return;
     }
   
     /* debounce — wait 500ms after user stops typing */
     clearTimeout(searchDebounceTimer);
     searchDebounceTimer = setTimeout(() => handleSearch(val), 500);
   }
   
   async function handleSearch(ticker) {
     currentSearchTicker = ticker;
     previewTicker.textContent = ticker;
     searchStatus.textContent = 'Checking ticker…';
     searchResults.hidden = false;
   
     /* basic format check */
     if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
       searchStatus.textContent = 'Invalid ticker format.';
       return;
     }
   
     if (watchlist.includes(ticker)) {
       searchStatus.textContent = `${ticker} is already in your watchlist.`;
       return;
     }
   
     searchStatus.textContent = '';
   }
   
   function hideSearchResults() {
     searchResults.hidden = true;
     searchStatus.textContent = '';
     currentSearchTicker = '';
   }
   
   function clearSearch() {
     searchInput.value = '';
     searchClear.hidden = true;
     hideSearchResults();
     searchInput.focus();
   }
   
   /* ════════════════════════════════════════════════
      8. WATCHLIST MANAGEMENT
      ════════════════════════════════════════════════ */
   async function addTicker(ticker) {
     ticker = ticker.trim().toUpperCase();
     if (!ticker) return;
   
     if (watchlist.includes(ticker)) {
       showToast(`${ticker} is already in your watchlist`, 'error');
       return;
     }
   
     watchlist.push(ticker);
     saveWatchlist();
     clearSearch();
     renderWatchlist();
     updateCounters();
     showToast(`${ticker} added to watchlist`, 'success');
   
     /* fetch price immediately */
     await refreshCard(ticker);
   }
   
   function removeTicker(ticker) {
     watchlist = watchlist.filter(t => t !== ticker);
     saveWatchlist();
   
     /* remove card from DOM */
     const card = watchlistGrid.querySelector(`[data-ticker="${ticker}"]`);
     if (card) {
       card.style.opacity = '0';
       card.style.transform = 'scale(0.95)';
       card.style.transition = 'all 0.2s ease';
       setTimeout(() => card.remove(), 200);
     }
   
     updateCounters();
     showEmptyIfNeeded();
     showToast(`${ticker} removed`, '');
   }
   
   /* ════════════════════════════════════════════════
      9. RENDER
      ════════════════════════════════════════════════ */
   function renderWatchlist() {
     watchlistGrid.innerHTML = '';
   
     if (watchlist.length === 0) {
       emptyState.hidden = false;
       return;
     }
     emptyState.hidden = true;
   
     watchlist.forEach(ticker => {
       const card = buildCard(ticker);
       watchlistGrid.appendChild(card);
   
       /* fill with cached data right away if available */
       const cached = priceCache[ticker];
       if (cached) updateCard(ticker, cached.data);
     });
   }
   
   function buildCard(ticker) {
     const clone = cardTemplate.content.cloneNode(true);
     const card  = clone.querySelector('.stock-card');
   
     card.dataset.ticker = ticker;
     card.querySelector('.card-ticker').textContent = ticker;
     card.querySelector('.card-name').textContent = '';
   
     /* remove button */
     card.querySelector('.remove-btn').addEventListener('click', () => removeTicker(ticker));
   
     /* per-card refresh button */
     card.querySelector('.card-refresh-btn').addEventListener('click', () => refreshCard(ticker));
   
     return card;
   }
   
   function updateCard(ticker, data) {
     const card = watchlistGrid.querySelector(`[data-ticker="${ticker}"]`);
     if (!card || !data) return;
   
     card.classList.remove('loading', 'gain', 'loss');
     if (data.change > 0)  card.classList.add('gain');
     if (data.change < 0)  card.classList.add('loss');
   
     card.querySelector('.card-price').textContent    = formatPrice(data.price);
     card.querySelector('.card-change').textContent   = formatChange(data.change);
     card.querySelector('.card-change-pct').textContent = `(${formatPct(data.changePct)}%)`;
   
     card.querySelector('.card-open').textContent   = formatPrice(data.open);
     card.querySelector('.card-high').textContent   = formatPrice(data.high);
     card.querySelector('.card-low').textContent    = formatPrice(data.low);
     card.querySelector('.card-volume').textContent = formatVolume(data.volume);
   
     const time = data.fetchedAt ? timeAgo(data.fetchedAt) : 'cached';
     card.querySelector('.card-updated').textContent = `Updated ${time}`;
   
     /* simple sparkline using open/low/high/price as 4 data points */
     drawSparkline(card, [data.open, data.low, data.high, data.price]);
   }
   
   /* ════════════════════════════════════════════════
      10. SPARKLINE
      ════════════════════════════════════════════════ */
   function drawSparkline(card, points) {
     const svg  = card.querySelector('.sparkline-svg');
     const line = card.querySelector('.sparkline-line');
     if (!svg || !line || points.length < 2) return;
   
     const W = 200, H = 40, PAD = 4;
     const min = Math.min(...points);
     const max = Math.max(...points);
     const range = max - min || 1;
   
     const coords = points.map((v, i) => {
       const x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
       const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
       return `${x.toFixed(1)},${y.toFixed(1)}`;
     });
   
     line.setAttribute('points', coords.join(' '));
   }
   
   /* ════════════════════════════════════════════════
      11. REFRESH
      ════════════════════════════════════════════════ */
   async function refreshCard(ticker) {
     const card = watchlistGrid.querySelector(`[data-ticker="${ticker}"]`);
     if (card) card.classList.add('loading');
   
     const data = await fetchQuote(ticker);
     if (data) {
       updateCard(ticker, data);
       updateLastUpdated();
     } else if (card) {
       card.classList.remove('loading');
       showToast(`Could not fetch ${ticker}`, 'error');
     }
   }
   
   async function refreshAll() {
     if (watchlist.length === 0) return;
     refreshBtn.classList.add('spinning');
   
     /* fetch one at a time — respect 5 calls/min rate limit */
     for (const ticker of watchlist) {
       await refreshCard(ticker);
       if (watchlist.indexOf(ticker) < watchlist.length - 1) {
         await delay(1200);  /* 1.2s gap between calls */
       }
     }
   
     refreshBtn.classList.remove('spinning');
     updateLastUpdated();
   }
   
   /* ════════════════════════════════════════════════
      12. MARKET STATUS
      ════════════════════════════════════════════════ */
   function updateMarketStatus() {
     const now   = new Date();
     const day   = now.getDay();       /* 0=Sun, 6=Sat */
     const hours = now.getHours();
     const mins  = now.getMinutes();
     const time  = hours * 60 + mins;
   
     /* US market hours: 9:30am–4:00pm ET (Mon–Fri) */
     /* Approximate using local time — good enough for a personal tracker */
     const isWeekday   = day >= 1 && day <= 5;
     const inHours     = time >= 9 * 60 + 30 && time < 16 * 60;
     const isOpen      = isWeekday && inHours;
   
     marketStatus.textContent = isOpen ? 'Open' : 'Closed';
     marketStatus.className   = `market-status ${isOpen ? 'open' : 'closed'}`;
   }
   
   /* ════════════════════════════════════════════════
      13. UI HELPERS
      ════════════════════════════════════════════════ */
   function updateCounters() {
     apiCountEl.textContent     = `${apiCallsToday} / 25`;
     watchlistCount.textContent = `${watchlist.length} stock${watchlist.length !== 1 ? 's' : ''}`;
   }
   
   function updateLastUpdated() {
     const now = new Date();
     lastUpdatedEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
   }
   
   function showEmptyIfNeeded() {
     emptyState.hidden = watchlist.length > 0;
   }
   
   let toastTimer = null;
   function showToast(msg, type = '') {
     toast.textContent  = msg;
     toast.className    = `toast show ${type}`;
     clearTimeout(toastTimer);
     toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2800);
   }
   
   /* ════════════════════════════════════════════════
      14. FORMAT HELPERS
      ════════════════════════════════════════════════ */
   function formatPrice(n) {
     if (n == null || isNaN(n)) return '—';
     return n < 1
       ? '$' + n.toFixed(4)
       : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
   }
   
   function formatChange(n) {
     if (n == null || isNaN(n)) return '—';
     return (n >= 0 ? '+' : '') + n.toFixed(2);
   }
   
   function formatPct(n) {
     if (n == null || isNaN(n)) return '—';
     return (n >= 0 ? '+' : '') + n.toFixed(2);
   }
   
   function formatVolume(n) {
     if (!n || isNaN(n)) return '—';
     if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
     if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
     return n.toString();
   }
   
   function timeAgo(ts) {
     const secs = Math.floor((Date.now() - ts) / 1000);
     if (secs < 60)  return 'just now';
     if (secs < 120) return '1 min ago';
     if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
     return `${Math.floor(secs / 3600)}h ago`;
   }
   
   function delay(ms) {
     return new Promise(resolve => setTimeout(resolve, ms));
   }
   
   /* ════════════════════════════════════════════════
      15. EVENT BINDINGS
      ════════════════════════════════════════════════ */
   function bindEvents() {
     /* search */
     searchInput.addEventListener('input', onSearchInput);
     searchInput.addEventListener('keydown', e => {
       if (e.key === 'Enter' && currentSearchTicker) addTicker(currentSearchTicker);
       if (e.key === 'Escape') clearSearch();
     });
   
     searchClear.addEventListener('click', clearSearch);
   
     /* add button in search results */
     addBtn.addEventListener('click', () => {
       if (currentSearchTicker) addTicker(currentSearchTicker);
     });
   
     /* global refresh */
     refreshBtn.addEventListener('click', refreshAll);
   
     /* close search results when clicking outside */
     document.addEventListener('click', e => {
       if (!e.target.closest('.search-section')) hideSearchResults();
     });
   }
   
   /* ════════════════════════════════════════════════
      16. SERVICE WORKER REGISTRATION
      ════════════════════════════════════════════════ */
   function registerServiceWorker() {
     if ('serviceWorker' in navigator) {
       navigator.serviceWorker.register('service-worker.js')
         .then(() => console.log('Service worker registered'))
         .catch(err => console.warn('SW registration failed:', err));
     }
   }
   
   /* ════════════════════════════════════════════════
      START
      ════════════════════════════════════════════════ */
   document.addEventListener('DOMContentLoaded', init);