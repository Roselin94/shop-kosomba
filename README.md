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

Le tableau de bord affiche le montant net en caisse pour aujourd’hui, la semaine en cours ou le mois en cours. Il est calculé à partir des ventes réglées en espèces, moins les remboursements et les dépenses payés en espèces; les paiements Momo, virements, chèques et avoirs client sont exclus. Le solde initial de caisse n’étant pas enregistré, ce montant représente les mouvements nets de la période, pas le fonds de caisse de départ.

## Déploiement Vercel + Render

Vercel héberge l’interface statique et Render l’API Node, les données et les photos. À la racine du dépôt, Vercel détecte `vercel.json`, exécute `npm run build` et publie le dossier `dist`. Le script `build.js` copie les fichiers actuels de l’application et ses ressources nécessaires dans ce dossier.

Dans Vercel, importez le dépôt GitHub et conservez les réglages détectés par `vercel.json` : commande de build `npm run build`, dossier de sortie `dist`, sans framework. Les chemins `/api/*` et `/images/*` sont transmis au service Render `shop-kosomba.onrender.com`; les autres chemins servent l’application. Si l’URL Render change, modifiez les deux destinations dans `vercel.json`.

L’interface n’utilise pas de variables d’environnement Vercel : elle communique avec l’API par des chemins relatifs. Après avoir lié le domaine de production Vercel (par exemple `https://shop-kosomba.vercel.app`), ajoutez dans les variables du service Render `APP_ORIGIN` avec **l’origine exacte** du domaine, sans barre oblique finale, puis redéployez Render. Cette valeur autorise les écritures depuis ce domaine; les domaines d’aperçu Vercel ne seront pas autorisés tant qu’ils ne sont pas explicitement configurés.

**Stockage persistant requis :** le service Render doit disposer d’un disque persistant monté sur le chemin indiqué par `SHOP_DATA_DIR` (actuellement `/opt/render/project/src/.data`). Sans disque persistant, SQLite et les photos peuvent être perdus lors d’un redéploiement ou remplacement d’instance. Les disques persistants Render nécessitent un forfait compatible; vérifiez le coût et configurez des sauvegardes avant d’y enregistrer des données commerciales. Ne mettez ni mot de passe ni autre secret dans le code ou dans le build frontend.

## Déploiement Netlify + Render

Netlify héberge l’interface statique du dossier `dist`; l’API Node, la base SQLite et les photos restent hébergées sur Render. Le fichier `dist/_redirects` transmet `/api/*` et `/images/*` au service Render `shop-kosomba`. Si Render attribue une autre URL au service, remplacez `shop-kosomba.onrender.com` dans ce fichier avant le déploiement Netlify.

Créez d’abord le service Render avec le Blueprint `render.yaml` à la racine du dépôt. Il utilise une instance payante `starter` et un disque persistant de 1 Go. Après avoir créé le site Netlify, définissez dans les variables d’environnement du service Render `APP_ORIGIN` sur l’origine exacte du site, par exemple `https://nom-du-site.netlify.app`, puis redéployez l’API. Cela autorise les opérations d’écriture provenant du site.

Pour Netlify, téléversez le contenu de `dist` (qui doit contenir seulement `index.html` et `_redirects`). Après le déploiement, ouvrez le site et créez le compte administrateur. Configurez des sauvegardes régulières du disque Render avant d’y enregistrer des données commerciales. Le fichier local `important.txt` est ignoré par Git et ne doit jamais être ajouté au dépôt.
