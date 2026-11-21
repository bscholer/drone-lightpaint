import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildDronelinkPlan, encodeDronelink, decodeDronelink } from '../public/src/dronelink.js';
import { buildShapeWaypoints } from '../public/src/shapes.js';
import { toEnu, offsetLatLon } from '../public/src/geo.js';
import { newProject } from '../public/src/project.js';

const LZ = createRequire(import.meta.url)('../public/vendor/lzutf8.min.js');

function project() {
  const p = newProject();
  p.home = { lat: 44.0154, lon: -121.3462, h0: 1200, msl: 1175 };
  p.settings.auxLight = false; // aux light tests opt in
  const center = offsetLatLon(p.home, 0, -70);
  p.waypoints = buildShapeWaypoints({ ...p.shape, facing: 180, centerAlt: 30 }, center);
  return p;
}

test('plan layout: one destination per waypoint, atl altitude, zero hold', () => {
  const p = project();
  let n = 0;
  const plan = buildDronelinkPlan(p, { uuid: () => `u${n++}` });
  assert.equal(plan.type, 'PlanComponent');
  assert.equal(plan.coordinate.latitude, p.home.lat);
  assert.equal(plan.elevations[0].altitude.value, 1175);
  const kids = plan.rootComponent.childComponents;
  assert.equal(kids.length, p.waypoints.length);
  kids.forEach((k, i) => {
    assert.equal(k.type, 'DestinationComponent');
    assert.equal(k.descriptors.name, `WP${i + 1}`);
    assert.equal(k.altitudeRange.altitude.system, 'atl');
    assert.ok(Math.abs(k.altitudeRange.altitude.value - p.waypoints[i].alt) < 1e-9);
    assert.equal(k.achievementTime, 0);
  });
  assert.equal(new Set([plan.id, plan.rootComponent.id, ...kids.map((k) => k.id)]).size, kids.length + 2);
});

test('offsets are radians clockwise from north and land back on the waypoints', () => {
  const p = project();
  const plan = buildDronelinkPlan(p);
  plan.rootComponent.childComponents.forEach((k, i) => {
    const { direction: d, magnitude: m } = k.destinationOffset;
    const back = offsetLatLon(p.home, m * Math.sin(d), m * Math.cos(d));
    const { e, n } = toEnu(back, p.waypoints[i]);
    assert.ok(Math.hypot(e, n) < 1e-6);
  });
  // the shape hangs 70 m south of home: bearing near 180 degrees
  const mid = plan.rootComponent.childComponents[0].destinationOffset;
  assert.ok(Math.abs(Math.abs(mid.direction) - Math.PI) < 0.3);
});

test('encode / decode round trip through LZ-UTF8 storage strings', () => {
  const plan = buildDronelinkPlan(project());
  const text = encodeDronelink(plan, LZ);
  // 15-bit payload plus a padding marker just above 0x8000 at the very end
  assert.ok(![...text.slice(0, -2)].some((c) => c.codePointAt(0) >= 0x8000), 'only 15-bit characters');
  assert.deepEqual(decodeDronelink(text, LZ), JSON.parse(JSON.stringify(plan)));
});

test('wider arrival radius on curves, tight on corners and manual points', () => {
  const p = project();
  p.settings.arrivalCurve = 1.5;
  const kids = buildDronelinkPlan(p).rootComponent.childComponents;
  assert.equal(kids[0].achievementDistance.horizontal, 0.3048); // heart tip
  assert.equal(kids[5].achievementDistance.horizontal, 1.5);
  assert.equal(kids[5].achievementDistance.vertical, 1.5);
  p.waypoints[5] = { ...p.waypoints[5], corner: undefined }; // hand-placed
  assert.equal(buildDronelinkPlan(p).rootComponent.childComponents[5].achievementDistance.horizontal, 0.3048);
});

test('photo capture on waypoints flagged sync, none on the rest', () => {
  const p = project();
  p.waypoints.forEach((w, i) => (w.sync = i % 2 === 0));
  const kids = buildDronelinkPlan(p).rootComponent.childComponents;
  assert.deepEqual(kids[0].cameraCaptureConfigurations, [{ type: 'CameraCaptureConfiguration', channel: 0, captureType: 'photos' }]);
  assert.equal(kids[1].cameraCaptureConfigurations, undefined);
  const none = buildDronelinkPlan(p, { photos: false }).rootComponent.childComponents;
  assert.ok(none.every((k) => k.cameraCaptureConfigurations === undefined));
});

test('aux light: on at the first waypoint, off via a closing waypoint on the last spot', () => {
  const p = project();
  p.settings.auxLight = true;
  const kids = buildDronelinkPlan(p).rootComponent.childComponents;
  assert.equal(kids.length, p.waypoints.length + 1);
  const on = kids[0].immediateComponent;
  assert.equal(on.type, 'CommandComponent');
  assert.deepEqual(
    { ...on.command, id: undefined },
    { id: undefined, reengagementEnabled: true, type: 'AuxiliaryLightModeDroneCommand', auxiliaryLightPosition: 'bottom', auxiliaryLightMode: 'on' },
  );
  assert.equal(kids[1].immediateComponent, undefined);
  const closing = kids.at(-1);
  assert.equal(closing.immediateComponent.command.auxiliaryLightMode, 'off');
  assert.equal(closing.cameraCaptureConfigurations, undefined, 'no photo on the closing waypoint');
  assert.deepEqual(closing.destinationOffset, kids.at(-2).destinationOffset);
  assert.equal(closing.altitudeRange.altitude.value, kids.at(-2).altitudeRange.altitude.value);
  assert.notEqual(closing.id, kids.at(-2).id);
  assert.notEqual(closing.reference.id, kids.at(-2).reference.id);
  assert.equal(closing.descriptors.name, `WP${kids.length}`);
});

test('aux light is left alone when the setting is off', () => {
  const p = project();
  const kids = buildDronelinkPlan(p).rootComponent.childComponents;
  assert.equal(kids.length, p.waypoints.length);
  assert.ok(kids.every((k) => k.immediateComponent === undefined));
});

test('speed setting limits horizontal velocity; omits elevations without MSL', () => {
  const p = project();
  p.settings.speed = 3;
  p.home.msl = undefined;
  const plan = buildDronelinkPlan(p);
  assert.equal(plan.droneMotionLimits.position.x.velocity.max, 3);
  assert.deepEqual(plan.elevations, []);
});

test('needs a home point and waypoints', () => {
  const p = newProject();
  assert.throws(() => buildDronelinkPlan(p), /home/i);
  p.home = { lat: 1, lon: 2, h0: 0 };
  assert.throws(() => buildDronelinkPlan(p), /waypoints/i);
});
