# Politique de confidentialité — Scanner de documents pour Gmail

*Dernière mise à jour : 23 novembre 2026*

L'extension **Scanner de documents pour Gmail** ne collecte, ne stocke et ne transmet **aucune donnée personnelle**.

## Ce que fait l'extension

- Quand l'utilisateur clique sur « Numériser » sur une image dans Gmail, l'extension récupère cette image depuis Gmail, avec la session déjà ouverte dans le navigateur.
- L'image est traitée **localement, dans le navigateur** : détection du document, redressement, amélioration du contraste.
- Le résultat est affiché à l'utilisateur, qui peut l'imprimer ou l'enregistrer en PDF sur son ordinateur.

## Ce que l'extension ne fait pas

- Aucune image ni aucun résultat n'est envoyé à un serveur, quel qu'il soit.
- Aucun contenu de mail n'est lu, en dehors de l'image choisie par l'utilisateur.
- Pas de statistiques, de traceurs ni de publicité.
- Rien n'est conservé une fois l'onglet du scanner fermé. Seule la préférence de rendu (couleur, gris, noir et blanc) est mémorisée dans le navigateur.

## Permissions demandées

| Permission | Pourquoi |
|---|---|
| `mail.google.com`, `*.googleusercontent.com` | Afficher le bouton « Numériser » dans Gmail et récupérer l'image choisie (Gmail stocke les pièces jointes sur ces domaines). |
| `contextMenus` | Ajouter « Numériser ce document » au clic droit sur une image. |

## Contact

Pour toute question : ouvrir une *issue* sur https://github.com/TDL-Quack/Scan-Documents
