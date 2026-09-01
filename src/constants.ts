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
export const HUNGER_DRAIN_PER_S = 0.02; // idle drain (~16 min to empty)
export const HUNGER_DRAIN_PER_BLOCK = 0.008; // extra while walking
export const REGEN_HUNGER_THRESHOLD = 18; // heal only when this well fed
export const REGEN_INTERVAL_S = 3.5;
export const REGEN_HUNGER_COST = 0.6;
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
export const KNOCKBACK_SPEED = 6;
export const KNOCKBACK_LIFT = 3.2;
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
export const MAX_MOBS = 24;
export const MOB_SPAWN_INTERVAL_S = 3;
export const MOB_SPAWN_MIN_DISTANCE = 14;
export const MOB_SPAWN_MAX_DISTANCE = 40;
export const MOB_DESPAWN_DISTANCE = 72;
export const ZOMBIE_DETECT_RANGE = 18;
export const NIGHT_START = 0.76; // time-of-day window where hostiles spawn
export const NIGHT_END = 0.22;

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
