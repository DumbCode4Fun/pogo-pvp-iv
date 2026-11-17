/**
 * Which Firebase project keeps the rosters in the cloud (see cloud.js). Null: no cloud, and no Sign-in
 * button; rosters stay on the local server or in the browser, as before.
 *
 * To turn it on, paste the web app config from the Firebase console (Project settings -> Your apps) here
 * and name the group the members share. These values are not secrets: Firebase web configs are public by
 * design, and the database rules (firebase/firestore.rules) decide who can read or write anything.
 *
 *   globalThis.POGO_CLOUD = {
 *     apiKey: '...',
 *     authDomain: '<project>.firebaseapp.com',
 *     projectId: '<project>',
 *     appId: '...',
 *     group: 'main',
 *   };
 */
globalThis.POGO_CLOUD = {
  apiKey: 'AIzaSyD1DmHO_oZ740onM0GoR87BMFJwHVKslnk',
  authDomain: 'pogo-tools-box.firebaseapp.com',
  projectId: 'pogo-tools-box',
  appId: '1:798173198083:web:3554adb86ec0919b42db36',
  group: 'main',
};
