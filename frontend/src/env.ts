// True in the packaged Electron app (the preload bridge is present), false in
// a plain browser tab.
//
// Grove in Electron is always the desktop experience — resizing the window
// never triggers the mobile layout. The responsive/mobile tier is web-only.
// This also gates Electron-only window chrome (traffic-light spacer, title-bar
// drag region), which is dead weight in a browser.
export const IS_ELECTRON = typeof window !== 'undefined' && !!window.grove;
