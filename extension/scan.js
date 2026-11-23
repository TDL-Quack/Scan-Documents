// Scanner de documents — page de numérisation
// Tout le traitement se fait ici, dans le navigateur : aucune image n'est envoyée ailleurs.
'use strict';

const MAX_SRC = 4000;   // on réduit les photos très grandes (mémoire)
const MAX_OUT = 3000;   // taille max du document redressé (≈ 250 dpi en A4)
const HANDLE_R = 9;     // rayon des poignées (px écran)

const $ = (id) => document.getElementById(id);
const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

const state = { pages: [], current: -1 };
let pageSeq = 0;
let defaultFilter = 'color';
try { defaultFilter = localStorage.getItem('scandoc-filter') || 'color'; } catch (e) { /* ignore */ }

/* =========================================================================
   Chargement des images
   ========================================================================= */

async function addFromBlob(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (e) {
    toast("Ce fichier n'est pas une image lisible.");
    return;
  }
  const scale = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();

  const page = {
    id: ++pageSeq, src: c, srcData: null, quad: null, filter: defaultFilter,
    warped: null, out: null, outUrl: null, thumbUrl: null, a4: 'auto', snapA4: false
  };
  page.quad = detectQuad(c);
  state.pages.push(page);
  renderPageList();
  select(state.pages.length - 1);
}

async function addFromUrls(urls) {
  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size < 500) continue;
      if (blob.type && /text\/html/.test(blob.type)) continue;
      await addFromBlob(blob);
      return true;
    } catch (e) { /* on essaie l'adresse suivante */ }
  }
  toast("Impossible de récupérer l'image depuis Gmail. Téléchargez la pièce jointe puis glissez-la dans cette page.", 7000);
  return false;
}

async function processItem(item) {
  if (!item) return;
  if (item.dataUrl) {
    const blob = await (await fetch(item.dataUrl)).blob();
    await addFromBlob(blob);
  } else if (item.urls) {
    await addFromUrls(item.urls);
  }
}

async function pullPending() {
  if (!hasChrome) return;
  try {
    const items = await chrome.runtime.sendMessage({ type: 'scandoc-getPending' });
    for (const it of items || []) await processItem(it);
  } catch (e) { /* ignore */ }
}

/* =========================================================================
   Détection automatique des bords du document
   ========================================================================= */

function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }

function detectQuad(src) {
  const W0 = src.width, H0 = src.height;
  const s = Math.min(1, 640 / Math.max(W0, H0));
  const w = Math.max(1, Math.round(W0 * s)), h = Math.max(1, Math.round(H0 * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  // « Papier » = clair et peu coloré
  const score = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    score[i] = 0.299 * r + 0.587 * g + 0.114 * b - 0.7 * (mx - mn);
  }
  const bl = boxBlur(score, w, h, 2);

  // Seuil d'Otsu
  const hist = new Float64Array(256);
  const toBin = (v) => Math.max(0, Math.min(255, Math.round((v + 128) * 255 / 383)));
  for (let i = 0; i < n; i++) hist[toBin(bl[i])]++;
  const tBin = otsu(hist, n);
  let bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = toBin(bl[i]) > tBin ? 1 : 0;

  // Ouverture morphologique (casse les petits ponts vers le fond)
  bin = morph(bin, w, h, 2, false);
  bin = morph(bin, w, h, 2, true);

  // Plus grande zone claire connexe
  const { label, area } = largestComponent(bin, w, h);
  if (label < 0 || area < 0.08 * n || area > 0.97 * n) return fullQuad(W0, H0);

  // Points extrêmes de chaque ligne -> enveloppe convexe
  const pts = [];
  const lab = bin.__labels;
  for (let y = 0; y < h; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === label) { if (l < 0) l = x; r = x; }
    if (l >= 0) { pts.push([l, y + 0.5]); pts.push([r + 1, y + 0.5]); }
  }
  let hull = convexHull(pts);
  if (hull.length < 4) return fullQuad(W0, H0);
  hull = simplifyHull(hull, 32);
  let quad = maxAreaQuad(hull);
  if (!quad || polyArea(quad) < 0.08 * n) return fullQuad(W0, H0);

  quad = refineQuad(orderQuad(quad), lab, label, w, h);
  quad = quad.map(([x, y]) => [
    Math.max(0, Math.min(W0, x / s)),
    Math.max(0, Math.min(H0, y / s))
  ]);
  return quad;
}

