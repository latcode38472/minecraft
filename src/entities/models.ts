// Blocky models built from coloured boxes.
//
// A model is described as *segments* — head, torso, each limb — and can be
// realised two ways from the same description:
//
//   articulated: one mesh per segment, each pivoting at its joint, so arms and
//                legs swing. Costs a few draw calls per body.
//   merged:      every segment flattened into ONE geometry. No animation, one
//                draw call. This is the fallback the quality ladder drops to
//                on devices that cannot spare the draw calls.
//
// Geometry is cached and shared, so ten identical zombies upload nothing new.

import * as THREE from 'three';

export interface BoxPart {
  /** Centre of the box, in blocks, relative to the entity's feet. */
  pos: [number, number, number];
  size: [number, number, number];
  color: number;
}

const FACE_DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Per-face shading matching the terrain mesher, so mobs sit in the same light.
const FACE_SHADE = [0.8, 0.8, 1.0, 0.55, 0.7, 0.7];

/** Merge boxes into one indexed BufferGeometry with baked vertex colours. */
export function buildBoxGeometry(parts: BoxPart[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  for (const part of parts) {
    const [cx, cy, cz] = part.pos;
    const [sx, sy, sz] = part.size;
    color.setHex(part.color);

    FACE_DIRS.forEach((dir, faceIndex) => {
      const base = positions.length / 3;
      // Build a quad perpendicular to `dir` by spanning the other two axes.
      const axis = dir[0] !== 0 ? 0 : dir[1] !== 0 ? 1 : 2;
      const uAxis = axis === 0 ? 1 : 0;
      const vAxis = axis === 2 ? 1 : 2;
      const half = [sx / 2, sy / 2, sz / 2];
      const centre = [cx, cy, cz];

      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = [centre[0], centre[1], centre[2]];
        p[axis] += dir[axis] * half[axis];
        p[uAxis] += su * half[uAxis];
        p[vAxis] += sv * half[vAxis];
        positions.push(p[0], p[1], p[2]);
        normals.push(dir[0], dir[1], dir[2]);
        const shade = FACE_SHADE[faceIndex];
        colors.push(color.r * shade, color.g * shade, color.b * shade);
      }

      // Wind each quad so its front face points along `dir`.
      const flip = dir[axis] > 0 === (axis === 1);
      if (flip) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

let mobMaterial: THREE.MeshLambertMaterial | null = null;
let mobHurtMaterial: THREE.MeshLambertMaterial | null = null;

export function getMobMaterial(): THREE.MeshLambertMaterial {
  if (!mobMaterial) {
    mobMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  return mobMaterial;
}

/** Shared red-tinted variant swapped in during a mob's hurt flash. */
export function getMobHurtMaterial(): THREE.MeshLambertMaterial {
  if (!mobHurtMaterial) {
    mobHurtMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissive: 0xaa2222,
      emissiveIntensity: 0.9,
    });
  }
  return mobHurtMaterial;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();

/** Build-once, share-forever geometry for a named model. */
export function cachedGeometry(key: string, build: () => BoxPart[]): THREE.BufferGeometry {
  let geo = geometryCache.get(key);
  if (!geo) {
    geo = buildBoxGeometry(build());
    geometryCache.set(key, geo);
  }
  return geo;
}

// --- Rigs -------------------------------------------------------------------

/** Joint names an animator may drive. Unknown names simply stay still. */
export type SegmentName =
  | 'head'
  | 'torso'
  | 'body'
  | 'armL'
  | 'armR'
  | 'arms'
  | 'legL'
  | 'legR'
  | 'legsA'
  | 'legsB';

/** Idle and activity behaviours layered on top of the gait. */
export interface PoseExtras {
  /** Head turned relative to the body, radians. */
  headYaw?: number;
  /** 0..1: head lowered to the grass. */
  graze?: number;
  /** 0..1: right arm held out, using or eating something. */
  using?: number;
}

/** How far a grazing head drops, radians. */
const GRAZE_ANGLE = 0.95;
/** How far the arm comes up when using an item, radians. */
const USE_ARM_RAISE = 1.15;

export interface RigSegment {
  name: SegmentName;
  /**
   * The joint this segment rotates about, in entity space with feet at y=0.
   * A shoulder for an arm, a hip for a leg, the neck for a head.
   */
  pivot: [number, number, number];
  /** Boxes making up the segment, positioned RELATIVE to `pivot`. */
  parts: BoxPart[];
}

/**
 * A built model: a group to place in the world, plus the segment meshes an
 * animator can rotate. `segments` is empty for a merged (unarticulated) rig,
 * which is exactly what makes animation code a no-op there instead of a crash.
 */
export class Rig {
  readonly group: THREE.Group;
  readonly segments = new Map<SegmentName, THREE.Mesh>();
  readonly articulated: boolean;

  /** Builds into `group` when given, so a body can be rebuilt in place. */
  constructor(key: string, def: () => RigSegment[], articulated: boolean, group = new THREE.Group()) {
    this.group = group;
    this.articulated = articulated;
    const material = getMobMaterial();

    if (!articulated) {
      const mesh = new THREE.Mesh(cachedGeometry(`${key}|merged`, () => flatten(def())), material);
      this.group.add(mesh);
      return;
    }

    for (const segment of def()) {
      const mesh = new THREE.Mesh(
        cachedGeometry(`${key}|${segment.name}`, () => segment.parts),
        material,
      );
      mesh.position.set(segment.pivot[0], segment.pivot[1], segment.pivot[2]);
      this.segments.set(segment.name, mesh);
      this.group.add(mesh);
    }
  }

  /** Swap every segment's material — used for the red hurt flash. */
  setMaterial(material: THREE.Material): void {
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) child.material = material;
    });
  }

  private rotate(name: SegmentName, x: number, z = 0): void {
    const mesh = this.segments.get(name);
    if (!mesh) return;
    mesh.rotation.x = x;
    mesh.rotation.z = z;
  }

  /** Turn the head to look somewhere, and lower it to graze. */
  private poseHead(pitch: number, extras?: PoseExtras): void {
    const head = this.segments.get('head');
    if (!head) return;
    head.rotation.x = Math.max(-0.6, Math.min(0.6, pitch)) + (extras?.graze ?? 0) * GRAZE_ANGLE;
    head.rotation.y = extras?.headYaw ?? 0;
    head.rotation.z = 0;
  }

  /**
   * Pose the rig for one frame.
   *
   * `walkPhase` advances with distance travelled, so the gait matches the
   * ground rather than the frame rate; `walkAmount` (0..1) fades the swing in
   * as a body gets going. `swing` (0..1) is an attack or mining stroke, and
   * `pitch` tilts the head where the model has a separate one. `extras`
   * carries the idle behaviours: looking around, grazing, using an item.
   */
  pose(walkPhase: number, walkAmount: number, swing: number, pitch = 0, aim = 0, extras?: PoseExtras): void {
    if (!this.articulated) return;

    // Aiming overrides the arms entirely: they come up level and hold there
    // while the draw builds, which is the whole tell that a shot is coming.
    if (aim > 0) {
      const raise = Math.min(1, aim * 2.2); // arms up fast, then steady
      const arms = this.segments.get('arms');
      if (arms) {
        arms.rotation.x = -Math.PI / 2 * raise;
        // A slight settle as the draw completes, so it does not look frozen.
        arms.rotation.z = Math.sin(aim * Math.PI) * 0.05;
      }
      const stride = Math.sin(walkPhase) * 0.5 * walkAmount;
      this.rotate('legL', stride);
      this.rotate('legR', -stride);
      this.poseHead(pitch, extras);
      return;
    }

    const stride = Math.sin(walkPhase) * 0.85 * walkAmount;
    const counter = Math.sin(walkPhase + Math.PI) * 0.85 * walkAmount;

    this.rotate('legL', stride);
    this.rotate('legR', counter);
    this.rotate('legsA', stride);
    this.rotate('legsB', counter);

    // Arms counter-swing against the legs, as a walking body actually does.
    const armSwing = stride * 0.6;
    this.rotate('armL', -armSwing);

    // The right arm is the one that swings a tool, so an attack overrides it.
    // sin(pi*t) arcs up and back down over the stroke; the lean adds follow-through.
    const strokeLift = swing > 0 ? -Math.sin(Math.PI * swing) * 2.2 : 0;
    const strokeLean = swing > 0 ? Math.sin(Math.PI * swing) * 0.35 : 0;
    // Using something (eating, placing, a raised shield) holds the arm out
    // in front instead; a stroke still wins when both apply.
    const using = strokeLift === 0 ? (extras?.using ?? 0) : 0;
    this.rotate('armR', armSwing * (1 - using) + strokeLift - using * USE_ARM_RAISE, -strokeLean);

    // Zombies hold both arms out together, so they swing as one unit.
    this.rotate('arms', strokeLift !== 0 ? strokeLift * 0.5 : Math.sin(walkPhase) * 0.12 * walkAmount);

    this.poseHead(pitch, extras);

    const torso = this.segments.get('torso') ?? this.segments.get('body');
    if (torso) torso.rotation.x = strokeLean * 0.4;
  }

  dispose(): void {
    // Geometry and material are shared and cached, so nothing to free here.
    this.group.clear();
  }
}

/** Collapse segments back into absolute-positioned parts for a merged rig. */
function flatten(segments: RigSegment[]): BoxPart[] {
  const parts: BoxPart[] = [];
  for (const segment of segments) {
    for (const part of segment.parts) {
      parts.push({
        pos: [
          part.pos[0] + segment.pivot[0],
          part.pos[1] + segment.pivot[1],
          part.pos[2] + segment.pivot[2],
        ],
        size: part.size,
        color: part.color,
      });
    }
  }
  return parts;
}

/**
 * How far a body's gait advances for a given distance travelled. Tuned so a
 * player at walking speed takes roughly two steps per block, matching the
 * footstep sound interval.
 */
export const WALK_PHASE_PER_BLOCK = Math.PI * 2 * 0.62;

// Models face +Z; mobs set rotation.y = atan2(dirX, dirZ) to look along travel.
//
// Limb parts hang BELOW their pivot (a leg's box centre sits half its length
// under the hip), which is what makes a rotation about that pivot read as a
// step rather than a body part spinning in place.

export const ZOMBIE_SEGMENTS = (): RigSegment[] => {
  const skin = 0x63a05a;
  const shirt = 0x35696b;
  const pants = 0x33396b;
  return [
    {
      name: 'body',
      pivot: [0, 0, 0],
      parts: [
        { pos: [0, 1.72, 0], size: [0.5, 0.5, 0.5], color: skin }, // head
        { pos: [0, 1.05, 0], size: [0.55, 0.75, 0.3], color: shirt }, // torso
      ],
    },
    {
      // Both arms held out in front, swinging as one — the zombie shuffle.
      name: 'arms',
      pivot: [0, 1.42, 0],
      parts: [
        { pos: [-0.4, -0.27, 0.15], size: [0.25, 0.6, 0.25], color: skin },
        { pos: [0.4, -0.27, 0.15], size: [0.25, 0.6, 0.25], color: skin },
      ],
    },
    {
      name: 'legL',
      pivot: [-0.15, 0.65, 0],
      parts: [{ pos: [0, -0.33, 0], size: [0.25, 0.65, 0.25], color: pants }],
    },
    {
      name: 'legR',
      pivot: [0.15, 0.65, 0],
      parts: [{ pos: [0, -0.33, 0], size: [0.25, 0.65, 0.25], color: pants }],
    },
  ];
};

export const SKELETON_SEGMENTS = (): RigSegment[] => {
  const bone = 0xd6d3c4;
  const dark = 0xa8a596;
  return [
    {
      name: 'body',
      pivot: [0, 0, 0],
      parts: [
        { pos: [0, 1.72, 0], size: [0.46, 0.46, 0.46], color: bone }, // skull
        { pos: [0, 1.5, 0.2], size: [0.24, 0.16, 0.06], color: dark }, // eye sockets
        { pos: [0, 1.08, 0], size: [0.34, 0.72, 0.22], color: bone }, // ribcage
      ],
    },
    {
      // Both arms move together: a skeleton holds its bow two-handed out front,
      // and `aim` in Rig.pose raises this whole assembly to fire.
      name: 'arms',
      pivot: [0, 1.42, 0],
      parts: [
        { pos: [-0.32, -0.3, 0.06], size: [0.18, 0.62, 0.18], color: bone },
        { pos: [0.32, -0.3, 0.06], size: [0.18, 0.62, 0.18], color: bone },
      ],
    },
    {
      name: 'legL',
      pivot: [-0.12, 0.62, 0],
      parts: [{ pos: [0, -0.31, 0], size: [0.18, 0.62, 0.18], color: bone }],
    },
    {
      name: 'legR',
      pivot: [0.12, 0.62, 0],
      parts: [{ pos: [0, -0.31, 0], size: [0.18, 0.62, 0.18], color: bone }],
    },
  ];
};

/**
 * The bow a skeleton carries. A separate rig so it can be parented to the arms
 * and swing with them, and so the string can be pulled back independently as
 * the draw builds.
 */
export const SKELETON_BOW_SEGMENTS = (): RigSegment[] => {
  const wood = 0x7a5433;
  const string = 0xe4e2d6;
  return [
    {
      name: 'body',
      pivot: [0, 0, 0],
      parts: [
        // Limbs, bent around a vertical axis so the bow faces forward.
        { pos: [0, 0.34, 0], size: [0.06, 0.22, 0.06], color: wood },
        { pos: [0, -0.34, 0], size: [0.06, 0.22, 0.06], color: wood },
        { pos: [0, 0.17, 0.07], size: [0.06, 0.18, 0.06], color: wood },
        { pos: [0, -0.17, 0.07], size: [0.06, 0.18, 0.06], color: wood },
        { pos: [0, 0, 0.1], size: [0.06, 0.2, 0.06], color: wood },
      ],
    },
    {
      // The nock: pulled back along -Z as the draw builds.
      name: 'arms',
      pivot: [0, 0, 0],
      parts: [{ pos: [0, 0, -0.02], size: [0.03, 0.86, 0.03], color: string }],
    },
  ];
};

/**
 * Four-legged bodies share one layout: a torso, a head on a neck pivot (so it
 * can look around and drop to graze), and two leg segments — a four-legged
 * gait moves diagonal pairs together, so two segments carry all four legs.
 */
function quadruped(
  torso: BoxPart[],
  neck: [number, number, number],
  head: BoxPart[],
  legHeight: number,
  legSize: number,
  legColor: number,
  legX: number,
  legZ: [number, number],
): RigSegment[] {
  const leg = (x: number, z: number): BoxPart => ({
    pos: [x, -legHeight / 2, z],
    size: [legSize, legHeight, legSize],
    color: legColor,
  });
  return [
    { name: 'body', pivot: [0, 0, 0], parts: torso },
    { name: 'head', pivot: neck, parts: head },
    {
      name: 'legsA',
      pivot: [0, legHeight, 0],
      parts: [leg(-legX, legZ[0]), leg(legX, legZ[1])],
    },
    {
      name: 'legsB',
      pivot: [0, legHeight, 0],
      parts: [leg(legX, legZ[0]), leg(-legX, legZ[1])],
    },
  ];
}

export const PIG_SEGMENTS = (): RigSegment[] => {
  const body = 0xe89a96;
  const snout = 0xd4746f;
  return quadruped(
    [{ pos: [0, 0.55, -0.05], size: [0.6, 0.55, 0.9], color: body }],
    [0, 0.62, 0.38],
    [
      { pos: [0, 0, 0.17], size: [0.45, 0.45, 0.35], color: body },
      { pos: [0, -0.06, 0.37], size: [0.22, 0.18, 0.1], color: snout },
    ],
    0.28,
    0.16,
    body,
    0.2,
    [0.3, -0.35],
  );
};

export const COW_SEGMENTS = (): RigSegment[] => {
  const hide = 0x4a3325;
  const patch = 0xe8e8e8;
  const muzzle = 0xc9a08c;
  const horn = 0xd9d3b9;
  return quadruped(
    [
      { pos: [0, 0.85, -0.05], size: [0.7, 0.6, 1.1], color: hide },
      { pos: [0, 0.95, -0.3], size: [0.72, 0.28, 0.4], color: patch },
      { pos: [0, 0.52, -0.25], size: [0.3, 0.16, 0.3], color: 0xe8b6b0 }, // udder
    ],
    [0, 1.0, 0.5],
    [
      { pos: [0, 0.02, 0.2], size: [0.42, 0.42, 0.4], color: hide },
      { pos: [0, -0.1, 0.42], size: [0.3, 0.2, 0.1], color: muzzle },
      { pos: [-0.2, 0.22, 0.05], size: [0.08, 0.16, 0.08], color: horn },
      { pos: [0.2, 0.22, 0.05], size: [0.08, 0.16, 0.08], color: horn },
    ],
    0.55,
    0.18,
    hide,
    0.22,
    [0.35, -0.4],
  );
};

/** A sheep in a given fleece colour; sheared, only the skin body remains. */
export const SHEEP_SEGMENTS = (wool: number, sheared: boolean): RigSegment[] => {
  const skin = 0xe5d6c7;
  const torso: BoxPart[] = [{ pos: [0, 0.75, -0.05], size: [0.55, 0.5, 0.9], color: skin }];
  const head: BoxPart[] = [{ pos: [0, 0, 0.18], size: [0.4, 0.4, 0.38], color: skin }];
  if (!sheared) {
    torso.push({ pos: [0, 0.8, -0.05], size: [0.8, 0.68, 1.02], color: wool });
    head.push({ pos: [0, 0.14, 0.1], size: [0.46, 0.3, 0.36], color: wool });
  }
  return quadruped(torso, [0, 0.95, 0.45], head, 0.5, 0.18, skin, 0.2, [0.3, -0.35]);
};

export const VILLAGER_SEGMENTS = (): RigSegment[] => {
  const skin = 0xc9a27e;
  const robe = 0x6b4f3a;
  const robeDark = 0x4c3728;
  return [
    {
      name: 'body',
      pivot: [0, 0, 0],
      parts: [
        { pos: [0, 1.0, 0], size: [0.55, 0.9, 0.32], color: robe }, // robe
        { pos: [0, 0.95, 0.2], size: [0.6, 0.2, 0.18], color: robe }, // folded arms
        { pos: [0, 0.98, 0.3], size: [0.16, 0.16, 0.06], color: skin }, // hands
      ],
    },
    {
      name: 'head',
      pivot: [0, 1.48, 0],
      parts: [
        { pos: [0, 0.25, 0], size: [0.5, 0.55, 0.5], color: skin },
        { pos: [0, 0.12, 0.3], size: [0.14, 0.22, 0.12], color: skin }, // the nose
        { pos: [0, 0.4, 0.26], size: [0.5, 0.08, 0.02], color: 0x5a4a3a }, // brow
      ],
    },
    {
      name: 'legL',
      pivot: [-0.14, 0.55, 0],
      parts: [{ pos: [0, -0.28, 0], size: [0.24, 0.55, 0.24], color: robeDark }],
    },
    {
      name: 'legR',
      pivot: [0.14, 0.55, 0],
      parts: [{ pos: [0, -0.28, 0], size: [0.24, 0.55, 0.24], color: robeDark }],
    },
  ];
};
