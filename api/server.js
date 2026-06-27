const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const TARGET_URL = 'https://154.26.137.28';

// Bypass SSL raw IP
const agent = new (require('https').Agent)({  
  rejectUnauthorized: false
});

const client = axios.create({
  baseURL: TARGET_URL,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  },
  httpsAgent: agent,
  timeout: 10000
});

// Endpoint terbaru (Eksa style)
app.get('/terbaru', async (req, res) => {
  try {
    const { data } = await client.get('/');
    const $ = cheerio.load(data);
    const updates = [];

    // Parse AnimeSail homepage items
    $('.listupd .utao, .listupd .block').each((i, el) => {
      const a = $(el).find('a');
      const title = $(el).find('h3, .title, .entry-title').text().trim();
      const img = $(el).find('img');
      const thumb = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src') || '';
      const episode = $(el).find('.epx, .epsub .ep').text().trim();
      const type = $(el).find('.typez, .epsub .type').text().trim() || 'TV';
      const link = a.attr('href') || '';
      
      let slug = '';
      if (link) {
        const parts = link.replace(/\/$/, '').split('/');
        slug = parts[parts.length - 1];
      }

      updates.push({
        title,
        thumb,
        episode,
        type,
        date: 'Terbaru',
        slug
      });
    });

    res.json(updates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint detail (Eksa style)
app.get('/anime/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { data } = await client.get(`/anime/${slug}`);
    const $ = cheerio.load(data);

    const title = $('.entry-title').text().trim();
    const thumb = $('.thumb img, .info-left img').attr('src') || '';
    const synopsis = $('.entry-content p, .sinopsis p').text().trim();
    
    const genres = [];
    $('.genres a, .genres-content a').each((i, el) => {
      genres.push($(el).text().trim());
    });

    const episodes = [];
    $('.eplister ul li, .listeps ul li').each((i, el) => {
      const a = $(el).find('a');
      const epTitle = a.text().trim();
      const epLink = a.attr('href') || '';
      let epSlug = '';
      if (epLink) {
        const parts = epLink.replace(/\/$/, '').split('/');
        epSlug = parts[parts.length - 1];
      }
      episodes.push({ title: epTitle, slug: epSlug });
    });

    res.json({
      title,
      thumb,
      synopsis,
      genres,
      episode_list: episodes
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint streaming (Eksa style)
app.get('/stream/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { data } = await client.get(`/${slug}`);
    const $ = cheerio.load(data);

    // Cari url embed iframe
    const iframe = $('.play-embed iframe, .embed-holder iframe, #player iframe, iframe');
    const streamUrl = iframe.attr('src') || '';

    res.json({
      stream_url: streamUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint search (Eksa style)
app.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const { data } = await client.get(`/?s=${encodeURIComponent(query)}`);
    const $ = cheerio.load(data);
    const results = [];

    $('.listupd .utao, .listupd .block').each((i, el) => {
      const a = $(el).find('a');
      const title = $(el).find('h3, .title, .entry-title').text().trim();
      const img = $(el).find('img');
      const thumb = img.attr('data-lazy-src') || img.attr('data-src') || img.attr('src') || '';
      const link = a.attr('href') || '';
      
      let slug = '';
      if (link) {
        const parts = link.replace(/\/$/, '').split('/');
        slug = parts[parts.length - 1];
      }

      results.push({
        title,
        thumb,
        slug
      });
    });

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;