// Affine les coins : ajuste une droite sur les pixels de bord de chaque côté
// puis prend les intersections (les coins arrondis par le filtrage sont ignorés).
function refineQuad(q, lab, label, w, h) {
  const edgePts = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (lab[i] !== label) continue;
      if (lab[i - 1] !== label || lab[i + 1] !== label || lab[i - w] !== label || lab[i + w] !== label) {
        edgePts.push([x + 0.5, y + 0.5]);
      }
    }
  }
  const lines = [];
  for (let k = 0; k < 4; k++) {
    const A = q[k], B = q[(k + 1) % 4];
    const len = dist(A, B);
    if (len < 10) return q;
    const ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len;
    const tol = Math.max(2.5, len * 0.015);
    let sx = 0, sy = 0, cnt = 0;
    const sel = [];
    for (const p of edgePts) {
      const dx = p[0] - A[0], dy = p[1] - A[1];
      const t = dx * ux + dy * uy;
      if (t < len * 0.12 || t > len * 0.88) continue;
      if (Math.abs(dx * uy - dy * ux) > tol) continue;
      sel.push(p); sx += p[0]; sy += p[1]; cnt++;
    }
    if (cnt < 8) return q;
    const mx = sx / cnt, my = sy / cnt;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of sel) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy); // direction principale
    lines.push({ p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] });
  }
  const out = [];
  for (let k = 0; k < 4; k++) {
    const L1 = lines[(k + 3) % 4], L2 = lines[k];
    const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
    if (Math.abs(den) < 0.05) return q;
    const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
    const P = [L1.p[0] + t * L1.d[0], L1.p[1] + t * L1.d[1]];
    if (dist(P, q[k]) > Math.max(w, h) * 0.08) return q; // incohérent : on garde l'original
    out.push(P);
  }
  return out;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Érosion (dilate=false) ou dilatation (dilate=true) carrée, séparable
function morph(bin, w, h, r, dilate) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const b = bin[y * w + xx];
        if (dilate ? b : !b) { v = dilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const b = tmp[yy * w + x];
        if (dilate ? b : !b) { v = dilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function largestComponent(bin, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = -1, bestArea = 0, next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || labels[i] >= 0) continue;
    const lab = next++;
    let sp = 0, area = 0;
    stack[sp++] = i; labels[i] = lab;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && bin[p - 1] && labels[p - 1] < 0) { labels[p - 1] = lab; stack[sp++] = p - 1; }
      if (x < w - 1 && bin[p + 1] && labels[p + 1] < 0) { labels[p + 1] = lab; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - w] && labels[p - w] < 0) { labels[p - w] = lab; stack[sp++] = p - w; }
      if (y < h - 1 && bin[p + w] && labels[p + w] < 0) { labels[p + w] = lab; stack[sp++] = p + w; }
    }
    if (area > bestArea) { bestArea = area; best = lab; }
  }
  bin.__labels = labels;
  return { label: best, area: bestArea };
}

function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Retire les sommets les moins utiles jusqu'à n'en garder que maxN
function simplifyHull(hull, maxN) {
  const h = hull.slice();
  while (h.length > maxN) {
    let bestI = 0, bestA = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = Math.abs(cross(h[(i - 1 + h.length) % h.length], h[i], h[(i + 1) % h.length]));
      if (a < bestA) { bestA = a; bestI = i; }
    }
    h.splice(bestI, 1);
  }
  return h;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    a += p[0] * r[1] - r[0] * p[1];
  }
  return Math.abs(a) / 2;
}

