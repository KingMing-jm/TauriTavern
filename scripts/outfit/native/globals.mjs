export { Buffer } from 'buffer';
// The virtual filesystem has POSIX rename semantics on both Android and macOS.
export const process = Object.freeze({ platform: 'linux', pid: 1, env: Object.freeze({}) });
