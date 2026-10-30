const PERMISSIONS = ['Ventes', 'Stock', 'Factures', 'Utilisateurs'];

const ROLE_PERMISSIONS = {
  Administratrice: ['Ventes', 'Stock', 'Factures', 'Utilisateurs'],
  Vendeur: ['Ventes'],
  'Gestionnaire de stock': ['Stock', 'Factures'],
  Comptable: ['Factures'],
  Personnalisé: ['Ventes', 'Stock', 'Factures', 'Utilisateurs']
};

function normalizePermissions(role, permissions = []) {
  const allowed = role === 'Personnalisé' ? PERMISSIONS : (ROLE_PERMISSIONS[role] || []);
  return Array.from(new Set((Array.isArray(permissions) ? permissions : []).filter(permission => allowed.includes(permission))));
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  normalizePermissions
};
