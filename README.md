# Shop Kosomba

Application de vente et de gestion de stock pour la boutique informatique et audiovisuelle de Moungali.

## Démarrer en local

Prérequis : Node.js 22.12 ou plus récent.

```powershell
npm start
```

Ouvrez ensuite <http://127.0.0.1:4173>. Au premier lancement, créez le compte administrateur avec votre nom, votre adresse e-mail et un mot de passe d’au moins 12 caractères.

## Données et comptes

Les produits, ventes, factures, comptes et sessions sont conservés dans SQLite sous `.data/shop-kosomba.sqlite`. Ce dossier est ignoré par Git. Faites-en des sauvegardes régulières; la suppression de ce fichier réinitialise la base.

Les comptes et mots de passe sont gérés depuis **Équipe & permissions**. Les modifications de stock, ventes et utilisateurs sont autorisées côté API selon les permissions du compte. Les sessions expirent après 12 heures.

Dans **Point de vente**, l’administrateur peut créer un produit avec son prix, son stock et une photo JPG, PNG ou WebP (5 Mo maximum). Les photos sont stockées dans `.data/images` et affichées dans la caisse et la liste de stock. L’upload est protégé par la session et réservé à l’administrateur.

Quand un vendeur enregistre un ticket ou une facture, chaque administrateur actif reçoit une notification persistante dans sa cloche. Le compteur se met à jour automatiquement; ouvrir la notification affiche le document de vente et la marque comme lue.

## Déploiement Netlify + Render

Netlify héberge l’interface statique du dossier `dist`; l’API Node, la base SQLite et les photos restent hébergées sur Render. Le fichier `dist/_redirects` transmet `/api/*` et `/images/*` au service Render `shop-kosomba`. Si Render attribue une autre URL au service, remplacez `shop-kosomba.onrender.com` dans ce fichier avant le déploiement Netlify.

Créez d’abord le service Render avec le Blueprint `render.yaml` à la racine du dépôt. Il utilise une instance payante `starter` et un disque persistant de 1 Go. Après avoir créé le site Netlify, définissez dans les variables d’environnement du service Render `APP_ORIGIN` sur l’origine exacte du site, par exemple `https://nom-du-site.netlify.app`, puis redéployez l’API. Cela autorise les opérations d’écriture provenant du site.

Pour Netlify, téléversez le contenu de `dist` (qui doit contenir seulement `index.html` et `_redirects`). Après le déploiement, ouvrez le site et créez le compte administrateur. Configurez des sauvegardes régulières du disque Render avant d’y enregistrer des données commerciales. Le fichier local `important.txt` est ignoré par Git et ne doit jamais être ajouté au dépôt.
