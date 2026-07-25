#!/usr/bin/env node
/* v7.28 scrape helper test — extracts the REAL pure helpers from server.js and checks the SSRF IP classifier,
   the Bluesky actor parser, and the static-HTML image extractor. (Network endpoints themselves aren't unit-
   tested here; these are the logic pieces that gate them.) */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function grabFn(name){
  const i = src.indexOf('function '+name+'('); if(i<0) throw new Error('fn not found: '+name);
  let j=src.indexOf('{',i), d=0,k=j; for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
  return src.slice(i,k+1);
}
const { ipIsPrivate, parseBlueskyActor, extractImageUrls } =
  new Function(grabFn('ipIsPrivate')+'\n'+grabFn('parseBlueskyActor')+'\n'+grabFn('extractImageUrls')+
    '\nreturn { ipIsPrivate, parseBlueskyActor, extractImageUrls };')();

let n=0, fails=0;
const eq=(a,b,l)=>{ n++; if(JSON.stringify(a)===JSON.stringify(b)) console.log('  ✓ '+l); else { fails++; console.log('  ✗ '+l+'  got '+JSON.stringify(a)+' want '+JSON.stringify(b)); } };

console.log('[1] SSRF: private/reserved IPs blocked, public allowed');
['127.0.0.1','10.1.2.3','192.168.0.5','172.16.9.9','169.254.169.254','100.64.0.1','::1','fe80::1','fd00::1','0.0.0.0']
  .forEach(ip=>eq(ipIsPrivate(ip), true, 'blocks '+ip));
['8.8.8.8','1.1.1.1','93.184.216.34','2606:4700:4700::1111'].forEach(ip=>eq(ipIsPrivate(ip), false, 'allows '+ip));
eq(ipIsPrivate('::ffff:127.0.0.1'), true, 'blocks IPv4-mapped loopback');

console.log('[2] Bluesky actor parsing');
eq(parseBlueskyActor('https://bsky.app/profile/alice.bsky.social'), 'alice.bsky.social', 'bsky.app profile URL');
eq(parseBlueskyActor('@alice.bsky.social'), 'alice.bsky.social', 'bare @handle');
eq(parseBlueskyActor('alice.example.com'), 'alice.example.com', 'custom-domain handle');
eq(parseBlueskyActor('https://example.com/gallery'), null, 'non-bluesky URL → null');
eq(parseBlueskyActor('just some text'), null, 'free text → null');

console.log('[3] image extraction from static HTML');
const html = `<html><head>
  <meta property="og:image" content="https://cdn.site.com/hero.jpg">
  </head><body>
  <img src="/photos/a.jpg"><img src="https://cdn.site.com/b.png">
  <img srcset="/s/small.jpg 300w, /s/big.jpg 1200w">
  <img src="/assets/favicon.png"><img src="/logo.svg"><img src="/sprite-icons.png">
  </body></html>`;
const urls = extractImageUrls(html, 'https://site.com/page', 10);
eq(urls[0], 'https://cdn.site.com/hero.jpg', 'og:image first');
eq(urls.includes('https://site.com/photos/a.jpg'), true, 'relative img resolved');
eq(urls.includes('https://cdn.site.com/b.png'), true, 'absolute img kept');
eq(urls.includes('https://site.com/s/big.jpg'), true, 'srcset largest chosen');
eq(urls.some(u=>/favicon|logo\.svg|sprite/.test(u)), false, 'junk (favicon/svg/sprite) filtered');

/* v7.61 Twitter/X (Xpoz) helpers */
const twSrc = src.slice(src.indexOf('const TW_RESERVED'), src.indexOf('// Up to `cap` absolute image URLs'));
const { parseTwitterHandle, normalizeMediaUrls, isTwitterImageUrl, twimgSized } =
  new Function(twSrc + '\nreturn { parseTwitterHandle, normalizeMediaUrls, isTwitterImageUrl, twimgSized };')();

