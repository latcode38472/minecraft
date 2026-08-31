// Pointer-lock mouse look. Yaw/pitch are tracked here and applied to the
// three.js camera with YXZ euler order so pitch never rolls the horizon.

import * as THREE from 'three';

const MOUSE_SENSITIVITY = 0.0023;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export class MouseLook {
  yaw = 0;
  pitch = 0;
  locked = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly lockTarget: HTMLElement,
  ) {
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.rotate(e.movementX, e.movementY, MOUSE_SENSITIVITY);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.lockTarget;
    });
  }

  requestLock(): void {
    this.lockTarget.requestPointerLock();
  }

  /** Apply a look delta in screen pixels — used by both mouse and touch input. */
  rotate(dxPixels: number, dyPixels: number, sensitivity: number): void {
    this.yaw -= dxPixels * sensitivity;
    this.pitch -= dyPixels * sensitivity;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
  }

  /** Position the camera at the eye point with current yaw/pitch. */
  apply(eye: THREE.Vector3): void {
    this.camera.position.copy(eye);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  direction(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }
}
