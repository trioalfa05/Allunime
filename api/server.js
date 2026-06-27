const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const TARGET_URL = 'https://anime-indo.cc';

const client = axios.create({
  baseURL: TARGET_URL,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
  },
  timeout: 15000
});

// Endpoint terbaru (Eksa & Standard style)
app.get(['/terbaru', '/api/terbaru', '/home', '/api/home'], async (req, res) => {
  try {
    const { data } = await client.get('/');
    const $ = cheerio.load(data);
    const updates = [];

    $('.ngiri .menu a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).find('.list-anime p').text().trim();
      const img = $(el).find('.list-anime img').attr('data-original') || $(el).find('.list-anime img').attr('src') || '';
      const episode = $(el).find('.list-anime span.eps').text().trim();
      
      let thumb = img;
      if (thumb && thumb.startsWith('/')) {
        thumb = TARGET_URL + thumb;
      }
      
      const slug = href.replace(/\/$/, '').split('/').pop();

      if (title && slug) {
        updates.push({
          title,
          thumb,
          episode,
          type: 'TV',
          date: 'Terbaru',
          slug
        });
      }
    });

    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint detail (Eksa style)
app.get(['/anime/:slug', '/api/anime/:slug'], async (req, res) => {
  try {
    let slug = req.params.slug;
    
    // Check if it is an episode page slug (doesn't have /anime/ or contains -episode-)
    let isEpisode = slug.includes('-episode-') || !req.originalUrl.includes('/anime/');
    let targetPath = `/anime/${slug}/`;

    if (isEpisode) {
      try {
        const { data: epData } = await client.get(`/${slug}/`);
        const $ep = cheerio.load(epData);
        const mainLink = $ep('a:contains("Semua Episode")').attr('href') || $ep('a[href^="/anime/"]').attr('href') || '';
        if (mainLink) {
          targetPath = mainLink;
        } else {
          const mainSlug = slug.replace(/-episode-\d+/, '');
          targetPath = `/anime/${mainSlug}/`;
        }
      } catch {
        const mainSlug = slug.replace(/-episode-\d+/, '');
        targetPath = `/anime/${mainSlug}/`;
      }
    }

    const { data } = await client.get(targetPath);
    const $ = cheerio.load(data);

    const title = $('.detail h2').first().text().trim() || $('.title').first().text().trim();
    
    const imgEl = $('.detail img');
    let thumb = imgEl.attr('src') || '';
    if (thumb && thumb.startsWith('/')) {
      thumb = TARGET_URL + thumb;
    }

    const synopsis = $('.detail p').text().trim();

    const genres = [];
    $('.detail li a').each((i, el) => {
      genres.push($(el).text().trim());
    });

    const episodes = [];
    $('.ep a').each((i, el) => {
      const epTitle = $(el).text().trim();
      const epHref = $(el).attr('href') || '';
      const epSlug = epHref.replace(/\/$/, '').split('/').pop();
      if (epSlug) {
        episodes.push({
          title: `Episode ${epTitle}`,
          slug: epSlug
        });
      }
    });

    res.json({
      title,
      thumb,
      synopsis,
      genres,
      episode_list: episodes.reverse() // Balik agar episode 1 di bawah
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint streaming (Eksa & Standard style)
app.get(['/stream/:slug', '/api/stream/:slug', '/eps/:slug', '/api/eps/:slug'], async (req, res) => {
  try {
    const { slug } = req.params;
    const { data } = await client.get(`/${slug}/`);
    const $ = cheerio.load(data);

    const iframeSrc = $('#tontonin').attr('src') || '';
    let streamUrl = iframeSrc;
    if (streamUrl && streamUrl.startsWith('/')) {
      streamUrl = TARGET_URL + streamUrl;
    }

    const mirrors = [];
    $('a.server').each((i, el) => {
      let videoUrl = $(el).attr('data-video') || '';
      if (videoUrl && videoUrl.startsWith('/')) {
        videoUrl = TARGET_URL + videoUrl;
      }
      mirrors.push({
        name: $(el).text().trim(),
        url: videoUrl
      });
    });

    res.json({
      stream_url: streamUrl,
      mirrors: mirrors
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint search (Eksa style)
app.get(['/search/:query', '/api/search/:query'], async (req, res) => {
  try {
    const { query } = req.params;
    const { data } = await client.get(`/search.php?q=${encodeURIComponent(query)}`);
    const $ = cheerio.load(data);
    const results = [];

    $('.list-anime').each((i, el) => {
      const a = $(el).closest('a');
      const href = a.attr('href') || $(el).parent('a').attr('href') || '';
      const title = $(el).find('p').text().trim();
      const img = $(el).find('img').attr('data-original') || $(el).find('img').attr('src') || '';
      
      let thumb = img;
      if (thumb && thumb.startsWith('/')) {
        thumb = TARGET_URL + thumb;
      }
      
      const slug = href.replace(/\/$/, '').split('/').pop();

      if (title && slug) {
        results.push({
          title,
          thumb,
          slug
        });
      }
    });

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