console.log('[4] Twitter/X handle parsing');
eq(parseTwitterHandle('https://x.com/MaxPriceOF'), 'MaxPriceOF', 'x.com profile URL');
eq(parseTwitterHandle('https://twitter.com/MaxPriceOF'), 'MaxPriceOF', 'twitter.com profile URL');
eq(parseTwitterHandle('https://x.com/MaxPriceOF/status/123?s=20'), 'MaxPriceOF', 'status URL → author handle');
eq(parseTwitterHandle('@MaxPriceOF'), 'MaxPriceOF', 'bare @handle');
eq(parseTwitterHandle('https://x.com/i/lists/99'), null, 'reserved path (i) → null');
eq(parseTwitterHandle('https://x.com/search?q=x'), null, 'reserved path (search) → null');
eq(parseTwitterHandle('https://bsky.app/profile/a.bsky.social'), null, 'bluesky URL → null');
eq(parseTwitterHandle('https://example.com/gallery'), null, 'other site → null');
eq(parseTwitterHandle('name with spaces'), null, 'free text → null');

console.log('[5] media_urls normalization (arrives as a STRING, not string[])');
// The exact shape the MCP wire format + SDK coerce() produce: escaped-quote-comma joined.
const joined = 'https://pbs.twimg.com/media/A.jpg\\",\\"https://video.twimg.com/x/vid.mp4\\",\\"https://pbs.twimg.com/media/B.jpg';
eq(normalizeMediaUrls(joined).length, 3, 'joined string → 3 urls');
eq(normalizeMediaUrls(joined)[0], 'https://pbs.twimg.com/media/A.jpg', 'first url clean (no trailing quote)');
eq(normalizeMediaUrls(joined)[2], 'https://pbs.twimg.com/media/B.jpg', 'last url clean');
eq(normalizeMediaUrls(['https://pbs.twimg.com/media/A.jpg']), ['https://pbs.twimg.com/media/A.jpg'], 'real array passes through');
eq(normalizeMediaUrls('["https://pbs.twimg.com/media/A.jpg"]'), ['https://pbs.twimg.com/media/A.jpg'], 'JSON-ish string handled');
eq(normalizeMediaUrls(null), [], 'null → empty (no throw)');
eq(normalizeMediaUrls(undefined), [], 'undefined → empty');
eq(normalizeMediaUrls(''), [], 'empty string → empty');
eq(normalizeMediaUrls('https://pbs.twimg.com/media/A.jpg'), ['https://pbs.twimg.com/media/A.jpg'], 'single url string');
eq(normalizeMediaUrls([joined]).length, 3, 'array containing a joined string still splits');

console.log('[6] image-vs-video filtering');
eq(isTwitterImageUrl('https://pbs.twimg.com/media/A.jpg'), true, 'photo kept');
eq(isTwitterImageUrl('https://pbs.twimg.com/amplify_video_thumb/1/img/x.jpg'), true, 'video poster frame kept');
eq(isTwitterImageUrl('https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/a.mp4'), false, 'mp4 dropped');
eq(isTwitterImageUrl('https://video.twimg.com/amplify_video/1/pl/a.m3u8'), false, 'm3u8 dropped');
eq(isTwitterImageUrl('https://pbs.twimg.com/profile_images/1/avatar.jpg'), false, 'avatar dropped');

console.log('[7] resolution pinning (bare URL serves a downscaled file)');
eq(twimgSized('https://pbs.twimg.com/media/A.jpg','large'), 'https://pbs.twimg.com/media/A?format=jpg&name=large', 'large variant requested');
eq(twimgSized('https://pbs.twimg.com/media/A.jpg','small'), 'https://pbs.twimg.com/media/A?format=jpg&name=small', 'small variant for thumbs');
// The extension is folded into ?format= and dropped from the path; verified that Twitter serves
// this form (name=large 245KB vs name=small 46KB for the same asset).
eq(twimgSized('https://pbs.twimg.com/media/A.jpg?format=jpg&name=small','large'), 'https://pbs.twimg.com/media/A?format=jpg&name=large', 'existing name= upgraded to large');
eq(twimgSized('https://cdn.other.com/a.jpg','large'), 'https://cdn.other.com/a.jpg', 'non-twimg untouched');

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails?1:0);
