// esbuild --inject shim: gives every bundled module a global-looking Buffer in the browser.
export { Buffer } from "buffer";
