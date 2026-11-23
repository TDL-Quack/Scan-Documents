// Scanner de documents — script injecté dans Gmail
// Affiche un bouton « Numériser » quand la souris passe sur une image.

(() => {
  if (window.__scandocLoaded) return;
  window.__scandocLoaded = true;

  const MIN_SIZE = 60;      // taille affichée minimale (évite avatars et icônes)
  const MIN_NATURAL = 100;  // taille réelle minimale
  const LABEL = '📄 Numériser';

  let btn = null;
  let current = null;
  let scheduled = false;
  let lastX = 0, lastY = 0;

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scandoc-btn';
    btn.textContent = LABEL;
    btn.title = 'Transformer cette photo en document scanné prêt à imprimer';
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    btn.addEventListener('mousedown', stop, true);
    btn.addEventListener('mouseup', stop, true);
    btn.addEventListener('click', (e) => {
      stop(e);
      if (current) sendImage(current.currentSrc || current.src);
    }, true);
    document.documentElement.appendChild(btn);
    return btn;
  }

  function isCandidate(el) {
    if (!el || el.tagName !== 'IMG') return false;
    const src = el.currentSrc || el.src;
    if (!src) return false;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
    if (el.naturalWidth && el.naturalWidth < MIN_NATURAL && el.naturalHeight < MIN_NATURAL) return false;
    return true;
  }

  function findImage(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      if (el === btn) return current;
      if (isCandidate(el)) return el;
    }
    return null;
  }

  function update() {
    scheduled = false;
    const img = findImage(lastX, lastY);
    if (!img) { hide(); return; }
    current = img;
    const b = ensureBtn();
    const r = img.getBoundingClientRect();
    b.classList.add('scandoc-visible');
    b.style.top = Math.max(4, r.top + 6) + 'px';
    b.style.left = Math.max(4, r.right - 6 - b.offsetWidth) + 'px';
  }

  function hide() {
    current = null;
    if (btn) btn.classList.remove('scandoc-visible');
  }

  document.addEventListener('mousemove', (e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, { passive: true, capture: true });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  document.addEventListener('mouseleave', hide);

  // Clic droit > « Numériser ce document » (demandé par le service worker)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'scandoc-fetch' && msg.src) sendImage(msg.src);
  });

  async function sendImage(src) {
    if (btn) btn.textContent = '⏳ Ouverture…';
    let item = null;
    // Le script de la page a les cookies Gmail : on tente de récupérer
    // l'image nous-mêmes (en pleine résolution si possible).
    for (const url of candidateUrls(src)) {
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        const blob = await resp.blob();
        if (blob.size < 500) continue;
        if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') continue;
        item = { dataUrl: await blobToDataUrl(blob) };
        break;
      } catch (e) { /* adresse sur un autre domaine : la page de numérisation essaiera */ }
    }
    if (!item) item = { urls: candidateUrls(src) };
    try {
      await chrome.runtime.sendMessage({ type: 'scandoc-open', item });
      if (btn) btn.textContent = '✓ Ouvert';
    } catch (e) {
      if (btn) btn.textContent = '⚠︎ Rechargez la page';
    }
    setTimeout(() => { if (btn) btn.textContent = LABEL; }, 1500);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function candidateUrls(src) {
    const out = [];
    try {
      if (/^https:\/\/mail\.google\.com\//.test(src) && /[?&]disp=thd\b/.test(src)) {
        out.push(src.replace(/([?&])disp=thd\b/, '$1disp=inline'));
        out.push(src.replace(/([?&])disp=thd\b/, '$1disp=safe'));
      }
      if (/googleusercontent\.com\//.test(src) && /=[swh]\d+[^/?#]*$/.test(src)) {
        out.push(src.replace(/=[swh]\d+[^/?#]*$/, '=s0'));
      }
    } catch (e) { /* ignore */ }
    out.push(src);
    return [...new Set(out)];
  }
})();
