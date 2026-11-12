'use strict';
/** Distància en metres entre dues coordenades (fórmula de Haversine). */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Avalua el geofence d'un fitxatge. Retorna distance i within; within=null si no es pot avaluar.
 * Es té en compte la precisió del GPS: si el cercle d'incertesa toca el radi, es considera dins.
 */
function evaluate(site, lat, lng, accuracy = 0) {
  if (lat == null || lng == null || site.lat == null || site.lng == null) return { distance: null, within: null };
  const distance = distanceMeters(lat, lng, site.lat, site.lng);
  const slack = Math.min(Number(accuracy) || 0, 100); // limitem la tolerància per precisió
  return { distance: Math.round(distance), within: distance - slack <= site.radius_m };
}

module.exports = { distanceMeters, evaluate };