function maxAreaQuad(h) {
  const n = h.length;
  let best = null, bestA = -1;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      for (let k = j + 1; k < n; k++)
        for (let l = k + 1; l < n; l++) {
          const q = [h[i], h[j], h[k], h[l]];
          const a = polyArea(q);
          if (a > bestA) { bestA = a; best = q; }
        }
  return best;
}

// Ordre : haut-gauche, haut-droit, bas-droit, bas-gauche
function orderQuad(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; s += p[0] * r[1] - r[0] * p[1]; }
  let o = s < 0 ? q.slice().reverse() : q.slice();
  let start = 0, m = Infinity;
  o.forEach((p, i) => { if (p[0] + p[1] < m) { m = p[0] + p[1]; start = i; } });
  return o.slice(start).concat(o.slice(0, start));
}

/* =========================================================================
   Redressement (perspective) et rendu « scan »
   ========================================================================= */

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

// Homographie qui envoie les points dst (rectangle) sur src (quadrilatère)
function homography(dst, src) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  return solve(A, B);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

// Rapport largeur/hauteur réel d'un rectangle photographié en perspective
// (méthode de Zhang & He, « Whiteboard scanning »). Renvoie 0 si incalculable.
function estimateAspect(q, imgW, imgH) {
  const u0 = imgW / 2, v0 = imgH / 2;
  const P = (p) => [p[0] - u0, p[1] - v0, 1];
  const m1 = P(q[0]), m2 = P(q[1]), m3 = P(q[3]), m4 = P(q[2]); // hg, hd, bg, bd
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cr(m1, m4);
  const k2 = dot(c14, m3) / dot(cr(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cr(m3, m4), m2);
  if (!isFinite(k2) || !isFinite(k3)) return 0;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const L = Math.max(imgW, imgH);
  let r;
  const denom = n2[2] * n3[2];
  const f2 = Math.abs(denom) > 1e-9 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / denom : -1;
  if (f2 > (0.4 * L) ** 2 && f2 < (6 * L) ** 2) {
    r = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / f2 + n2[2] ** 2) /
        Math.sqrt((n3[0] ** 2 + n3[1] ** 2) / f2 + n3[2] ** 2);
  } else {
    // focale incohérente (vue presque de face) : approximation affine
    r = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
  }
  return isFinite(r) && r > 0.2 && r < 5 ? r : 0;
}

function getSrcData(page) {
  if (!page.srcData) {
    page.srcData = page.src.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, page.src.width, page.src.height);
  }
  return page.srcData;
}

