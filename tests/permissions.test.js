const assert = require('node:assert/strict');
const { normalizePermissions } = require('../permissions');

assert.deepEqual(normalizePermissions('Vendeur', ['Ventes', 'Stock']), ['Ventes']);
assert.deepEqual(normalizePermissions('Vendeur', ['Ventes']), ['Ventes']);
assert.deepEqual(normalizePermissions('Gestionnaire de stock', ['Stock', 'Factures', 'Utilisateurs']), ['Stock', 'Factures']);
assert.deepEqual(normalizePermissions('Personnalisé', ['Stock', 'Utilisateurs']), ['Stock', 'Utilisateurs']);

console.log('permissions tests passed');
