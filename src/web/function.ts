import { deployedListener } from "./deployed";

/**
 * The deployed server's one function. The host calls its default export with a Node request
 * and response for every path under /api. Everything it does is in ./deployed.ts.
 */
export default deployedListener();
