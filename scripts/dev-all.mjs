// Convenience launcher: runs the multiplayer server and the Vite dev server
// together, and prints the LAN address to open on a phone.
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const children = [
  spawn('node', ['server/index.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite', '--host'], { stdio: 'inherit' }),
];

const ip = lanAddress();
setTimeout(() => {
  console.log('\n──────────────────────────────────────────────');
  console.log(`  Play on this machine:  http://localhost:5173`);
  console.log(`  Play from your phone:  http://${ip}:5173`);
  console.log(`  Multiplayer server:    ws://${ip}:8787`);
  console.log('──────────────────────────────────────────────\n');
}, 1500);

const shutdown = () => {
  for (const child of children) child.kill('SIGINT');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) child.on('exit', shutdown);
