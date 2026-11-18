import { cloudflare } from "@cloudflare/vite-plugin";

// Full Cloudflare stack (ARCHITECTURE-v2 §6): the Worker is built and
// run (vite dev → workerd/Miniflare) through @cloudflare/vite-plugin.
// Bindings (D1) come from wrangler.jsonc.
export default {
  plugins: [cloudflare()],
};
