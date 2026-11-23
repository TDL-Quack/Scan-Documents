# Notes pour Claude — Scanner de documents pour Gmail

Extension Chrome (Manifest V3) écrite pour un cabinet médical. Les utilisateurs sont non techniques et francophones : interface et textes en français. Les images sont des données de santé, donc **tout le traitement reste local** : aucun appel réseau vers un tiers, aucune bibliothèque distante.

## Structure
- `extension/manifest.json` : permissions limitées à `contextMenus` + `mail.google.com` / `*.googleusercontent.com`.
- `extension/content.js` (+ `content.css`) : injecté dans Gmail. Affiche le bouton « 📄 Numériser » au survol d'une image (≥ 60 px affichés ; utilise `elementsFromPoint` car Gmail met des calques par-dessus les vignettes). Récupère l'image avec les cookies Gmail, en tentant d'abord la pleine résolution (`disp=thd` → `disp=inline` / `disp=safe` ; `=sNNN` → `=s0` sur googleusercontent), puis l'envoie en data URL au service worker.
- `extension/background.js` : menu clic droit, ouverture ou réutilisation de l'onglet `scan.html` (`chrome.runtime.getContexts`), file d'attente `pending` transmise à la page par messages.
- `extension/scan.html|css|js` : la page de numérisation.
  - `detectQuad` : image réduite à 640 px, score « papier » (clair et peu saturé), seuil d'Otsu, ouverture morphologique, plus grande composante connexe, enveloppe convexe, quadrilatère d'aire maximale, puis `refineQuad` (droites ajustées sur les bords et intersections).
  - `warp` : homographie avec interpolation bilinéaire. Les proportions sont estimées par la méthode de Zhang & He (`estimateAspect`), avec un calage sur le rapport √2 (A4) quand il est proche (bouton « Format A4 »).
  - `enhance` : estimation du fond par une grille de maxima dilatée puis lissée ; division pour normaliser l'éclairage ; filtres `color` / `gray` / `bw` / `none`.
  - Impression : `#print-area`, une `.print-page` A4 par page. Les pages en paysage sont pivotées pour l'impression.
  - Point d'accès pour les tests : `window.__scandoc`.

## Tester (dans le bac à sable)
Google Chrome et Playwright sont installés (`/usr/bin/google-chrome`, `/opt/npm-tools/node_modules/playwright`). Charger l'extension avec `launchPersistentContext` et les options `--headless=new --load-extension=…`. Pour le parcours Gmail : simuler `https://mail.google.com/**` avec `ctx.route` (une fausse page avec une `<img>` de type `...attid=0.1&disp=thd`). Générer des photos de test réalistes avec OpenCV (projection 3D d'une page A4 sur un fond).

## Publier une nouvelle version
1. Modifier les fichiers dans `extension/` et **augmenter `version`** dans `extension/manifest.json`.
2. Faire un commit sur `main`, puis `git push`. Le workflow `.github/workflows/release.yml` crée la release `vX.Y.Z` avec `scanner-docs.zip`. Le lien du README (`releases/latest/download/scanner-docs.zip`) suit automatiquement la dernière version.
3. Ne pas pousser de tags depuis la session : le proxy les refuse (HTTP 403). Le déclenchement sur `main` suffit.

Mettre à jour le README (instructions utilisateur) et `CONFIDENTIALITE.md` si une permission change.
