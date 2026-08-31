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
export const BREAK_REPEAT_MS = 240; // hold-to-break repeat interval
export const PLACE_REPEAT_MS = 240;

// Day/night
export const DAY_LENGTH_SECONDS = 600; // one full cycle
export const START_TIME_OF_DAY = 0.35; // 0=midnight 0.25=sunrise 0.5=noon 0.75=sunset

// Persistence
export const SAVE_INTERVAL_MS = 5000;

// Physics integration
export const MAX_TIMESTEP = 0.05; // clamp dt (seconds)
export const MAX_MOVE_PER_SUBSTEP = 0.4; // blocks, prevents tunneling