function warp(page) {
  const q = page.quad;
  const src = getSrcData(page);
  const Wmax = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const Hmax = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  // Proportions réelles du document (corrige l'écrasement dû à la prise de vue de biais)
  let r = estimateAspect(q, src.width, src.height) ||
    (dist(q[0], q[1]) + dist(q[3], q[2])) / (dist(q[0], q[3]) + dist(q[1], q[2]));
  const rr = Math.max(r, 1 / r);
  // Proche d'une feuille A4/A5 (rapport √2) : on cale exactement sur ce format
  page.snapA4 = page.a4 === 'on' || (page.a4 !== 'off' && rr > 1.25 && rr < 1.6);
  if (page.snapA4) r = r >= 1 ? Math.SQRT2 : 1 / Math.SQRT2;
  const L = Math.max(Wmax, Hmax);
  let W, H;
  if (r >= 1) { W = L; H = L / r; } else { H = L; W = L * r; }
  const sc = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * sc)); H = Math.max(1, Math.round(H * sc));
  const [a, b, c, d, e, f, g, hh] = homography([[0, 0], [W, 0], [W, H], [0, H]], q);

  const sw = src.width, sh = src.height, sd = src.data;
  const out = new ImageData(W, H);
  const od = out.data;
  let o = 0;
  for (let v = 0; v < H; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < W; u++) {
      const uu = u + 0.5;
      const den = g * uu + hh * vv + 1;
      let x = (a * uu + b * vv + c) / den - 0.5;
      let y = (d * uu + e * vv + f) / den - 0.5;
      if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
      if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0, y1 = y0 < sh - 1 ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4;
      const p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      od[o] = sd[p00] * w00 + sd[p10] * w10 + sd[p01] * w01 + sd[p11] * w11;
      od[o + 1] = sd[p00 + 1] * w00 + sd[p10 + 1] * w10 + sd[p01 + 1] * w01 + sd[p11 + 1] * w11;
      od[o + 2] = sd[p00 + 2] * w00 + sd[p10 + 2] * w10 + sd[p01 + 2] * w01 + sd[p11 + 2] * w11;
      od[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

// Estimation de l'éclairage du papier (ombres, dégradés) sur une grille grossière
function estimateBackground(gray, w, h) {
  const cs = Math.max(8, Math.round(Math.max(w, h) / 120));
  const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
  let grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      // 2e plus grande valeur « robuste » : max d'un sous-échantillonnage
      let mx = 0;
      const y1 = Math.min(h, (gy + 1) * cs), x1 = Math.min(w, (gx + 1) * cs);
      for (let y = gy * cs; y < y1; y += 2)
        for (let x = gx * cs; x < x1; x += 2) {
          const v = gray[y * w + x];
          if (v > mx) mx = v;
        }
      grid[gy * gw + gx] = mx;
    }
  }
  // dilatation (efface le texte) puis lissage
  const dil = new Float32Array(gw * gh);
  const R = 2;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      let mx = 0;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const yy = Math.min(gh - 1, Math.max(0, gy + dy)), xx = Math.min(gw - 1, Math.max(0, gx + dx));
          const v = grid[yy * gw + xx];
          if (v > mx) mx = v;
        }
      dil[gy * gw + gx] = mx;
    }
  grid = boxBlur(boxBlur(dil, gw, gh, 2), gw, gh, 2);

  // interpolation bilinéaire à pleine résolution
  const bg = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gyf = Math.min(gh - 1, Math.max(0, (y + 0.5) / cs - 0.5));
    const gy0 = gyf | 0, gy1 = Math.min(gh - 1, gy0 + 1), fy = gyf - gy0;
    for (let x = 0; x < w; x++) {
      const gxf = Math.min(gw - 1, Math.max(0, (x + 0.5) / cs - 0.5));
      const gx0 = gxf | 0, gx1 = Math.min(gw - 1, gx0 + 1), fx = gxf - gx0;
      const top = grid[gy0 * gw + gx0] * (1 - fx) + grid[gy0 * gw + gx1] * fx;
      const bot = grid[gy1 * gw + gx0] * (1 - fx) + grid[gy1 * gw + gx1] * fx;
      bg[y * w + x] = Math.max(30, top * (1 - fy) + bot * fy);
    }
  }
  return bg;
}

function enhance(img, filter) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const out = new ImageData(w, h);
  const o = out.data;
  if (filter === 'none') { o.set(d); return out; }

  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  const bg = estimateBackground(gray, w, h);

  // gris normalisé (papier ≈ blanc) + histogramme
  const norm = new Float32Array(n);
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.min(255, gray[i] * 255 / bg[i]);
    norm[i] = v;
    hist[v | 0]++;
  }
  // point noir = 1er centile (limité), point blanc fixe : le papier devient blanc pur
  let acc = 0, bp = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { bp = i; break; } }
  bp = Math.min(bp, 90);
  const wp = 228;
  const k = 255 / Math.max(20, wp - bp);
  const lv = (v) => { const r = (v - bp) * k; return r < 0 ? 0 : r > 255 ? 255 : r; };

  if (filter === 'gray') {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const v = lv(norm[i]);
      o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255;
    }
  } else if (filter === 'bw') {
    const t = Math.max(140, Math.min(215, otsu(hist, n)));
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      let v = (norm[i] - t) * 6 + 128;      // seuil doux : bords lisses
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      o[p] = o[p + 1] = o[p + 2] = v; o[p + 3] = 255;
    }
  } else { // color
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const f = 255 / bg[i];
      let r = lv(Math.min(255, d[p] * f));
      let g = lv(Math.min(255, d[p + 1] * f));
      let b = lv(Math.min(255, d[p + 2] * f));
      // légère accentuation des couleurs (tampons, stylo)
      const m = (r + g + b) / 3;
      r = m + (r - m) * 1.2; g = m + (g - m) * 1.2; b = m + (b - m) * 1.2;
      o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = 255;
    }
  }
  return out;
}

