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

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails?1:0);
