// World dimensions
export const CHUNK_SIZE = 16; // blocks per chunk in x/z
export const WORLD_HEIGHT = 72; // blocks per chunk in y (one chunk column spans full height)
export const SEA_LEVEL = 28;

// Streaming
export const DEFAULT_VIEW_DISTANCE = 6; // chunks
export const MIN_VIEW_DISTANCE = 2;
export const MAX_VIEW_DISTANCE = 12;
export const UNLOAD_PADDING = 2; // chunks beyond view distance before unload
export const MAX_CHUNK_GENS_PER_FRAME = 4;
export const MESH_BUDGET_MS = 7; // per-frame time budget for remeshing
// Touch devices get smaller per-frame streaming budgets: spreading the same
// work over more frames trades load-in speed for fewer visible hitches.
export const TOUCH_MAX_CHUNK_GENS_PER_FRAME = 2;
export const TOUCH_MESH_BUDGET_MS = 5;

// Player
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;
export const WALK_SPEED = 4.3; // blocks per second
export const SNEAK_SPEED = 1.6;
/** Sprinting is 1.3x walking, as in Minecraft: quicker, not a different game. */
export const SPRINT_SPEED = 5.6;
/** Too hungry to sprint below this, so the food cost has teeth. */
export const SPRINT_MIN_HUNGER = 6;
/** Degrees of extra field of view while sprinting — the sense of speed. */
export const SPRINT_FOV_BOOST = 6;
/** How fast the view widens and narrows again, in FOV units per second. */
export const SPRINT_FOV_RATE = 28;
/** Two taps of forward within this long latch a sprint, as in Minecraft. */
export const SPRINT_DOUBLE_TAP_MS = 260;
/** A touch stick pushed at least this far past centre means sprint. */
export const SPRINT_STICK_THRESHOLD = 0.85;
export const JUMP_SPEED = 8.2;
export const GRAVITY = 24;
export const WATER_GRAVITY = 6;
export const TERMINAL_VELOCITY = 50;
export const WATER_TERMINAL_VELOCITY = 4;
export const SWIM_UP_SPEED = 4.2;
export const WATER_SPEED_FACTOR = 0.6;

// Interaction
export const REACH_DISTANCE = 5; // blocks
export const PLACE_REPEAT_MS = 240;
export const ITEM_PICKUP_RADIUS = 1.6;
export const ITEM_PICKUP_DELAY_S = 0.5; // before a fresh drop can be collected
export const ITEM_DESPAWN_S = 300;

// Survival
export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
// Hunger is mostly driven by what you do, not by the clock. Standing still
// takes well over an hour to empty the bar; a busy session of running, jumping,
// mining and fighting drains it several times faster. Every source is its own
// constant so the balance can be tuned without touching the survival code.
export const HUNGER_IDLE_DRAIN_PER_S = 0.0035; // ~95 min from full to empty
export const HUNGER_WALK_COST_PER_BLOCK = 0.0025; // on top of idle while moving
export const HUNGER_SWIM_COST_PER_BLOCK = 0.006;
/**
 * Sprinting costs three times walking per block, and covers 1.3x the ground,
 * so it drains roughly four times as fast — about seven minutes of solid
 * sprinting on a full bar against twenty-four minutes of walking. Enough to
 * make you think about food, not enough to make running a chore.
 */
export const HUNGER_SPRINT_COST_PER_BLOCK = 0.0075;
export const HUNGER_JUMP_COST = 0.04;
export const HUNGER_ATTACK_COST = 0.03;
export const HUNGER_MINE_COST = 0.01; // per block broken
export const REGEN_HUNGER_THRESHOLD = 18; // heal only when this well fed
export const REGEN_INTERVAL_S = 3.5;
export const REGEN_HUNGER_COST = 0.4;
export const STARVE_INTERVAL_S = 4;
export const FALL_DAMAGE_THRESHOLD = 3.5; // blocks of free fall before damage
export const HURT_INVULN_S = 0.5;
export const RESPAWN_SEARCH_RADIUS = 6;

// Breath. Minecraft gives 300 ticks of air shown as ten bubbles, then one heart
// a second until you surface or die; these are the same numbers in seconds.
export const MAX_AIR = 15;
export const AIR_BUBBLES = 10;
/** Surfacing refills far faster than diving drains — a gulp, not a recharge. */
export const AIR_REFILL_PER_S = 4;
export const DROWN_DAMAGE = 2;
export const DROWN_INTERVAL_S = 1;

