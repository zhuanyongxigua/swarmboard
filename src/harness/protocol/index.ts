// Let trusted external hosts load the same protocol as native workers from the package.
// This is a side-effect-free generic entry; no vendor adapter is imported by the core.
export { workerProtocol } from '../../worker-prompt.js';
