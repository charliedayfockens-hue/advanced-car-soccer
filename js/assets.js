// Asset downloads that behave the same locally and on static hosts (GitHub, Cloudflare Pages).
// Every file is checked, and anything wrong is shown on screen with the reason instead of the game
// silently falling back to the built-in car/ball or the Rookie bot:
//  - HTTP errors (404: the file isn't in the deployed site)
//  - a web page returned instead of the file (Cloudflare Pages answers missing files with index.html)
//  - Git LFS pointer files (the repo holds a small text pointer; Pages builds don't fetch LFS content)
//  - files that aren't what they should be (e.g. an FBX that isn't an FBX)
// Network errors are retried.
window.Game = window.Game || {};

Game.Assets = (function () {
  const VERSION = '80'; // keep in step with index.html so hosts and CDNs don't serve stale copies
  const reported = new Map();

  class AssetError extends Error {
    constructor(url, reason) { super(url + ': ' + reason); this.url = url; this.reason = reason; }
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const withVersion = url => url + (url.includes('?') ? '&' : '?') + 'v=' + VERSION;

  async function fetchChecked(url, opts) {
    opts = opts || {};
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(withVersion(url), { cache: attempt ? 'reload' : 'default' });
        if (!res.ok) {
          throw new AssetError(url, 'HTTP ' + res.status + (res.status === 404 ? ' - the file is not in the deployed site' : ''));
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
        const type = res.headers.get('content-type') || '';
        if (head.startsWith('version https://git-lfs')) {
          throw new AssetError(url, 'is a Git LFS pointer, not the real file - commit it without Git LFS');
        }
        if (/^<(!doctype|html|head|body)/i.test(head) || type.includes('text/html')) {
          throw new AssetError(url, 'the host sent a web page instead of the file - it is missing from the deployed site');
        }
        if (opts.check && !opts.check(bytes, head)) {
          throw new AssetError(url, 'is not a valid ' + (opts.kind || '') + ' file (' + bytes.length + ' bytes) - it was damaged on upload');
        }
        return buf;
      } catch (e) {
        if (e instanceof AssetError) throw e;
        lastError = new AssetError(url, 'download failed (' + e.message + ')');
        await wait(500 * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function json(url) {
    const buf = await fetchChecked(url, { kind: 'JSON', check: (b, head) => head.startsWith('{') || head.startsWith('[') });
    try { return JSON.parse(new TextDecoder().decode(buf)); }
    catch (e) { throw new AssetError(url, 'is not valid JSON - it was damaged on upload'); }
  }

  const isPng = b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isJpeg = b => b[0] === 0xff && b[1] === 0xd8;

  // Returns a texture right away and fills in the image once it has downloaded and checked out
  function texture(url) {
    const tex = new THREE.Texture();
    fetchChecked(url, { kind: 'image', check: b => isPng(b) || isJpeg(b) })
      .then(buf => new Promise((resolve, reject) => {
        const img = new Image();
        const src = URL.createObjectURL(new Blob([buf], { type: isPng(new Uint8Array(buf, 0, 4)) ? 'image/png' : 'image/jpeg' }));
        img.onload = () => { URL.revokeObjectURL(src); tex.image = img; tex.needsUpdate = true; resolve(); };
        img.onerror = () => { URL.revokeObjectURL(src); reject(new AssetError(url, 'could not be decoded as an image')); };
        img.src = src;
      }))
      .catch(err => report(err, url));
    return tex;
  }

  const isFbx = (b, head) => head.startsWith('Kaydara FBX Binary') || head.includes('FBX');

  // On-screen list of files that failed, with reasons
  function report(err, url) {
    const key = (err && err.url) || url || String(err);
    const reason = err instanceof AssetError ? err.reason : (err && err.message) || String(err);
    console.error('[assets]', key, '-', reason);
    reported.set(key, reason);
    render();
  }

  function render() {
    let panel = document.getElementById('asset-problems');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'asset-problems';
      document.body.appendChild(panel);
    }
    panel.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'ap-title';
    title.textContent = "Some game files didn't load";
    const close = document.createElement('button');
    close.className = 'ap-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => panel.remove();
    title.appendChild(close);
    panel.appendChild(title);
    reported.forEach((reason, file) => {
      const row = document.createElement('div');
      row.className = 'ap-row';
      const f = document.createElement('b');
      f.textContent = file;
      row.append(f, document.createTextNode(' — ' + reason));
      panel.appendChild(row);
    });
    const hint = document.createElement('div');
    hint.className = 'ap-hint';
    hint.textContent = 'Make sure the whole assets folder is pushed to GitHub as normal files (not Git LFS) and redeploy.';
    panel.appendChild(hint);
  }

  const isObj = (b, head) => /^(#|v |vn |vt |o |g |mtllib|usemtl)/m.test(head);
  const isMp3 = b => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

  return { VERSION, AssetError, fetchChecked, json, texture, isFbx, isObj, isMp3, report, get problems() { return new Map(reported); } };
})();
