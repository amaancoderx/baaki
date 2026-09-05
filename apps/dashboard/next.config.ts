import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // @baaki/core is TypeScript source consumed directly, so Next compiles it.
  transpilePackages: ["@baaki/core"],

  // The repo is pnpm workspaces inside a parent that also has a lockfile;
  // without this Next picks the wrong root and traces the wrong files.
  outputFileTracingRoot: join(here, "..", ".."),

  webpack: (cfg) => {
    // ESM TypeScript imports sibling modules as "./money.js" while the file on
    // disk is money.ts. Node resolves that; webpack does not unless told.
    cfg.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return cfg;
  },
};

export default config;
