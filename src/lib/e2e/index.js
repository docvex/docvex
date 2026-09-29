// End-to-end encryption — keys only on members' devices. See the file heads:
//   primitives.js   WebCrypto: AES-256-GCM, X25519+HKDF sealed boxes, Ed25519, PBKDF2
//   envelope.js     the stored formats (text columns, JSON documents, file parts)
//   identityCore.js / identity.js   the user's identity keys + recovery backup
//   projectKeys.js  a project's key ring (grants, legacy adoption, rotation)
//   dmKeys.js       direct-message conversation keys
export * from './envelope';
export {
  ensureIdentity, getIdentity, identityState, subscribeIdentity, forgetIdentity,
  hasRecoveryBackup, saveRecoveryBackup, restoreIdentity, resetIdentity, publicKeysOf,
} from './identity';
export {
  getProjectKeyRing, rotateProjectKey, grantMissing, forgetProjectKeys, subscribeProjectKeys,
  encryptProjectText, decryptProjectText, ringToIndexKeys, UNREADABLE_TEXT,
} from './projectKeys';
export { encryptDmText, decryptDmText, forgetDmKeys } from './dmKeys';
export { fingerprint } from './primitives';
