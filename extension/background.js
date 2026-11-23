// Scanner de documents — service worker
// Fait le lien entre Gmail (bouton / clic droit) et la page de numérisation.

const SCAN_URL = chrome.runtime.getURL('scan.html');
const pending = []; // images en attente d'être prises par la page de numérisation

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'scandoc',
    title: 'Numériser ce document',
    contexts: ['image'],
    documentUrlPatterns: ['https://mail.google.com/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'scandoc') return;
  // On demande d'abord au script de la page de récupérer l'image (il a accès
  // aux cookies Gmail). S'il n'est pas là (page ouverte avant l'installation),
  // la page de numérisation essaiera elle-même avec l'adresse de l'image.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'scandoc-fetch', src: info.srcUrl });
  } catch (e) {
    openScan({ urls: candidateUrls(info.srcUrl) });
  }
});

chrome.action.onClicked.addListener(() => openScan(null));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'scandoc-open') {
    openScan(msg.item);
  } else if (msg && msg.type === 'scandoc-getPending') {
    sendResponse(pending.splice(0));
  }
});

async function openScan(item) {
  if (item) pending.push(item);
  let existing = [];
  try {
    existing = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [SCAN_URL] });
  } catch (e) { /* ancienne version de Chrome */ }

  if (existing.length) {
    const ctx = existing[0];
    try {
      await chrome.tabs.update(ctx.tabId, { active: true });
      await chrome.windows.update(ctx.windowId, { focused: true });
    } catch (e) { /* ignore */ }
    chrome.runtime.sendMessage({ type: 'scandoc-pendingAvailable' }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: SCAN_URL });
  }
}

// Variantes d'adresse pour obtenir l'image en pleine résolution
// (les vignettes Gmail sont en basse définition).
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