/* =========================================================================
   Rendu d'une page
   ========================================================================= */

let renderToken = 0;

function render(page, { rewarp = true } = {}) {
  const token = ++renderToken;
  $('busy').hidden = false;
  setTimeout(async () => {
    if (rewarp || !page.warped) page.warped = warp(page);
    const res = enhance(page.warped, page.filter);
    const c = page.out || document.createElement('canvas');
    c.width = res.width; c.height = res.height;
    c.getContext('2d').putImageData(res, 0, 0);
    page.out = c;

    // vignette
    const ts = 200 / Math.max(c.width, c.height);
    const t = document.createElement('canvas');
    t.width = Math.round(c.width * ts); t.height = Math.round(c.height * ts);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    page.thumbUrl = t.toDataURL('image/jpeg', 0.8);

    // version imprimable
    // (un document en paysage est pivoté pour remplir la feuille A4 portrait)
    let pc = c;
    if (c.width > c.height * 1.05) {
      pc = document.createElement('canvas');
      pc.width = c.height; pc.height = c.width;
      const pctx = pc.getContext('2d');
      pctx.translate(pc.width, 0); pctx.rotate(Math.PI / 2);
      pctx.drawImage(c, 0, 0);
    }
    const blob = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.92));
    if (page.outUrl) URL.revokeObjectURL(page.outUrl);
    page.outUrl = URL.createObjectURL(blob);

    renderPageList();
    buildPrintArea();
    if (state.pages[state.current] === page) { showOut(); updateFilterChips(); }
    if (token === renderToken) $('busy').hidden = true;
  }, 20);
}

function showOut() {
  const page = state.pages[state.current];
  const oc = $('out-canvas');
  if (!page || !page.out) return;
  oc.width = page.out.width; oc.height = page.out.height;
  oc.getContext('2d').drawImage(page.out, 0, 0);
  fitOut();
}

function fitOut() {
  const oc = $('out-canvas'), st = $('out-stage');
  if (!oc.width) return;
  const s = Math.min((st.clientWidth - 16) / oc.width, (st.clientHeight - 16) / oc.height);
  oc.style.width = Math.max(1, oc.width * s) + 'px';
  oc.style.height = Math.max(1, oc.height * s) + 'px';
}

/* =========================================================================
   Éditeur des coins
   ========================================================================= */

const view = { s: 1, ox: 0, oy: 0 };
let drag = -1;

function drawSrc() {
  const page = state.pages[state.current];
  const cv = $('src-canvas'), st = $('src-stage');
  if (!page) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = st.clientWidth, ch = st.clientHeight;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  const pad = 16;
  view.s = Math.min((cw - 2 * pad) / page.src.width, (ch - 2 * pad) / page.src.height);
  view.ox = (cw - page.src.width * view.s) / 2;
  view.oy = (ch - page.src.height * view.s) / 2;

  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(page.src, view.ox, view.oy, page.src.width * view.s, page.src.height * view.s);

  const pts = page.quad.map(([x, y]) => [view.ox + x * view.s, view.oy + y * view.s]);
  // assombrit l'extérieur du cadre
  ctx.save();
  ctx.beginPath();
  ctx.rect(view.ox, view.oy, page.src.width * view.s, page.src.height * view.s);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(15,23,42,.45)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.lineWidth = 2; ctx.strokeStyle = '#2563eb'; ctx.stroke();
  for (const [x, y] of pts) {
    ctx.beginPath(); ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#2563eb'; ctx.stroke();
  }
}