// Combat
export const PLAYER_ATTACK_RANGE = 3.5;
export const FIST_DAMAGE = 1;
export const FIST_COOLDOWN_S = 0.35;
/**
 * Knockback. Every way of dealing damage names its own strength (see the
 * `attack` stats in items/items.ts and `knockback` in shared/mobs.ts); these
 * turn that number into movement.
 *
 * A shove decays exponentially, so the distance travelled is very close to
 * `strength / KNOCKBACK_DRAG` blocks: a bare fist moves something half a
 * block, a diamond axe — the heaviest hit in the game — just over one. That
 * is deliberately short. Knockback should interrupt and separate, not launch.
 */
export const KNOCKBACK_DRAG = 6;
/** A shove overrides a mob's own movement for this long, then it recovers. */
export const KNOCKBACK_TIME_S = 0.5;
/** Every hit pops the target up a little; heavier hits, slightly more. */
export const KNOCKBACK_LIFT_BASE = 2.6;
export const KNOCKBACK_LIFT_PER_STRENGTH = 0.12;
/** Nothing is ever shoved harder than this, whatever asks for it. */
export const MAX_KNOCKBACK = 8;
/** Bare hands. Every weapon is measured against this. */
export const FIST_KNOCKBACK = 3.2;
/** An arrow's shove, wherever it came from. */
export const ARROW_KNOCKBACK = 4;
/** Fraction of damage a raised shield absorbs. */
export const BLOCK_DAMAGE_REDUCTION = 0.66;
/** Movement multiplier while blocking. */
export const BLOCK_SLOWDOWN = 0.45;

// Ranged combat
export const ARROW_SPEED = 42; // blocks/second at full draw
export const ARROW_GRAVITY = 18;
export const ARROW_LIFETIME_S = 12;
export const ARROW_MIN_CHARGE = 0.18; // below this the shot is cancelled

// Mobs
export const MAX_MOBS = 28;
export const MOB_SPAWN_INTERVAL_S = 3;
export const MOB_SPAWN_MIN_DISTANCE = 14;
export const MOB_SPAWN_MAX_DISTANCE = 40;
export const MOB_DESPAWN_DISTANCE = 72;
export const ZOMBIE_DETECT_RANGE = 18;
export const NIGHT_START = 0.76; // time-of-day window where hostiles spawn
export const NIGHT_END = 0.22;
/**
 * Spawning is decided by light, not by the clock. Anything this dark or
 * darker is fair game for hostiles — the open ground at night, and the inside
 * of an unlit cave at any hour. Put a torch down and the spot goes above the
 * threshold, which is what makes torches a defence rather than decoration.
 */
export const HOSTILE_MAX_SPAWN_LIGHT = 7;
/** How far below a player the spawner goes looking for a dark cave floor. */
export const CAVE_SPAWN_DEPTH = 26;
/** ...and how far above it, for the cave you are standing on top of. */
export const CAVE_SPAWN_RISE = 6;

// Farming
/** Average seconds between growth stages of a planted crop. */
export const CROP_GROWTH_MEAN_S = 75;
/** Seconds for a sheared sheep to grow its wool back. */
export const WOOL_REGROW_S = 240;

// Furnace
/** Seconds to smelt one item, matching vanilla's 200 ticks. */
export const SMELT_TIME_S = 10;

// Sleeping
/** Time of day beds may be used: dusk through to just before dawn. */
export const SLEEP_START = 0.72;
export const SLEEP_END = 0.24;
/** Where the clock lands after a night is skipped (early morning). */
export const SLEEP_WAKE_TIME = 0.25;
/** Seconds everyone must stay in bed before the night is skipped. */
export const SLEEP_DURATION_S = 3;

// Villages
/** One in this many chunks anchors a village (checked per chunk, from the seed). */
export const VILLAGE_CHUNK_SPACING = 9;

// Day/night

// Touch controls
export const TOUCH_LOOK_SENSITIVITY = 0.0042; // radians per pixel dragged
export const TOUCH_TAP_MAX_MS = 260; // release faster than this = tap (break)
export const TOUCH_LONG_PRESS_MS = 220; // hold longer than this = start mining
export const TOUCH_TAP_CANCEL_PX = 14; // finger travel beyond this = look drag
export const TOUCH_DEFAULT_VIEW_DISTANCE = 4;

export const DAY_LENGTH_SECONDS = 600; // one full cycle
export const START_TIME_OF_DAY = 0.35; // 0=midnight 0.25=sunrise 0.5=noon 0.75=sunset

// Persistence
export const SAVE_INTERVAL_MS = 5000;

// Physics integration
export const MAX_TIMESTEP = 0.05; // clamp dt (seconds)
export const MAX_MOVE_PER_SUBSTEP = 0.4; // blocks, prevents tunneling
