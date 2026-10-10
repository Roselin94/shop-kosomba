# Shop Kosomba

Application de vente et de gestion de stock pour la boutique informatique et audiovisuelle de Moungali.

## Démarrer en local

Prérequis : Node.js 24 LTS ou plus récent.

```powershell
npm start
```

Ouvrez ensuite <http://127.0.0.1:4173>. Au premier lancement, créez le compte administrateur avec votre nom, votre adresse e-mail et un mot de passe d’au moins 12 caractères.

## Données et comptes

Les produits, ventes, factures, comptes et sessions sont conservés dans SQLite sous `.data/shop-kosomba.sqlite`. Ce dossier est ignoré par Git. Faites-en des sauvegardes régulières; la suppression de ce fichier réinitialise la base.

Les comptes et mots de passe sont gérés depuis **Équipe & permissions**. Les modifications de stock, ventes et utilisateurs sont autorisées côté API selon les permissions du compte. Les sessions expirent après 12 heures.

Dans **Point de vente**, l’administrateur peut créer un produit avec son prix, son stock et une photo JPG, PNG ou WebP (5 Mo maximum). Les photos sont stockées dans `.data/images` et affichées dans la caisse et la liste de stock. L’upload est protégé par la session et réservé à l’administrateur.

Quand un vendeur enregistre un ticket ou une facture, chaque administrateur actif reçoit une notification persistante dans sa cloche. Le compteur se met à jour automatiquement; ouvrir la notification affiche le document de vente et la marque comme lue.

## Déploiement

Le serveur écoute uniquement sur `127.0.0.1` par défaut. Ce projet constitue une base locale fonctionnelle, pas encore un service public hébergé. Pour l’ouvrir depuis Internet ou d’autres appareils, il faut le déployer sur un serveur sécurisé en HTTPS, configurer sauvegardes, supervision et gestion des secrets, et revoir l’exposition réseau de SQLite.
