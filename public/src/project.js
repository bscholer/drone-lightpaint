export function newProject() {
  return {
    version: 1,
    name: 'Light painting',
    home: null, // { lat, lon, h0 (ellipsoid m), msl (m, optional) }
    camera: null, // { lat, lon }
    shapeCenter: null, // { lat, lon }
    shape: {
      type: 'heart',
      width: 40,
      height: 40,
      depth: 20,
      samples: 40,
      centerAlt: 40,
      facing: 180,
      faceCamera: true,
      colorMode: 'rainbow',
      color: '#ff2040',
      color2: '#2040ff',
    },
    waypoints: [], // { lat, lon, alt (m above takeoff), color, sync }
    settings: {
      minClearance: 8,
      maxAgl: 121.9,
      maxRange: 500,
      speed: 4,
      holdSec: 4,
      auxLight: true, // Dronelink: aux light on at the first waypoint, off after the last
      arrivalCurve: 1, // Dronelink arrival radius (m) on smooth parts of a shape; corners stay tight
      altitudeMode: 'ellipsoid',
    },
  };
}

/** Fill any fields a saved or imported project is missing with current defaults. */
export function normalizeProject(saved) {
  const base = newProject();
  return {
    ...base,
    ...saved,
    shape: { ...base.shape, ...saved?.shape },
    settings: { ...base.settings, ...saved?.settings },
    waypoints: Array.isArray(saved?.waypoints) ? saved.waypoints : [],
  };
}
