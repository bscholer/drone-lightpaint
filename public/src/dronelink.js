import { toEnu } from './geo.js';

// Writes Dronelink's own plan format (.dronelink): a PlanComponent whose
// children are DestinationComponents, JSON-compressed with LZ-UTF8 and packed
// into 15-bit characters ("StorageBinaryString"). The layout was read off a
// plan exported from Dronelink, not from its (proprietary) SDK.
//
// Waypoints are placed by bearing + distance from the plan's takeoff
// coordinate, and altitude is above the takeoff point (`atl`), which is what
// this planner already calls "altitude".

const FT = 0.3048;
const RAD = Math.PI / 180;

export const DEFAULTS = {
  holdSec: 0, // time to dwell at each waypoint
  arrivalDistance: FT, // counts as "arrived" within this horizontal distance (m)
  arrivalAltitude: FT, // ...and this vertical distance (m)
  headingDeg: 0, // fixed drone heading, 0 = north
  gimbalPitchDeg: 0, // 0 = level with the horizon
};

const limits = (max, min) => ({ type: 'Limits', max, min });
const motion = (vMax, vMin, aMax, aMin) => ({
  type: 'MotionLimits',
  velocity: limits(vMax, vMin),
  acceleration: limits(aMax, aMin),
});

export function buildDronelinkPlan(project, options = {}) {
  const { home, waypoints, name } = project;
  if (!home) throw new Error('Set a home/takeoff point first.');
  if (!waypoints.length) throw new Error('The route has no waypoints.');
  const o = { ...DEFAULTS, uuid: () => crypto.randomUUID(), speed: project.settings?.speed ?? 8.9408, ...options };
  const coordinate = { type: 'GeoCoordinate', latitude: home.lat, longitude: home.lon };

  const component = (label, fields) => ({
    id: o.uuid(),
    coordinate: { type: 'GeoCoordinate', latitude: 0, longitude: 0 },
    descriptors: label ? { type: 'Descriptors', name: label } : { type: 'Descriptors' },
    resetReengagementCommands: false,
    dynamicHomeLocation: false,
    required: true,
    requiredFailureMode: 'disengage',
    exclusive: false,
    reference: { id: o.uuid(), type: 'SourcedGeoSpatial', source: 'plan' },
    ...fields,
  });

  // Smooth parts of a shape get a wider arrival radius so the drone can flow into
  // the next waypoint instead of braking to a stop; corners and hand-placed points stay tight.
  const curve = project.settings?.arrivalCurve ?? o.arrivalDistance;
  const children = waypoints.map((w, i) => {
    const { e, n } = toEnu(home, w);
    const radius = w.corner === false ? Math.max(curve, o.arrivalDistance) : o.arrivalDistance;
    return component(`WP${i + 1}`, {
      droneMotionLimits: { type: 'MotionLimits6Optional' },
      droneMotionErrorModelDelayAllowed: false,
      restrictionZonesEnabled: true,
      type: 'DestinationComponent',
      // Radians clockwise from north, metres.
      destinationOffset: { type: 'Vector2', direction: Math.atan2(e, n), magnitude: Math.hypot(e, n) },
      destinationTakeoffCoordinate: false,
      altitudeRange: {
        type: 'AltitudeRange',
        altitude: { type: 'Altitude', system: 'atl', value: w.alt },
        range: limits(30.48, -30.48),
      },
      achievementTime: o.holdSec,
      achievementDistance: {
        type: 'DistanceTolerance',
        horizontal: radius,
        vertical: w.corner === false ? Math.max(curve, o.arrivalAltitude) : o.arrivalAltitude,
      },
      droneOrientation: { type: 'Orientation3Optional', xReference: 'horizon', z: o.headingDeg * RAD, zReference: 'north' },
      gimbalOrientations: {
        0: { type: 'Orientation3Optional', x: o.gimbalPitchDeg * RAD, xReference: 'horizon', zReference: 'north' },
      },
    });
  });

  return {
    id: o.uuid(),
    coordinate,
    descriptors: { type: 'Descriptors', name: name || 'Light painting' },
    resetReengagementCommands: false,
    dynamicHomeLocation: false,
    elevations: Number.isFinite(home.msl)
      ? [{ type: 'GeoLocation', altitude: { type: 'Altitude', system: 'msl', value: home.msl }, coordinate }]
      : [],
    type: 'PlanComponent',
    takeoffDistance: { type: 'DistanceTolerance', horizontal: 9.144, vertical: 0 },
    droneMotionLimits: {
      type: 'MotionLimits6',
      position: {
        type: 'MotionLimits3',
        x: motion(o.speed, 0, 1.8288, -0.6096),
        y: motion(0, 0, 0, 0),
        z: motion(4, -4, 1.8288, -0.9144),
      },
      orientation: {
        type: 'MotionLimits3',
        x: motion(0, 0, 0, 0),
        y: motion(0, 0, 0, 0),
        z: motion(0.349066, -0.349066, 0.174533, -0.174533),
      },
    },
    droneMotionErrorTolerance: { type: 'DistanceTolerance', horizontal: 22.86, vertical: 7.62 },
    rootComponent: component('', { type: 'ListComponent', childComponents: children }),
    altitudeContinuity: false,
    executingMetadataUpdatesEnabled: true,
    reengagementRules: { type: 'PlanReengagementRules' },
    completeAction: 'returnHome',
  };
}

/** `LZ` is the LZUTF8 library (global in the browser, injected in tests). */
export function encodeDronelink(plan, LZ) {
  return LZ.compress(JSON.stringify(plan), { outputEncoding: 'StorageBinaryString' });
}

export function decodeDronelink(text, LZ) {
  return JSON.parse(LZ.decompress(text, { inputEncoding: 'StorageBinaryString', outputEncoding: 'String' }));
}
