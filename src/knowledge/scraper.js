const cheerio = require('cheerio');

/**
 * Crawl a help center URL up to maxDepth levels deep.
 * Returns an array of { url, title, text } objects.
 */
async function scrapeHelpCenter(startUrl, maxDepth = 2) {
  // Dynamic import for ESM module
  const fetch = (await import('node-fetch')).default;

  const visited = new Set();
  const pages = [];
  const baseUrl = new URL(startUrl);

  async function crawl(url, depth) {
    if (depth > maxDepth || visited.has(url)) return;
    visited.add(url);

    try {
      const resp = await fetch(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Guided/1.0 (Help Center Indexer)' },
      });
      if (!resp.ok) return;

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) return;

      const html = await resp.text();
      const $ = cheerio.load(html);

      // Remove non-content elements
      $('nav, footer, header, script, style, noscript, iframe, .sidebar, .nav, .navigation, .menu, .breadcrumb, .cookie-banner').remove();

      const title = $('title').text().trim() || $('h1').first().text().trim() || '';
      const text = $('main, article, .content, .documentation, .doc-content, [role="main"], body')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 100) {
        pages.push({ url, title, text });
      }

      // Find same-domain links for deeper crawling
      if (depth < maxDepth) {
        const links = new Set();
        $('a[href]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          try {
            const resolved = new URL(href, url);
            // Same domain, not an anchor, not a file download
            if (resolved.hostname === baseUrl.hostname &&
                !resolved.hash &&
                !resolved.pathname.match(/\.(pdf|zip|png|jpg|gif|svg|mp4|csv)$/i) &&
                !visited.has(resolved.href)) {
              links.add(resolved.href);
            }
          } catch { /* invalid URL */ }
        });

        // Limit to 50 links per page to avoid runaway crawls
        const linkArray = [...links].slice(0, 50);
        for (const link of linkArray) {
          await crawl(link, depth + 1);
        }
      }
    } catch (err) {
      console.warn(`Scrape error for ${url}: ${err.message}`);
    }
  }

  await crawl(startUrl, 0);
  return pages;
}

module.exports = { scrapeHelpCenter };