function canvasPoint(e) {
  const r = $('src-canvas').getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function setupHandles() {
  const cv = $('src-canvas');
  cv.addEventListener('pointerdown', (e) => {
    const page = state.pages[state.current];
    if (!page) return;
    const [mx, my] = canvasPoint(e);
    let best = -1, bd = 28;
    page.quad.forEach(([x, y], i) => {
      const dd = Math.hypot(view.ox + x * view.s - mx, view.oy + y * view.s - my);
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best >= 0) { drag = best; cv.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  cv.addEventListener('pointermove', (e) => {
    const page = state.pages[state.current];
    if (!page) return;
    const [mx, my] = canvasPoint(e);
    if (drag < 0) {
      const near = page.quad.some(([x, y]) => Math.hypot(view.ox + x * view.s - mx, view.oy + y * view.s - my) < 28);
      cv.style.cursor = near ? 'grab' : 'default';
      return;
    }
    cv.style.cursor = 'grabbing';
    const x = Math.max(0, Math.min(page.src.width, (mx - view.ox) / view.s));
    const y = Math.max(0, Math.min(page.src.height, (my - view.oy) / view.s));
    page.quad[drag] = [x, y];
    drawSrc();
  });
  const end = () => {
    if (drag < 0) return;
    drag = -1;
    const page = state.pages[state.current];
    if (page) { page.quad = orderQuad(page.quad); drawSrc(); render(page); }
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
}

/* =========================================================================
   Interface
   ========================================================================= */

function select(i) {
  state.current = i;
  const page = state.pages[i];
  $('editor').classList.toggle('empty', !page);
  renderPageList();
  if (!page) return;
  updateFilterChips();
  requestAnimationFrame(() => {
    drawSrc();
    if (page.out) showOut();
    else { const oc = $('out-canvas'); oc.width = 0; oc.height = 0; }
    if (!page.out) render(page);
  });
}

function updateFilterChips() {
  const page = state.pages[state.current];
  $('btn-a4').classList.toggle('active', !!page && page.snapA4);
  document.querySelectorAll('#filters .chip').forEach((b) => {
    b.classList.toggle('active', !!page && b.dataset.filter === page.filter);
  });
}

function renderPageList() {
  const ol = $('page-list');
  ol.innerHTML = '';
  state.pages.forEach((p, i) => {
    const li = document.createElement('li');
    if (i === state.current) li.classList.add('active');
    const img = document.createElement('img');
    if (p.thumbUrl) img.src = p.thumbUrl;
    img.alt = 'Page ' + (i + 1);
    const num = document.createElement('div');
    num.className = 'num'; num.textContent = 'Page ' + (i + 1);
    const tools = document.createElement('div');
    tools.className = 'tools';
    const mk = (txt, title, fn) => {
      const b = document.createElement('button');
      b.textContent = txt; b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      tools.appendChild(b);
    };
    if (i > 0) mk('↑', 'Monter', () => movePage(i, -1));
    if (i < state.pages.length - 1) mk('↓', 'Descendre', () => movePage(i, 1));
    mk('✕', 'Retirer cette page', () => removePage(i));
    li.append(img, num, tools);
    li.addEventListener('click', () => select(i));
    ol.appendChild(li);
  });
}

function movePage(i, dir) {
  const j = i + dir;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  if (state.current === i) state.current = j; else if (state.current === j) state.current = i;
  renderPageList(); buildPrintArea();
}

function removePage(i) {
  const [p] = state.pages.splice(i, 1);
  if (p && p.outUrl) URL.revokeObjectURL(p.outUrl);
  let cur = state.current;
  if (cur > i || cur >= state.pages.length) cur--;
  cur = state.pages.length ? Math.max(0, cur) : -1;
  select(cur);
  buildPrintArea();
}

function buildPrintArea() {
  const area = $('print-area');
  area.innerHTML = '';
  for (const p of state.pages) {
    if (!p.outUrl) continue;
    const div = document.createElement('div');
    div.className = 'print-page';
    const img = document.createElement('img');
    img.src = p.outUrl;
    div.appendChild(img);
    area.appendChild(div);
  }
}

function rotate(page, dir) {
  const s = page.src;
  const c = document.createElement('canvas');
  c.width = s.height; c.height = s.width;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(dir * Math.PI / 2);
  ctx.drawImage(s, -s.width / 2, -s.height / 2);
  // on fait tourner le cadre avec l'image
  const W = s.width, H = s.height;
  page.quad = orderQuad(page.quad.map(([x, y]) => (dir > 0 ? [H - y, x] : [y, W - x])));
  page.src = c; page.srcData = null;
  drawSrc(); render(page);
}

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function handleFiles(files) {
  for (const f of files) {
    if (f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp|gif|bmp)$/i.test(f.name)) await addFromBlob(f);
    else toast(`« ${f.name} » n'est pas une image.`);
  }
}

function init() {
  setupHandles();

  $('file-input').addEventListener('change', async (e) => {
    await handleFiles([...e.target.files]);
    e.target.value = '';
  });

  document.querySelectorAll('#filters .chip').forEach((b) => {
    b.addEventListener('click', () => {
      const page = state.pages[state.current];
      if (!page) return;
      page.filter = b.dataset.filter;
      defaultFilter = page.filter;
      try { localStorage.setItem('scandoc-filter', defaultFilter); } catch (e) { /* ignore */ }
      updateFilterChips();
      render(page, { rewarp: false });
    });
  });

  $('btn-rot-l').addEventListener('click', () => { const p = state.pages[state.current]; if (p) rotate(p, -1); });
  $('btn-rot-r').addEventListener('click', () => { const p = state.pages[state.current]; if (p) rotate(p, 1); });
  $('btn-auto').addEventListener('click', () => {
    const p = state.pages[state.current]; if (!p) return;
    p.quad = detectQuad(p.src); drawSrc(); render(p);
  });
  $('btn-a4').addEventListener('click', () => {
    const p = state.pages[state.current]; if (!p) return;
    p.a4 = p.snapA4 ? 'off' : 'on'; render(p);
  });
  $('btn-full').addEventListener('click', () => {
    const p = state.pages[state.current]; if (!p) return;
    p.quad = fullQuad(p.src.width, p.src.height); drawSrc(); render(p);
  });

  $('btn-clear').addEventListener('click', () => {
    if (!state.pages.length) return;
    if (!confirm('Retirer toutes les pages ?')) return;
    state.pages.forEach((p) => p.outUrl && URL.revokeObjectURL(p.outUrl));
    state.pages = [];
    select(-1); buildPrintArea();
  });

  $('btn-print').addEventListener('click', async () => {
    if (!state.pages.length) { toast('Ajoutez d\'abord une photo.'); return; }
    await Promise.all([...document.querySelectorAll('#print-area img')].map((i) => i.decode().catch(() => {})));
    window.print();
  });

  // Glisser-déposer (fichier ou image tirée depuis un onglet Gmail)
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) { await handleFiles(files); return; }
    const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
    if (/^(https?:|data:image)/.test(url)) await addFromUrls([url]);
  });

  // Coller (⌘V)
  window.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); await handleFiles(files); }
  });

  window.addEventListener('resize', () => { drawSrc(); fitOut(); });

  if (hasChrome) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'scandoc-pendingAvailable') pullPending();
    });
    pullPending();
  }
}

init();

// Accès pour les tests
window.__scandoc = { state, addFromBlob, detectQuad };
