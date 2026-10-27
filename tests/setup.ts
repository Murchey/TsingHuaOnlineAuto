import { beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
const storageWindow = new JSDOM('', { url: 'https://www.tsinghuaelt.com/' });

// Node 26 exposes its own localStorage getter. These browser tests must use the DOM window's Storage.
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: storageWindow.window.localStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: storageWindow.window.sessionStorage, configurable: true, writable: true });
  storageWindow.window.localStorage.clear();
  storageWindow.window.sessionStorage.clear();
});
